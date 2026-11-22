/**
 * 把 DSH 原生的 `approval/request` 接入企业微信。
 *
 * 为什么需要这一层：
 *   `tools/pre-execute` 只覆盖「工具调用」这条路径。但 DSH 里还有**别的**审批来源：
 *     - bash 工具申请沙箱升级（`sandbox_permissions`）
 *     - 其他插件主动调用 `ctx.approval.request(...)`
 *     - 未来的 hook / guard
 *   这些请求会走 `approval/request` waterfall。如果没人应答，
 *   DSH 会 fail-closed 为 `unavailable` —— 用户在企微里根本看不到。
 *
 * 我们的做法：
 *   1. 用 `{ prepend: true }` 抢先注册（排在浏览器 UI 之前）；
 *   2. 只在「这个会话最近确实来自企微」且「企微在线」时接管；
 *   3. 接管后推一张卡片，等用户点，最长等到 `signal` 中断或超时；
 *   4. 其余情况 `next()` 交还给 DSH 原生链路（浏览器 UI 仍然可用）。
 *
 * 这样既不会让本地使用变成「必须过企微」，也不会让企微用户漏掉审批。
 */
import { actionLabel, confirmationPhrase } from '../gate/rules.js'
import { appendNdjson, files } from '../core/state.js'
import { redactText } from '../core/redact.js'

/** 把 DSH 的工具名映射到我们的动作目录。 */
const TOOL_ACTION = {
  bash: 'tool.exec',
  pwsh: 'tool.exec',
  terminal: 'tool.exec',
  write_file: 'tool.exec',
  edit_file: 'tool.exec',
  str_replace_editor: 'tool.exec',
}

/** 卡片上的说明不能超过这个长度（企微 sub_title_text 上限 112 字）。 */
const MAX_REASON = 110

export class NativeApprovalBridge {
  /**
   * @param {object} params
   * @param {() => object} params.getConfig
   * @param {object} params.approval 审批引擎
   * @param {object} params.gate 审批闸（取会话来源）
   * @param {object} params.transport
   * @param {(payload: object) => Promise<void>} params.deliver
   * @param {(payload: object) => Promise<void>} params.update
   * @param {(level: string, msg: string, ...a: unknown[]) => void} [params.log]
   * @param {() => boolean} [params.isEnabled]
   */
  constructor({ getConfig, approval, gate, transport, deliver, update, log, isEnabled }) {
    this.getConfig = getConfig
    this.approval = approval
    this.gate = gate
    this.transport = transport
    this.deliver = deliver
    this.update = update
    this.log = log ?? (() => {})
    this.isEnabled = isEnabled ?? (() => true)
  }

  /**
   * 对应 `approval/request` 的 listener。
   * @param {object} request ApprovalRequestEvent
   * @param {() => Promise<string>} next
   * @returns {Promise<string>} 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
   */
  async handle(request, next) {
    try {
      if (!this.isEnabled()) return next()
      const config = this.getConfig()
      if (config.approval?.enabled === false) return next()
      if (!this.transport.isOnline) return next()

      const agent = request.agent
      const sessionId = agent?.session?.id ?? agent?.id
      if (typeof sessionId !== 'string') return next()
      const origin = this.gate.originOf(sessionId)
      // 只接管来自企微的会话；否则交还给浏览器 UI
      if (origin === null || typeof origin.chatId !== 'string') return next()

      const toolName = String(request.toolName ?? 'unknown')
      const action = TOOL_ACTION[toolName] ?? 'tool.exec'
      const reason = clipReason(request.reason)

      const approval = this.approval.create({
        action,
        risk: 'high',
        approvalPolicy: 'dual',
        detail: {
          tool: toolName,
          command: request.reason ?? '',
          summary: reason,
          source: 'dsh-native',
        },
        summary: reason || `${actionLabel(action)}（${toolName}）`,
        requestedBy: {
          userId: origin.senderId ?? 'local-user',
          name: origin.senderName ?? '',
          chatId: origin.chatId,
          chatType: origin.chatType ?? 'single',
        },
        approvers: [],
        sessionId,
        toolName,
      })
      audit({ type: 'native.approval.ask', approvalId: approval.id, tool: toolName, sessionId })

      try {
        await this.deliver({ approval, kind: 'approval' })
      } catch (error) {
        // 送不出去就交还给 DSH 原生链路（浏览器可能还能答）
        this.approval.cancel(approval.id, '无法送达企微')
        this.log('warn', '原生审批送达失败，交还 DSH：%s', String(error?.message ?? error))
        return next()
      }

      const result = await this.approval.waitFor(approval.id, request.signal)
      audit({ type: 'native.approval.settled', approvalId: approval.id, outcome: result.outcome })
      switch (result.outcome) {
        case 'approved': return 'allowed-once'
        case 'cancelled': return 'cancelled'
        case 'unavailable': return next()
        default: return 'rejected'
      }
    } catch (error) {
      this.log('warn', '处理原生审批失败：%s', String(error?.message ?? error))
      // 任何异常都交还给 DSH，让它按自己的策略处理（通常是 fail-closed）
      return next()
    }
  }
}

function clipReason(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) return ''
  const chars = [...redactText(raw)]
  return chars.length <= MAX_REASON ? chars.join('') : `${chars.slice(0, MAX_REASON - 1).join('')}…`
}

function audit(record) {
  appendNdjson(files.audit(), { at: new Date().toISOString(), ...record })
}

export { confirmationPhrase }

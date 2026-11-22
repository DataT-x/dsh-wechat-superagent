/**
 * 主机侧：把工具调用接进审批闸。
 *
 * 位置：`tools/pre-execute` waterfall（`@deepseek-ai/dsh-tools` 的 events.ts）。
 *   - 返回 `{kind:'ask'}`，DSH 会走它自己的 approval/request 链路；
 *   - 返回 `{kind:'deny'}`，调用直接失败，模型拿不到执行机会。
 *
 * 我们**不复用** `{kind:'ask'}`，原因：
 *   1. DSH 的 approval/request 结果只有 allowed-once / rejected / cancelled / unavailable，
 *      装不下「二级审批 + 二次确认短语 + 转交」这套流程；
 *   2. 我们要自己维护审批记录与卡片状态。
 * 但如果宿主没有别的应答者（多半如此），`ask` 会 fail-closed，
 * 所以我们必须**自己**完成决策并只返回 allow / deny。
 */
import { classifyToolCall, dynamicRisk } from '../gate/policy.js'
import { mergeRules, actionLabel, confirmationPhrase } from '../gate/rules.js'
import { buildApprovalCard, buildResultCard, approvalMentionText } from '../wecom/cards.js'
import { gitSnapshot } from '../core/git.js'
import { redactDeep } from '../core/redact.js'
import { files, appendNdjson } from '../core/state.js'
import { asLogger } from '../core/log.js'

/**
 * 只读工具白名单。
 *
 * ⚠️ 这里的「只读」指的是**不改变外部状态**，不等于「不敏感」：
 * `read_file` 能读密钥文件，`web_fetch` 能把数据带出去。
 * 所以这个白名单只跳过「动作分类」，**不跳过敏感路径检查**——
 * 见 `prepareForReadOnly()`：命中密钥/凭据路径时仍然要审批。
 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'glob', 'grep', 'search', 'file_read', 'read', 'ls', 'find',
  'todo_write', 'ask_user_question', 'web_search', 'web_fetch', 'list_subagent_models',
  'goal_read', 'goal_write', 'schedule_list', 'session_query',
])

/**
 * 审批闸。
 */
export class ApprovalGate {
  /**
   * @param {object} params
   * @param {() => object} params.getConfig
   * @param {object} params.approval 审批引擎
   * @param {() => string} params.getSigningSecret
   * @param {(payload: object) => Promise<void>} params.deliver 送达（推卡片 + @ 人）
   * @param {(payload: object) => Promise<void>} params.update 更新卡片
   * @param {(level: string, msg: string, ...a: unknown[]) => void} [params.log]
   * @param {(sessionId: string) => object|null} [params.describeSession] 会话元信息
   */
  constructor({ getConfig, approval, getSigningSecret, deliver, update, log, describeSession }) {
    this.getConfig = getConfig
    this.approval = approval
    this.getSigningSecret = getSigningSecret
    this.deliver = deliver
    this.update = update
    this.log = asLogger(log)
    this.describeSession = describeSession ?? (() => null)
    /** 每个 agent 的「是否来自企微」标记，来自企微的消息会打标。 */
    this.wecomOrigins = new Map()
    // 审批引擎的事件 → 卡片更新
    this.approval.on('stage', (approval, extra) => {
      void this.onStage(approval, extra)
    })
    this.approval.on('settled', (approval) => {
      void this.onSettled(approval)
    })
  }

  /** 标记某会话最近的消息来自企微（用于决定审批卡片发到哪）。 */
  markOrigin(sessionId, origin) {
    if (typeof sessionId !== 'string') return
    this.wecomOrigins.set(sessionId, { ...origin, at: Date.now() })
  }

  originOf(sessionId) {
    const o = this.wecomOrigins.get(sessionId)
    if (!o) return null
    // 4 小时内的标记仍然有效
    if (Date.now() - o.at > 4 * 3600_000) { this.wecomOrigins.delete(sessionId); return null }
    return o
  }

  /**
   * 挂到 `tools/pre-execute` 的处理函数。
   * @param {object} exec ToolExecution
   * @param {() => Promise<object>} next
   */
  async onPreExecute(exec, next) {
    const config = this.getConfig()
    if (exec.agent === undefined) return next()

    const toolName = String(exec.name ?? '')
    const isReadOnly = READ_ONLY_TOOLS.has(toolName)

    const rules = mergeRules(config.rules)
    const cwd = safeCwd(exec.agent)
    let classification
    try {
      // 只读工具也走分类：分类器认得「路径命中密钥文件」这类风险，
      // 只是绝大多数读操作会落到 `read`（免审）。
      classification = classifyToolCall({ toolName, args: exec.args, rules, cwd })
    } catch (error) {
      // 分类失败 → fail-closed
      appendNdjson(files.audit(), { at: new Date().toISOString(), type: 'gate.classify.error', toolName, error: String(error?.message ?? error) })
      return { kind: 'deny', reason: `审批闸无法判定这次调用（${String(error?.message ?? error)}），已拒绝。` }
    }
    // 只读 + 未命中敏感路径 → 直接放行（这是绝大多数情况的快路径）
    if (isReadOnly && !classification.needsApproval) {
      return next()
    }
    // 兜底动作的动态风险
    if (classification.action === 'tool.exec') {
      classification.risk = higherRisk(classification.risk, dynamicRisk(classification.command))
    }
    if (!classification.needsApproval) {
      audit('gate.allow', { toolName, action: classification.action, reason: classification.reason })
      return next()
    }
    // 命中必须审批的动作但全局闸被关了：仍要显式记录（让「为什么没人问我」可追溯）
    if (config.approval?.enabled === false) {
      audit('gate.allow.disabled', { toolName, action: classification.action, risk: classification.risk })
      return next()
    }
    // 规则说免审（例如 worktree / test）
    const rule = rules[classification.action] ?? {}
    if (rule.enabled === false) {
      audit('gate.allow.disabled', { toolName, action: classification.action })
      return next()
    }

    // ---- 构造证据 ----
    let git = null
    try {
      git = await gitSnapshot(cwd, { staged: classification.action === 'git.commit' })
    } catch { /* 证据缺失不阻断，只是卡片信息少一点 */ }
    const detail = this.buildDetail({ classification, git, config })
    const origin = this.originOf(sessionIdOf(exec.agent))
    const requester = this.resolveRequester(exec.agent, origin)

    const approval = this.approval.create({
      action: classification.action,
      risk: classification.risk,
      approvalPolicy: rule.approval,
      detail,
      summary: detail.summary,
      requestedBy: requester,
      approvers: Array.isArray(rule.approvers) ? rule.approvers : [],
      timeoutMin: rule.timeoutMin,
      sessionId: sessionIdOf(exec.agent),
      toolName,
    })

    audit('gate.ask', { toolName, action: classification.action, risk: classification.risk, approvalId: approval.id })

    // ---- 送达卡片 ----
    try {
      await this.deliver({ approval, kind: 'approval' })
    } catch (error) {
      // 送不出去 = 没人能批 = 拒绝（绝不能默默放行）
      this.log.error('审批卡片发送失败: %s', String(error?.message ?? error))
      this.approval.cancel(approval.id, '无法送达审批卡片')
      return { kind: 'deny', reason: '审批卡片无法送达企微（机器人未在线或审批人缺失），已拒绝执行。' }
    }

    // ---- 等待决策 ----
    const result = await this.approval.waitFor(approval.id, exec.signal)
    if (result.outcome === 'approved') {
      audit('gate.allow.approved', { approvalId: approval.id, toolName })
      return next()
    }
    const reasonMap = {
      rejected: `审批被驳回${result.approval?.settleComment ? `：${result.approval.settleComment}` : ''}`,
      expired: '审批超时未处理，按拒绝处理',
      cancelled: '审批被取消（调用方中断）',
      unavailable: '审批不可用，按拒绝处理',
    }
    audit('gate.deny', { approvalId: approval.id, toolName, outcome: result.outcome })
    return { kind: 'deny', reason: reasonMap[result.outcome] ?? '审批未通过' }
  }

  /** 组装卡片证据。 */
  buildDetail({ classification, git, config }) {
    const detail = {
      repo: git?.repo || '',
      repoUrl: git?.repo ? `https://github.com/${git.repo}` : '',
      branch: git?.branch || '',
      remote: git?.remote || '',
      command: classification.command || '',
      files: [],
      commits: [],
      diffStat: git?.diffStat || '',
      summary: describeAction(classification, git),
    }
    if (git) {
      const list = classification.action === 'git.commit' ? git.stagedFiles : git.changedFiles
      detail.files = (list ?? []).slice(0, 50).map((f) => ({ path: f.path, status: f.status }))
      detail.commits = (git.aheadCommits ?? []).slice(0, 20).map((c) => ({
        sha: c.sha,
        subject: c.subject,
        author: c.author,
      }))
      if (git.repo && git.branch && git.remote) {
        detail.compareUrl = `https://github.com/${git.repo}/compare/${encodeURIComponent(git.branch)}`
      }
    }
    return redactDeep(detail)
  }

  /** 发起人：优先用企微来源标记里的真实发送人。 */
  resolveRequester(agent, origin) {
    if (origin && typeof origin.senderId === 'string') {
      return { userId: origin.senderId, name: origin.senderName ?? '', chatId: origin.chatId, chatType: origin.chatType }
    }
    const sessionId = sessionIdOf(agent)
    const info = this.describeSession(sessionId)
    return {
      userId: info?.userId ?? 'local-user',
      name: info?.name ?? '本地用户',
      chatId: origin?.chatId ?? '',
      chatType: origin?.chatType ?? 'single',
    }
  }

  /** 阶段推进时更新卡片 + 通知下一级。 */
  async onStage(approval, extra) {
    try {
      const config = this.getConfig()
      if (config.approval?.notifyOnCreate === false) return
      await this.update({ approval, kind: 'stage', extra })
      if (approval.stage === 'pending-owner' && approval.owner) {
        await this.deliver({
          approval,
          kind: 'notify-owner',
          text: `一级审批已通过，请负责人 ${approval.owner} 做最终审批。`,
          targetUserId: approval.owner,
        })
      }
    } catch (error) {
      this.log.warn('更新审批卡片失败: %s', String(error?.message ?? error))
    }
  }

  /** 审批结束时更新卡片。 */
  async onSettled(approval) {
    try {
      const config = this.getConfig()
      if (config.approval?.notifyOnSettle === false) return
      await this.update({ approval, kind: 'result' })
    } catch (error) {
      this.log.warn('结算卡片更新失败: %s', String(error?.message ?? error))
    }
  }

  /** 构造卡片（供 deliver/update 复用）。 */
  cardFor(approval) {
    return buildApprovalCard({
      approval,
      secret: this.getSigningSecret(),
      approvers: { primary: approval.approvers, owner: approval.owner },
    })
  }

  resultCardFor(approval) {
    return buildResultCard({
      approval,
      outcome: approval.stage,
      actor: approval.settledBy,
    })
  }

  dispose() {
    this.wecomOrigins.clear()
  }
}

function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' ? id : ''
}

function safeCwd(agent) {
  const cwd = agent?.session?.meta?.cwd ?? agent?.options?.cwd ?? process.cwd()
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function audit(type, payload) {
  appendNdjson(files.audit(), { at: new Date().toISOString(), type, ...redactDeep(payload) })
}

/** 描述这次动作干了什么（一句话，给审批人看）。 */
export function describeAction(classification, git) {
  const parts = []
  switch (classification.action) {
    case 'git.commit':
      parts.push(`提交 ${git?.stagedFiles?.length ?? 0} 个文件的改动`)
      if (git?.diffStat) parts.push(git.diffStat)
      break
    case 'git.push':
      parts.push(`推送 ${git?.aheadCommits?.length ?? 0} 个提交到 ${git?.remote || '远端'}/${git?.branch || '当前分支'}`)
      if (git?.diffStat) parts.push(git.diffStat)
      break
    case 'git.force-push':
      parts.push(`强推到 ${git?.branch || '当前分支'}，会覆盖远端历史`)
      break
    case 'release.publish':
      parts.push(`发布 ${git?.repo || '项目'} 的新版本`)
      break
    case 'deploy.run':
      parts.push('部署到真实环境')
      break
    case 'test.run':
      parts.push('运行测试')
      break
    case 'build.run':
      parts.push('构建项目')
      break
    case 'deps.install':
      parts.push('变更依赖')
      break
    default:
      parts.push(classification.command || '执行操作')
  }
  if (Array.isArray(git?.changedFiles) && git.changedFiles.length > 0 && classification.action !== 'git.commit') {
    parts.push(`${git.changedFiles.length} 个文件有未提交改动`)
  }
  return parts.filter(Boolean).join('；')
}

function higherRisk(a, b) {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 }
  return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a
}

export { actionLabel, confirmationPhrase, approvalMentionText }

/**
 * 入站路由：企微消息 → DSH 会话。
 *
 * 会话映射策略（与 dsh-im 的 workspace 概念对齐，但更简单）：
 *   一个「企微会话」(chatId) ↔ 一个 DSH 会话（sessionId）。
 *   首次收到消息时若未绑定，则：
 *     - 配置里 `autoBind` 为 true → 绑定到「当前活跃会话」
 *     - 否则 → 回复提示用户先在 DSH 里执行 `/wecom bind`
 *
 * 为什么不让每条消息都开新会话：
 *   仓库守望/审批需要跨轮次的上下文（改到哪了、谁批准的）。
 *   复用同一会话，模型才能接着上次的活干。
 */
import { EventEmitter } from 'node:events'
import { asLogger } from './log.js'
import { authorize, roleOf } from './authz.js'
import { renderContext, composeInboundMessage, inboundHint, toWecomMarkdown } from './context.js'
import { Dedupe, messageKey } from './dedupe.js'
import { appendNdjson, files, readJson, writeJson } from './state.js'
import { redactText } from './redact.js'

/** 已知的聊天内指令。 */
const COMMANDS = {
  '/help': 'help',
  '/帮助': 'help',
  // 严格指令：必须前面没有别的字符（避免把「/帮助我改个bug」当成指令）
  // 宽松指令：允许带参数
  '/status': 'status',
  '/状态': 'status',
  '/approve': 'approve',
  '/通过': 'approve',
  '/reject': 'reject',
  '/驳回': 'reject',
  '/pending': 'pending',
  '/待办': 'pending',
  '/stop': 'stop',
  '/取消': 'stop',
  '/watch': 'watch',
  '/订阅': 'watch',
  '/unwatch': 'unwatch',
  '/退订': 'unwatch',
  '/bind': 'bind',
  '/绑定': 'bind',
}

export class Router extends EventEmitter {
  /**
   * @param {object} params
   * @param {() => object} params.getConfig
   * @param {object} params.state 状态存储对象（见 loadState）
   * @param {(sessionId: string) => any} params.resolveAgent 由宿主提供
   * @param {(level: string, msg: string, ...a: unknown[]) => void} [params.log]
   * @param {object} [params.approval] 审批引擎
   * @param {object} [params.gitwatch] 仓库守望
   */
  constructor({ getConfig, state, resolveAgent, log, approval, gitwatch, listSessions }) {
    super()
    this.getConfig = getConfig
    this.state = state
    this.resolveAgent = resolveAgent
    this.listSessions = listSessions
    this.log = asLogger(log)
    this.approval = approval
    this.gitwatch = gitwatch
    this.dedupe = new Dedupe()
    /** @type {Map<string, Promise<void>>} 每会话串行队列 */
    this.queues = new Map()
    /** @type {Map<string, { approvalId: string, phrase: string, comment: string, at: number }>} 等待确认短语的审批 */
    this.pendingPhrase = new Map()
  }

  /** 处理一帧入站文本消息。 */
  async handleMessage(frame) {
    const body = frame?.body ?? {}
    const text = typeof body.text?.content === 'string' ? body.text.content.trim() : ''
    if (text.length === 0) return
    const key = messageKey(frame)
    if (key && !this.dedupe.claim(key)) {
      this.log.debug('重复消息已忽略: %s', key)
      return
    }
    const chatId = body.chatid ?? body.from?.userid
    const chatType = body.chattype === 'group' ? 'group' : 'single'
    const senderId = body.from?.userid ?? ''
    if (!chatId || !senderId) return

    // 从帧里学「谁是谁、群叫什么」：企微回调可能带昵称/群名，
    // 带就记下来（下次渲染上下文时用），不带就不动。
    this.learnIdentity({ body, chatId, chatType, senderId })

    this.record('inbound', { chatId, chatType, senderId, text: redactText(text.slice(0, 500)) })
    // 同时写进审计日志：设置页的「审计」和「会话 ID」两个面板都读这份。
    // 之前只写了 deliveries.ndjson，结果用户在界面上根本查不到 chatId。
    appendNdjson(files.audit(), {
      at: new Date().toISOString(),
      type: 'inbound',
      chatId,
      chatType,
      senderId,
      senderName: this.state.names?.[senderId] ?? '',
      chatTitle: this.state.titles?.[chatId] ?? '',
      sessionId: this.state.bindings?.[chatId] ?? '',
      text: redactText(text.slice(0, 120)),
    })
    // 同步通知上层（用于把企微来源带给审批闸，让审批卡片能回到正确的会话）
    this.emit('inbound', {
      chatId, chatType, senderId, chatTitle: this.state.titles?.[chatId],
      sessionId: this.state.bindings?.[chatId],
    })

    // ---- 确认短语回填（优先于一切，因为它是一个待完成的操作）----
    const phraseKey = `${chatId}:${senderId}`
    const waiting = this.pendingPhrase.get(phraseKey)
    if (waiting) {
      this.pendingPhrase.delete(phraseKey)
      if (Date.now() - waiting.at > 2 * 60_000) {
        await this.reply(frame, chatId, '⌛ 确认已超时，请重新发起审批。')
        return
      }
      if (text.trim() !== waiting.phrase) {
        await this.reply(frame, chatId, '已取消（短语不匹配）。需要通过请重新 `/approve`。')
        return
      }
      const result = this.approval?.decide({
        approvalId: waiting.approvalId,
        userId: senderId,
        userName: this.state.names[senderId],
        verdict: 'approve',
        comment: waiting.comment,
        phrase: waiting.phrase,
      })
      await this.reply(frame, chatId, result?.ok
        ? `✅ 确认无误，已通过。${result.note ? `（${result.note}）` : ''}`
        : `⛔ ${result?.reason ?? '审批失败'}`)
      return
    }

    // ---- 指令分流 ----
    const firstToken = text.split(/\s+/)[0].toLowerCase()
    const command = COMMANDS[firstToken]
    if (command) {
      await this.runSerial(chatId, () => this.handleCommand({ command, args: text.slice(text.indexOf(firstToken) + firstToken.length).trim(), frame, chatId, chatType, senderId }))
      return
    }

    await this.runSerial(chatId, () => this.handlePrompt({ text, frame, chatId, chatType, senderId }))
  }

  /** 普通消息 → 唤醒 DSH 会话。 */
  async handlePrompt({ text, frame, chatId, chatType, senderId }) {
    const config = this.getConfig()
    const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'command' })
    if (!auth.allowed) {
      await this.reply(frame, chatId, `⛔ ${auth.reason}`)
      return
    }
    const sessionId = this.state.bindings[chatId]
    if (!sessionId) {
      await this.reply(frame, chatId, [
        '还没有绑定 DSH 会话。',
        '',
        '请在 DSH 里对要接管的会话说：',
        '```',
        `/wecom bind ${chatId}`,
        '```',
        '或在设置面板里把「自动绑定」打开（新消息会绑定到最近活跃的会话）。',
      ].join('\n'))
      return
    }
    const agent = this.resolveAgent(sessionId)
    if (!agent) {
      await this.reply(frame, chatId, `会话 ${sessionId.slice(0, 8)} 已不存在（可能被删除）。请重新绑定。`)
      delete this.state.bindings[chatId]
      this.saveState()
      return
    }

    const context = renderContext({
      config: config.context,
      chatType,
      chatTitle: this.state.titles[chatId],
      chatId,
      senderId,
      senderName: this.state.names[senderId],
      at: new Date(),
      messageId: frame?.body?.msgid,
      role: auth.role,
    })
    const body = composeInboundMessage({ context, hint: inboundHint(chatType), content: text })

    const message = this.buildUserMessage(body, { chatId, chatType, senderId })
    try {
      // 空闲 → 开新轮次；忙碌 → 作为 steering 在下一步插入
      if (agent.status === 'running') agent.steer(message)
      else agent.followup(message)
      this.record('wake', { chatId, sessionId, chatType })
      // 首次唤醒时回一句，避免用户以为消息丢了
      const ackKey = `ack:${chatId}`
      if (!this.dedupe.has(ackKey)) {
        this.dedupe.claim(ackKey)
        await this.reply(frame, chatId, '✅ 已收到，正在处理。结果会发回这里。')
      }
    } catch (error) {
      this.log.error('唤醒会话失败: %s', String(error?.message ?? error))
      await this.reply(frame, chatId, `❌ 唤醒会话失败：${redactText(String(error?.message ?? error))}`)
    }
  }

  /** 构造模型消息（结构需满足 DSH 的 UserMessage）。 */
  buildUserMessage(text, meta) {
    const build = this.messageFactory
    if (typeof build === 'function') return build(text, meta)
    // 兜底：最小可用结构（宿主会补 id/role）
    return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }

  /** 处理聊天内指令。 */
  async handleCommand({ command, args, frame, chatId, chatType, senderId }) {
    const config = this.getConfig()
    switch (command) {
      case 'help': {
        await this.reply(frame, chatId, HELP_TEXT)
        return
      }
      case 'status': {
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'query' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ ${auth.reason}`)
        const sessionId = this.state.bindings[chatId]
        const agent = sessionId ? this.resolveAgent(sessionId) : null
        const lines = [
          '**状态**',
          `- 绑定会话: ${sessionId ? `${sessionId.slice(0, 8)}… (${agent ? agent.status : '已失效'})` : '未绑定'}`,
          `- 你的角色: ${auth.role}`,
          `- 待审批: ${this.approval ? this.approval.list({ userId: senderId }).length : 0}`,
          `- 守望仓库: ${this.gitwatch ? this.gitwatch.list().length : 0}`,
        ]
        await this.reply(frame, chatId, lines.join('\n'))
        return
      }
      case 'pending': {
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'approve' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ ${auth.reason}`)
        const items = this.approval ? this.approval.list({ userId: senderId }) : []
        if (items.length === 0) return this.reply(frame, chatId, '没有待你处理的审批。')
        const lines = items.map((a) => `- ${a.icon} **${a.actionLabel}** \`${a.id.slice(-6)}\` ${a.summary}`)
        await this.reply(frame, chatId, ['**待你审批**', ...lines, '', '可回复 `/approve <编号后6位>` 通过。'].join('\n'))
        return
      }
      case 'approve':
      case 'reject': {
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'approve' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ ${auth.reason}`)
        const parts = args.trim().split(/\s+/)
        const code = parts[0] ?? ''
        if (code.length === 0) return this.reply(frame, chatId, `用法：\`/${command} 审批编号后6位 [意见]\``)
        const target = this.findApprovalByCode(code)
        if (!target) return this.reply(frame, chatId, `找不到审批 \`${code}\`。用 \`/pending\` 查看待办。`)
        const comment = parts.slice(1).join(' ')

        // 需要确认短语的动作：暂存待确认，要求用户单独发一次短语
        if (command === 'approve' && target.phrase) {
          this.pendingPhrase.set(`${chatId}:${senderId}`, {
            approvalId: target.id,
            phrase: target.phrase,
            comment,
            at: Date.now(),
          })
          return this.reply(frame, chatId, [
            `⚠️ 这个动作（${target.actionLabel}）需要在 2 分钟内输入确认短语才能通过：`,
            '',
            `\`${target.phrase}\``,
            '',
            '直接把上面这行发给我即可。发别的会取消。',
          ].join('\n'))
        }

        const result = this.approval.decide({
          approvalId: target.id,
          userId: senderId,
          userName: this.state.names[senderId],
          verdict: command === 'approve' ? 'approve' : 'reject',
          comment,
        })
        await this.reply(frame, chatId, result.ok ? `✅ 已${command === 'approve' ? '通过' : '驳回'} \`${code}\`${result.note ? `（${result.note}）` : ''}` : `⛔ ${result.reason}`)
        return
      }
      case 'stop': {
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'command' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ ${auth.reason}`)
        const sessionId = this.state.bindings[chatId]
        const agent = sessionId ? this.resolveAgent(sessionId) : null
        if (!agent) return this.reply(frame, chatId, '未绑定会话。')
        agent.cancel('user-request')
        await this.reply(frame, chatId, '🛑 已请求停止当前任务。')
        return
      }
      case 'bind': {
        // 在企微里绑定：/bind <sessionId前缀>，必须是 owner/approver 才能改绑定
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'approve' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ 绑定会话需要审批人权限。（${auth.reason}）`)
        const target = args.trim()
        if (target.length === 0) {
          const list = (this.listSessions?.() ?? [])
          if (list.length === 0) return this.reply(frame, chatId, '用法：`/bind <会话ID前8位>`（在 DSH 里复制会话 ID）')
          const lines = list.slice(0, 10).map((s) => `- \`${s.id.slice(0, 8)}\` ${s.title ?? ''}（${s.status ?? '?'}）`)
          return this.reply(frame, chatId, ['**可绑定的会话**', ...lines, '', '用法：`/bind <前8位>`'].join('\n'))
        }
        const sessions = this.listSessions?.() ?? []
        const match = sessions.find((s) => s.id === target) ?? sessions.find((s) => s.id.startsWith(target))
        if (!match) return this.reply(frame, chatId, `找不到会话 \`${target}\`。`)
        this.state.bindings[chatId] = match.id
        this.saveState()
        this.record('bind', { chatId, sessionId: match.id, by: senderId })
        await this.reply(frame, chatId, `✅ 已绑定会话 \`${match.id.slice(0, 8)}\`（${match.title ?? ''}）。现在可以直接发任务了。`)
        return
      }
      case 'watch':
      case 'unwatch': {
        const auth = authorize({ config, userId: senderId, chatType, chatId, intent: 'command' })
        if (!auth.allowed) return this.reply(frame, chatId, `⛔ ${auth.reason}`)
        if (!this.gitwatch) return this.reply(frame, chatId, '仓库守望未启用。')
        const repo = args.trim()
        if (repo.length === 0) {
          const list = this.gitwatch.list()
          return this.reply(frame, chatId, list.length === 0 ? '当前没有守望的仓库。用法：`/watch owner/name`' : ['**守望中**', ...list.map((w) => `- ${w.repo}（每 ${Math.round(w.intervalMs / 1000)}s）`)].join('\n'))
        }
        if (command === 'watch') {
          const r = await this.gitwatch.add({ repo, chatId, chatType, addedBy: senderId })
          return this.reply(frame, chatId, r.ok ? `👀 开始守望 \`${repo}\`，每 ${Math.round(r.intervalMs / 1000)}s 检查一次。` : `⛔ ${r.reason}`)
        }
        const r = await this.gitwatch.remove({ repo, chatId })
        return this.reply(frame, chatId, r.ok ? `已停止守望 \`${repo}\`。` : `⛔ ${r.reason}`)
      }
      default:
        await this.reply(frame, chatId, '未知指令，试试 `/help`。')
    }
  }

  /** 按后 6 位找审批。 */
  findApprovalByCode(code) {
    if (!this.approval) return null
    const norm = code.toUpperCase()
    return this.approval.list().find((a) => a.id.slice(-6).toUpperCase() === norm
      || a.id.slice(-6).toUpperCase().startsWith(norm)) ?? null
  }

  /** 处理卡片按钮点击事件。 */
  async handleCardEvent(frame) {
    const event = frame?.body?.event ?? {}
    if (event.eventtype !== 'template_card_event') return
    const key = event.event_key
    const senderId = frame?.body?.from?.userid ?? ''
    const chatId = frame?.body?.chatid ?? senderId
    const chatType = frame?.body?.chattype === 'group' ? 'group' : 'single'
    this.record('card', { senderId, key: typeof key === 'string' ? key.slice(0, 80) : '' })
    this.emit('card', { frame, key, senderId, chatId, chatType })
  }

  /** 回复（自动脱敏 + 裁剪）。 */
  async reply(frame, chatId, text) {
    const body = toWecomMarkdown(text)
    this.emit('outbound', { frame, chatId, text: body })
  }

  /**
   * 从入站帧里学习「发送者昵称 / 群名」，供上下文增强使用。
   * 企微长连接的帧里昵称可能出现在 `from.name`、`from.alias`、
   * 或群消息的 `chatname`，字段不稳定，所以逐个探测。
   */
  learnIdentity({ body, chatId, chatType, senderId }) {
    let changed = false
    const from = body?.from ?? {}
    const displayName = firstNonEmpty(from.name, from.alias, from.display_name, from.nickname)
    if (displayName && this.state.names[senderId] !== displayName) {
      this.state.names[senderId] = String(displayName).slice(0, 64)
      changed = true
    }
    if (chatType === 'group') {
      const title = firstNonEmpty(body?.chatname, body?.chat_name, body?.conversation_title)
      if (title && this.state.titles[chatId] !== title) {
        this.state.titles[chatId] = String(title).slice(0, 64)
        changed = true
      }
    }
    // 昵称表不必每次落盘：只在变化时写，且限长防膨胀
    if (changed) {
      const names = Object.entries(this.state.names)
      if (names.length > 500) this.state.names = Object.fromEntries(names.slice(-500))
      this.saveState()
    }
  }

  /** 单会话串行执行：同一会话的消息按序处理，避免并发抢占会话。 */
  runSerial(chatId, task) {    const prev = this.queues.get(chatId) ?? Promise.resolve()
    const next = prev.then(task, task).catch((error) => {
      this.log.error('处理消息出错: %s', String(error?.message ?? error))
    })
    this.queues.set(chatId, next)
    next.finally(() => { if (this.queues.get(chatId) === next) this.queues.delete(chatId) })
    return next
  }

  record(kind, data) {
    appendNdjson(files.deliveries(), { at: new Date().toISOString(), kind, ...data })
  }

  saveState() {
    writeJson(files.state(), this.state)
  }
}

const HELP_TEXT = [
  '**企业微信 Superagent 指令**',
  '',
  '**任务**',
  '- 直接说话即可，消息会被送进绑定的 DSH 会话',
  '- `/stop` 停止当前任务',
  '',
  '**审批**',
  '- `/pending` 看我的待办',
  '- `/approve <编号>` 通过',
  '- `/reject <编号> [意见]` 驳回',
  '- 卡片上直接点按钮更快',
  '',
  '**仓库**',
  '- `/watch owner/name` 开始守望',
  '- `/unwatch owner/name` 停止守望',
  '',
  '**其他**',
  '- `/status` 当前状态',
  '- `/help` 这份帮助',
].join('\n')

/** 读取状态文件，补默认值。 */
export function loadState() {
  const raw = readJson(files.state(), {}) ?? {}
  return {
    version: 1,
    bindings: isObject(raw.bindings) ? raw.bindings : {},
    titles: isObject(raw.titles) ? raw.titles : {},
    names: isObject(raw.names) ? raw.names : {},
    watchers: Array.isArray(raw.watchers) ? raw.watchers : [],
    ...raw,
    // 保证上面四项一定存在
    bindings: isObject(raw.bindings) ? raw.bindings : {},
    titles: isObject(raw.titles) ? raw.titles : {},
    names: isObject(raw.names) ? raw.names : {},
    watchers: Array.isArray(raw.watchers) ? raw.watchers : [],
  }
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return ''
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export { COMMANDS }

/**
 * 企业微信传输层：封装 @wecom/aibot-node-sdk 的长连接。
 *
 * 为什么用长连接而不是回调 URL：
 *   DSH 通常跑在个人电脑/内网，没有公网 HTTPS 域名可供企微回调。
 *   企微「智能机器人」支持 WebSocket 主动订阅（aibot_subscribe），
 *   只需 botId + secret 即可收到该机器人的消息——这是「一键创建」的技术前提。
 *
 * 本层只负责「连上、收、发」，不做业务判定。
 */
import { EventEmitter } from 'node:events'

/** 连接状态机。 */
export const STATE = /** @type {const} */ ({
  idle: 'idle',
  connecting: 'connecting',
  online: 'online',
  offline: 'offline',
  error: 'error',
})

/**
 * @typedef {object} TransportOptions
 * @property {string} botId
 * @property {string} secret
 * @property {string} [wsUrl]
 * @property {number} [heartbeatInterval]
 * @property {number} [maxReconnectAttempts]
 * @property {(level: string, msg: string, ...args: unknown[]) => void} [log]
 */

/** 动态加载 SDK：插件在没装 SDK 时也要能加载（设置页需要能打开）。 */
async function loadSdk() {
  const candidates = ['@wecom/aibot-node-sdk']
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      return mod
    } catch { /* 继续尝试 */ }
  }
  throw new Error('未找到 @wecom/aibot-node-sdk。请先 `npm i @wecom/aibot-node-sdk`，或通过插件管理器安装依赖。')
}

export class WeComTransport extends EventEmitter {
  /**
   * @param {TransportOptions} options
   */
  constructor(options) {
    super()
    this.options = options
    /** @type {any} */
    this.client = null
    this.state = STATE.idle
    this.lastError = null
    this.connectedAt = null
    /** 出站串行队列：同一时刻只发一条，避免触发企微频率限制。 */
    this.outbox = Promise.resolve()
    this.disposed = false
    this.stats = { inbound: 0, outbound: 0, errors: 0, reconnects: 0 }
  }

  log(level, message, ...args) {
    if (typeof this.options.log === 'function') this.options.log(level, message, ...args)
  }

  get isOnline() {
    return this.state === STATE.online
  }

  /** 建立连接。可重复调用（会先断开旧连接）。 */
  async connect() {
    if (this.disposed) throw new Error('transport 已销毁')
    if (this.state === STATE.connecting || this.state === STATE.online) return this
    this.state = STATE.connecting
    this.emit('state', this.state)
    const sdk = await loadSdk()
    const AiBot = sdk.default ?? sdk
    const WSClient = AiBot.WSClient ?? sdk.WSClient
    if (typeof WSClient !== 'function') throw new Error('@wecom/aibot-node-sdk 版本不兼容：缺少 WSClient')

    const client = new WSClient({
      botId: this.options.botId,
      secret: this.options.secret,
      ...(this.options.wsUrl ? { wsUrl: this.options.wsUrl } : {}),
      ...(this.options.heartbeatInterval ? { heartbeatInterval: this.options.heartbeatInterval } : {}),
      maxReconnectAttempts: this.options.maxReconnectAttempts ?? -1,
      logger: {
        debug: (m, ...a) => this.log.debug(m, ...a),
        info: (m, ...a) => this.log.info(m, ...a),
        warn: (m, ...a) => this.log.warn(m, ...a),
        error: (m, ...a) => this.log.error(m, ...a),
      },
    })
    this.client = client
    this.wireEvents(client)
    client.connect()
    return this
  }

  /** 把 SDK 事件接到自己的事件总线上。 */
  wireEvents(client) {
    client.on('authenticated', () => {
      this.state = STATE.online
      this.connectedAt = Date.now()
      this.lastError = null
      this.emit('state', this.state)
      this.emit('online')
      this.log.info('企微机器人已上线')
    })
    client.on('disconnected', (reason) => {
      this.state = STATE.offline
      this.emit('state', this.state)
      this.emit('offline', reason)
      this.log.warn('企微连接断开: %s', String(reason ?? ''))
    })
    client.on('reconnecting', (attempt) => {
      this.stats.reconnects += 1
      this.state = STATE.connecting
      this.emit('state', this.state)
      this.emit('reconnecting', attempt)
    })
    client.on('error', (error) => {
      this.stats.errors += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emit('state', STATE.error)
      this.emit('failure', error)
      this.log.error('企微连接错误: %s', this.lastError)
    })
    client.on('message', (frame) => {
      this.stats.inbound += 1
      this.emit('message', frame)
    })
    client.on('event', (frame) => {
      this.stats.inbound += 1
      this.emit('event', frame)
    })
  }

  /** 在出站队列里执行一个发送动作。 */
  enqueue(task) {
    const run = this.outbox.then(task, task)
    // 保证队列不会因为单次失败而卡死
    this.outbox = run.then(() => undefined, () => undefined)
    return run
  }

  /** 确保在线；不在线时抛错（不静默丢弃）。 */
  assertOnline() {
    if (!this.client || this.state !== STATE.online) {
      throw new Error(`企微机器人未在线（当前状态 ${this.state}）`)
    }
  }

  /**
   * 主动发消息到会话。
   * @param {string} chatId 单聊填 userid，群聊填 chatid
   * @param {object} body SendMarkdownMsgBody | SendTemplateCardMsgBody
   */
  async sendMessage(chatId, body) {
    this.assertOnline()
    return this.enqueue(async () => {
      const r = await this.client.sendMessage(chatId, body)
      this.stats.outbound += 1
      return r
    })
  }

  /** 发 markdown 文本。 */
  async sendMarkdown(chatId, content) {
    return this.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: String(content ?? '') } })
  }

  /** 发模板卡片。 */
  async sendCard(chatId, templateCard) {
    return this.sendMessage(chatId, { msgtype: 'template_card', template_card: templateCard })
  }

  /**
   * 被动回复（回复到收到消息的那个会话）。
   * @param {object} frame 原始帧
   * @param {string} text
   */
  async replyText(frame, text) {
    this.assertOnline()
    return this.enqueue(async () => {
      const r = await this.client.reply(frame, { msgtype: 'markdown', markdown: { content: String(text ?? '') } })
      this.stats.outbound += 1
      return r
    })
  }

  /** 流式回复中间内容。 */
  async replyStream(frame, streamId, content, finish = false) {
    this.assertOnline()
    return this.enqueue(async () => {
      const r = await this.client.replyStream(frame, streamId, String(content ?? ''), finish)
      this.stats.outbound += 1
      return r
    })
  }

  /**
   * 更新模板卡片（点击按钮后 5 秒内必须调用）。
   * @param {object} frame 触发事件的帧
   * @param {object} card 新卡片
   * @param {string[]} [userIds]
   */
  async updateCard(frame, card, userIds) {
    this.assertOnline()
    return this.enqueue(async () => {
      const r = await this.client.updateTemplateCard(frame, card, userIds)
      this.stats.outbound += 1
      return r
    })
  }

  /** 上传媒体。 */
  async uploadMedia(buffer, options) {
    this.assertOnline()
    return this.enqueue(async () => this.client.uploadMedia(buffer, options))
  }

  /** 下载并解密文件。 */
  async downloadFile(url, aesKey) {
    this.assertOnline()
    return this.client.downloadFile(url, aesKey)
  }

  /** 断开。 */
  async disconnect() {
    const client = this.client
    this.client = null
    this.state = STATE.idle
    this.emit('state', this.state)
    if (client) {
      try { client.disconnect() } catch { /* ignore */ }
    }
  }

  /** 彻底销毁。 */
  async dispose() {
    this.disposed = true
    await this.disconnect()
    this.removeAllListeners()
  }
}

/** 生成一个请求 ID（流式用）。 */
export function newStreamId() {
  return `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

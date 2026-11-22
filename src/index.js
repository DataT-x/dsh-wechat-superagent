/**
 * dsh-wechat-superagent —— 插件入口。
 *
 * 装配顺序（很重要）：
 *   1. 读配置与凭据（缺失也要能起来，设置面板需要能打开）
 *   2. 起审批引擎（恢复未完成审批）
 *   3. 起传输层（机器人没配置就不连）
 *   4. 起路由（企微 → DSH 会话）
 *   5. 起守望（仓库 → 会话）
 *   6. 挂审批闸（tools/pre-execute）
 *   7. 注册工具
 *   8. 注册 HTTP 路由（设置页 / 健康检查）
 *
 * 任何一步失败都不能让整个 profile 起不来：插件是「增强」，不是「刚需」。
 */
import { existsSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

import { defaultConfig, normalizeConfig, setPath } from './config.js'
import { files, readJson, writeJson } from './core/state.js'
import { readSecrets, ensureSigningSecret, setBotSecret, setGithubToken, redactSecretsForUi, isConfigured, envOverrides } from './core/secrets.js'
import { previewSecret, redactText } from './core/redact.js'
import { ApprovalEngine } from './core/approval.js'
import { Router, loadState } from './core/router.js'
import { GitWatcher } from './core/gitwatch.js'
import { WeComTransport, STATE } from './wecom/transport.js'
import { buildApprovalCard, buildResultCard, decodeButtonKey, approvalMentionText } from './wecom/cards.js'
import { ApprovalGate } from './host/gate.js'
import { NativeApprovalBridge } from './host/native-approval.js'
import { registerTools } from './tools.js'
import { registerHttp } from './http.js'
import { toWecomMarkdown } from './core/context.js'

export const name = 'wecom-superagent'

/**
 * 依赖：webServer 用于设置页/回调；tools 用于注册模型工具。
 * 三个都是 `inject` 可选依赖，DSH 会在服务就绪后再调用 apply。
 */
/**
 * 依赖：webServer 用于设置页；tools 用于注册模型工具。
 *
 * `agents` 不放进 inject：它是 `dsh-agent` 提供的，某些 profile 里可能缺席，
 * 而缺了它插件也应该能起来（只是唤醒不了会话）。运行时用 `ctx.get('agents')` 取。
 */
export const inject = ['tools', 'webServer']

/** 插件配置（DSH 设置面板的「插件」页会渲染这个 schema）。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('启用企业微信连接'),
  botId: Schema.string().default('').description('机器人 ID'),
  ownerUserId: Schema.string().default('').description('负责人 userId（所有审批的最终关卡）'),
  autoBind: Schema.boolean().default(false).description('自动绑定最近活跃会话'),
  approvalEnabled: Schema.boolean().default(true).description('启用审批闸'),
  defaultTimeoutMin: Schema.number().default(30).description('默认审批时限（分钟）'),
  watchIntervalSec: Schema.number().default(60).description('默认守望间隔（秒）'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export async function apply(ctx, config) {
  const log = makeLogger(ctx)
  // 取 agents 服务：不用解构，避免在服务被替换后持有过期引用。
  const agentsOf = () => {
    try { return ctx.get?.('agents') ?? ctx.agents ?? null } catch { return null }
  }
  // ---------- 1. 配置与凭据 ----------
  let pluginConfig = mergePluginConfig(config)
  const secrets0 = readSecrets()
  log.info('企业微信 superagent 启动中（已配置：%s）', isConfigured(pluginConfig, secrets0) ? '是' : '否')

  let state = loadState()
  const saveState = () => writeJson(files.state(), state)

  const getConfig = () => pluginConfig
  const setConfig = (patch) => {
    pluginConfig = normalizeConfig({ ...pluginConfig, ...patch })
    writeJson(files.config(), pluginConfig)
    return pluginConfig
  }

  // 首次运行：把模板写盘，方便用户直接编辑
  if (!existsSync(files.config())) writeJson(files.config(), pluginConfig)

  // ---------- 2. 审批引擎 ----------
  const signingSecret = ensureSigningSecret()
  const getSigningSecret = () => {
    const s = readSecrets()
    return s.signingSecret || signingSecret
  }

  const approval = new ApprovalEngine({ getConfig, getSigningSecret, log })
  try { approval.restore() } catch (error) { log.warn('恢复审批失败：%s', String(error?.message ?? error)) }

  // ---------- 3. 传输层 ----------
  const transport = new WeComTransport({
    botId: pluginConfig.bot.botId,
    secret: secrets0.botSecret,
    wsUrl: pluginConfig.bot.wsUrl || undefined,
    maxReconnectAttempts: pluginConfig.bot.autoReconnect === false ? 0 : -1,
    log,
  })
  // 支持热重连
  transport.reconnect = async (botId, secret, wsUrl) => {
    await transport.dispose().catch(() => {})
    transport.disposed = false
    transport.options = { ...transport.options, botId, secret, wsUrl: wsUrl || undefined, log }
    transport.state = STATE.idle
    await transport.connect()
    return transport
  }

  // ---------- 4. 路由 ----------
  const router = new Router({
    getConfig,
    state,
    resolveAgent: (sessionId) => agentsOf()?.get?.(sessionId) ?? null,
    log,
    approval,
  })
  // 消息 → 回复
  router.on('outbound', ({ frame, chatId, text }) => {
    void (async () => {
      try {
        if (frame) await transport.replyText(frame, text)
        else await transport.sendMarkdown(chatId, text)
      } catch (error) {
        log.error('发送失败：%s', String(error?.message ?? error))
      }
    })()
  })

  // ---------- 5. 守望 ----------
  const gitwatch = new GitWatcher({
    getConfig,
    state,
    saveState,
    log,
    wake: async (watch, text) => {
      const sessionId = watch.sessionId || state.bindings[watch.chatId]
      if (!sessionId) return false
      const agent = agentsOf()?.get?.(sessionId)
      if (!agent) return false
      try {
        agent.followup(router.buildUserMessage(text, { watch: watch.id }))
        // 同时在企微里说一声，让人知道发生了什么
        await transport.sendMarkdown(watch.chatId, toWecomMarkdown(`👀 \`${watch.repo}\` 有动静，已交给会话处理。`)).catch(() => {})
        return true
      } catch (error) {
        log.warn('唤醒失败：%s', String(error?.message ?? error))
        return false
      }
    },
  })
  router.gitwatch = gitwatch

  // ---------- 6. 审批闸 ----------
  /** 每张审批卡「已更新到哪个阶段」的记忆，避免同一阶段重复发卡。 */
  const cardStage = new Map()

  const deliver = async (payload) => {
    const { approval: a, kind, text, targetUserId } = payload
    const chatId = a.requestedBy?.chatId || targetUserId
    if (!chatId) throw new Error('审批没有可送达的会话（发起时不在企微里）')
    if (!transport.isOnline) throw new Error('机器人未在线')
    const card = buildApprovalCard({ approval: a, secret: getSigningSecret(), approvers: { primary: a.approvers, owner: a.owner } })
    await transport.sendCard(chatId, card)
    cardStage.set(a.id, a.stage)
    if (text) await transport.sendMarkdown(chatId, toWecomMarkdown(text)).catch(() => {})
  }
  const update = async (payload) => {
    const { approval: a, kind } = payload
    const chatId = a.requestedBy?.chatId
    if (!chatId || !transport.isOnline) return
    if (kind === 'result') {
      // 终态只发一次
      const key = `${a.id}:result`
      if (cardStage.has(key)) return
      cardStage.set(key, a.stage)
      await transport.sendCard(chatId, buildResultCard({ approval: a, outcome: a.stage, actor: a.settledBy }))
      // 结果卡发完就清掉阶段记忆，避免无限增长
      cardStage.delete(a.id)
      setTimeout(() => cardStage.delete(key), 60_000).unref?.()
      return
    }
    // 阶段推进：同一阶段不重复发
    if (cardStage.get(a.id) === a.stage) return
    const text = a.stage === 'pending-owner'
      ? approvalMentionText(a, { primary: a.approvers, owner: a.owner }, a.stage)
      : null
    const card = buildApprovalCard({ approval: a, secret: getSigningSecret(), approvers: { primary: a.approvers, owner: a.owner } })
    await transport.sendCard(chatId, card)
    cardStage.set(a.id, a.stage)
    if (text) await transport.sendMarkdown(chatId, toWecomMarkdown(text)).catch(() => {})
  }

  const gate = new ApprovalGate({
    getConfig, approval, getSigningSecret, deliver, update, log,
    describeSession: () => null,
  })

  // 把路由收到的企微来源告诉 gate（供审批卡片回到正确的会话）
  router.on('inbound', ({ chatId, chatType, senderId, sessionId }) => {
    if (sessionId) gate.markOrigin(sessionId, { chatId, chatType, senderId })
  })

  // 挂 pre-execute
  const offPre = ctx.on('tools/pre-execute', (exec, next) => gate.onPreExecute(exec, next))

  // 接管 DSH 原生审批（沙箱升级、其他插件发起的审批）
  // `prepend: true` 让我们排在浏览器 UI 之前；不接管时 next() 会交还。
  const nativeBridge = new NativeApprovalBridge({
    getConfig,
    approval,
    gate,
    transport,
    deliver,
    update,
    log: (level, ...rest) => log.call(level, ...rest),
    isEnabled: () => pluginConfig.approval?.enabled !== false && transport.isOnline,
  })
  const offNative = ctx.on('approval/request', (request, next) => nativeBridge.handle(request, next), { prepend: true })

  // ---------- 7. 工具 ----------
  const toolDisposers = registerTools({
    ctx,
    deps: {
      getConfig,
      setConfig,
      getState: () => state,
      transport,
      approval,
      gate,
      gitwatch,
      readSecrets,
      setBotSecret,
      setGithubToken,
      previewSecret,
      toWecomMarkdown,
      deliver,
    },
  })

  // ---------- 8. HTTP ----------
  const offHttp = registerHttp({
    ctx,
    deps: {
      getConfig, setConfig, getState: () => state, saveState,
      transport, approval, gitwatch, gate,
      readSecrets, setBotSecret, setGithubToken, redactSecretsForUi, previewSecret,
      getSigningSecret,
    },
    log,
  })

  // ---------- 9. 传输层事件接线 ----------
  transport.on('message', (frame) => {
    void router.handleMessage(frame).catch((error) => log.error('处理消息失败：%s', String(error?.message ?? error)))
    // 同步标记来源
    const sessionId = state.bindings[frame?.body?.chatid ?? frame?.body?.from?.userid]
    if (sessionId) {
      gate.markOrigin(sessionId, {
        chatId: frame?.body?.chatid ?? frame?.body?.from?.userid,
        chatType: frame?.body?.chattype === 'group' ? 'group' : 'single',
        senderId: frame?.body?.from?.userid ?? '',
      })
    }
  })
  transport.on('event', (frame) => {
    void handleCardTap(frame).catch((error) => log.error('处理卡片事件失败：%s', String(error?.message ?? error)))
  })
  transport.on('failure', (error) => log.warn('企微连接异常：%s', redactText(String(error?.message ?? error))))

  /** 卡片按钮点击。 */
  async function handleCardTap(frame) {
    const event = frame?.body?.event ?? {}
    if (event.eventtype !== 'template_card_event') return
    const senderId = frame?.body?.from?.userid ?? ''
    const chatId = frame?.body?.chatid ?? senderId
    const chatType = frame?.body?.chattype === 'group' ? 'group' : 'single'
    const decoded = decodeButtonKey(getSigningSecret(), event.event_key)
    if (!decoded.ok) {
      log.warn('卡片 key 校验失败：%s', decoded.reason)
      await transport.replyText(frame, `⚠️ 这张卡片无效（${decoded.reason}），请让机器人在 DSH 里重新发起审批。`).catch(() => {})
      return
    }
    const target = approval.get(decoded.approvalId)
    if (!target) {
      await transport.replyText(frame, '这个审批已经结束了。').catch(() => {})
      return
    }
    if (target.stage !== 'pending-primary' && target.stage !== 'pending-owner') {
      await transport.replyText(frame, `这个审批已经${target.stage === 'approved' ? '通过' : '结束'}了。`).catch(() => {})
      return
    }

    if (decoded.action === 'detail') {
      await transport.replyText(frame, renderApprovalDetail(target)).catch(() => {})
      return
    }
    if (decoded.action === 'defer') {
      await transport.replyText(frame, '已标记稍后处理。这个审批仍在等待你，过期前都可以批。').catch(() => {})
      return
    }
    if (decoded.action === 'approve' || decoded.action === 'reject') {
      const verdict = decoded.action === 'approve' ? 'approve' : 'reject'
      const result = approval.decide({
        approvalId: target.id,
        userId: senderId,
        verdict,
        phrase: verdict === 'approve' ? target.phrase ?? undefined : undefined,
      })
      if (!result.ok) {
        await transport.replyText(frame, `⚠️ ${result.reason}`).catch(() => {})
        return
      }
      const summary = verdict === 'approve' ? '✅ 已通过' : '⛔ 已驳回'
      await transport.replyText(frame, `${summary}（${target.id.slice(-6)}）${result.note ? ` ${result.note}` : ''}`).catch(() => {})
      return
    }
    await transport.replyText(frame, '未知的卡片操作。').catch(() => {})
  }

  // ---------- 10. 自动连接 ----------
  const env = envOverrides()
  if (env.active && !pluginConfig.bot.botId) {
    log.info('检测到 WECOM_BOT_ID / WECOM_BOT_SECRET 环境变量，使用它们连接')
    setConfig({ bot: { ...pluginConfig.bot, botId: env.botId }, enabled: true })
    setBotSecret(env.botSecret)
  }
  if (pluginConfig.enabled && isConfigured(pluginConfig, readSecrets())) {
    try {
      await transport.reconnect(pluginConfig.bot.botId, readSecrets().botSecret, pluginConfig.bot.wsUrl)
      log.info('企微机器人连接中…')
    } catch (error) {
      log.error('企微连接失败：%s', redactText(String(error?.message ?? error)))
    }
  }
  gitwatch.start()

  // ---------- 11. 清理 ----------
  ctx.effect(() => () => {
    try { offPre?.() } catch { /* ignore */ }
    try { offNative?.() } catch { /* ignore */ }
    try { offHttp?.() } catch { /* ignore */ }
    for (const d of toolDisposers) { try { d() } catch { /* ignore */ } }
    gate.dispose()
    gitwatch.dispose()
    approval.dispose()
    void transport.dispose()
    router.removeAllListeners()
  }, 'wecom-superagent.dispose()')

  log.info('企业微信 superagent 已加载')
}

/** 把 DSH 的插件 schema 值合并进完整配置。 */
function mergePluginConfig(raw) {
  const base = normalizeConfig(readJson(files.config(), defaultConfig()) ?? defaultConfig())
  if (!raw || typeof raw !== 'object') return base
  let next = base
  if (raw.enabled !== undefined) next = setPath(next, 'enabled', Boolean(raw.enabled))
  if (typeof raw.botId === 'string' && raw.botId.length > 0) next = setPath(next, 'bot.botId', raw.botId)
  if (typeof raw.ownerUserId === 'string' && raw.ownerUserId.length > 0) next = setPath(next, 'ownerUserId', raw.ownerUserId)
  if (raw.autoBind !== undefined) next = setPath(next, 'autoBind', Boolean(raw.autoBind))
  if (raw.approvalEnabled !== undefined) next = setPath(next, 'approval.enabled', Boolean(raw.approvalEnabled))
  if (raw.defaultTimeoutMin !== undefined) next = setPath(next, 'approval.defaultTimeoutMin', raw.defaultTimeoutMin)
  if (raw.watchIntervalSec !== undefined) next = setPath(next, 'watch.defaultIntervalSec', raw.watchIntervalSec)
  return normalizeConfig(next)
}

/** 详情文本（点「详情」按钮时回）。 */
function renderApprovalDetail(a) {
  const lines = [
    `**${a.icon ?? '🔐'} ${a.actionLabel}** \`${a.id.slice(-6)}\``,
    '',
    `- 风险：${a.risk}`,
    `- 阶段：${a.stage}`,
    `- 发起：${a.requestedBy?.name || a.requestedBy?.userId || '—'}`,
    `- 一级审批：${a.approvers.join('、') || '（无）'}`,
    `- 负责人：${a.owner || '—'}`,
  ]
  const d = a.detail ?? {}
  if (d.repo) lines.push(`- 仓库：${d.repo}`)
  if (d.branch) lines.push(`- 分支：${d.branch}`)
  if (d.diffStat) lines.push(`- 统计：${d.diffStat}`)
  if (d.command) lines.push(`- 命令：\`${d.command.slice(0, 300)}\``)
  if (Array.isArray(d.files) && d.files.length > 0) {
    lines.push('', '**改动文件**', ...d.files.slice(0, 10).map((f) => `- \`${f.status ?? ''}\` ${f.path ?? f}`))
    if (d.files.length > 10) lines.push(`- …还有 ${d.files.length - 10} 个`)
  }
  if (Array.isArray(d.commits) && d.commits.length > 0) {
    lines.push('', '**待推送提交**', ...d.commits.slice(0, 8).map((c) => `- \`${c.sha ?? ''}\` ${c.subject ?? ''}`))
  }
  if (d.extra) lines.push('', d.extra)
  if (a.phrase) lines.push('', `⚠️ 通过时需要输入确认短语：\`${a.phrase}\``)
  return lines.join('\n')
}

/** 日志适配器：DSH 的 logger 接口优先，否则 console。 */
function makeLogger(ctx) {
  const base = ctx?.logger
  const fmt = (msg, args) => {
    let i = 0
    return String(msg).replace(/%[sd]/g, () => {
      const v = args[i++]
      return typeof v === 'string' ? v : redactText(String(v ?? ''))
    })
  }
  const route = (level, msg, ...args) => {
    const text = fmt(`[wecom] ${msg}`, args)
    if (base && typeof base[level] === 'function') {
      try { base[level].call(base, text); return } catch { /* 落到 console */ }
    }
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else if (level === 'debug') { /* 静默 */ }
    else console.log(text)
  }
  // 同时支持两种调用风格：log.info(msg) 与 log('info', msg)
  const logger = {
    info: (msg, ...args) => route('info', msg, ...args),
    warn: (msg, ...args) => route('warn', msg, ...args),
    error: (msg, ...args) => route('error', msg, ...args),
    debug: (msg, ...args) => route('debug', msg, ...args),
  }
  logger.call = (level, msg, ...args) => route(level, msg, ...args)
  return logger
}

export default { name, inject, Config, apply }

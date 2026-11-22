/**
 * 本地 HTTP 路由：设置面板的数据接口 + 健康检查。
 *
 * 全部挂在 `/wecom-superagent/` 前缀下，并且**只接受本机请求**
 * （Origin/Referer 检查 + 回环地址检查），因为这里能改配置与连接机器人。
 *
 * 认证：设置页由 DSH 客户端加载，请求会带 DSH 的会话 cookie；
 * 我们额外要求一个随机 token（写在 state 文件里，客户端通过 DSH 的
 * 客户端插件通道拿到），防止其他网页跨站调用。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { normalizeConfig, configSchema, setPath } from './config.js'
import { readJson, writeJson, files, tailNdjson } from './core/state.js'
import { redactDeep, redactText } from './core/redact.js'
import { mergeRules } from './gate/rules.js'
import { WeComProvisioner, safeAuthUrl, deriveLocalBotId } from './wecom/provision.js'

const PREFIX = '/wecom-superagent'

/** 请求体解析失败的哨兵（区别于合法空对象 `{}`）。 */
const INVALID_JSON = Symbol('invalid-json')
/** 请求体超限的哨兵。 */
const TOO_LARGE = Symbol('too-large')

/**
 * 注册路由。
 * @param {object} params
 * @param {object} params.ctx
 * @param {object} params.deps
 * @param {(level: string, msg: string, ...a: unknown[]) => void} params.log
 * @returns {() => void} disposer
 */
export function registerHttp({ ctx, deps, log }) {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    log('warn', 'webServer 不可用，设置页接口未注册')
    const noop = () => {}
    noop.panelToken = loadOrCreateToken()
    return noop
  }
  const token = loadOrCreateToken()
  const disposers = []
  const provisioner = new WeComProvisioner()
  /** 已兑换的 scode（一次性，内存即可：过期后本来也不能再用） */
  const consumedScodes = new Set()

  /** 生成二维码 data URL；qrcode 未安装时降级成链接。 */
  async function renderQr(text) {
    try {
      const mod = await import('qrcode')
      const QR = mod.default ?? mod
      return await QR.toDataURL(text, { width: 340, margin: 2, errorCorrectionLevel: 'M' })
    } catch {
      return null
    }
  }

  const add = (kind, path, handler) => {
    disposers.push(ctx.webServer.register({ kind, path: `${PREFIX}${path}`, handler }))
  }

  // ---- 健康检查（不需要 token，方便排查）----
  add('exact', '/health', (req, res) => json(res, 200, {
    ok: true,
    online: deps.transport.isOnline,
    state: deps.transport.state,
    version: 1,
    at: new Date().toISOString(),
  }))

  // ---- 状态总览 ----
  add('exact', '/api/status', guarded(async (req, res) => {
    const config = deps.getConfig()
    const state = deps.getState()
    const secrets = deps.redactSecretsForUi(deps.readSecrets())
    json(res, 200, {
      online: deps.transport.isOnline,
      state: deps.transport.state,
      lastError: deps.transport.lastError,
      stats: deps.transport.stats,
      botId: config.bot.botId,
      ownerUserId: config.ownerUserId,
      enabled: config.enabled,
      secrets,
      bindings: Object.keys(state.bindings ?? {}).length,
      watchers: (state.watchers ?? []).map((w) => ({
        id: w.id, repo: w.repo, chatId: w.chatId, intervalMs: w.intervalMs,
        events: w.events, lastCheckAt: w.lastCheckAt, lastError: w.lastError, paused: w.paused,
      })),
      approvals: deps.approval.list().map(summarizeApproval),
    })
  }))

  // ---- 读取 / 保存配置（同一路径，按方法分发）----
  add('exact', '/api/config', guarded(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      return json(res, 200, { config: deps.getConfig(), schema: configSchema() })
    }
    if (method !== 'POST' && method !== 'PUT') return json(res, 405, { error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (body === TOO_LARGE) return json(res, 413, { error: '请求体过大（上限 256KB）' })
    if (body === INVALID_JSON) return json(res, 400, { error: 'invalid JSON' })
    // 只接受白名单字段，避免客户端篡改内部结构
    const allowed = new Set([
      'enabled', 'ownerUserId', 'secondOwners', 'people', 'defaultApprovers', 'allowedGroupIds',
      'autoBind', 'context', 'approval', 'watch', 'bot', 'ui', 'rules',
    ])
    let next = deps.getConfig()
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue
      // 逐键 setPath 更安全：保持默认值不被抹掉
      next = setPath(next, key, value)
    }
    next = normalizeConfig(next)
    deps.setConfig(next)
    audit('config.update', { keys: Object.keys(body) })
    json(res, 200, { ok: true, config: next })
  }))

  // ---- 设置机器人机密 ----
  add('exact', '/api/robot', guarded(async (req, res) => {
    const body = await readJsonBody(req)
    if (body === TOO_LARGE) return json(res, 413, { error: '请求体过大（上限 256KB）' })
    if (body === INVALID_JSON) return json(res, 400, { error: 'invalid JSON' })
    try {
      if (typeof body.botId === 'string' && body.botId.trim().length > 0) {
        deps.setConfig({ bot: { ...deps.getConfig().bot, botId: body.botId.trim() } })
      }
      if (typeof body.wsUrl === 'string') {
        deps.setConfig({ bot: { ...deps.getConfig().bot, wsUrl: body.wsUrl.trim() } })
      }
      if (typeof body.secret === 'string' && body.secret.trim().length > 0) {
        deps.setBotSecret(body.secret.trim())
      }
      if (typeof body.githubToken === 'string') {
        deps.setGithubToken(body.githubToken.trim())
      }
      if (body.connect === true) {
        const config = deps.getConfig()
        const secrets = deps.readSecrets()
        if (!config.bot.botId || !secrets.botSecret) {
          return json(res, 400, { error: '还缺少 botId 或 secret' })
        }
        await deps.transport.reconnect(config.bot.botId, secrets.botSecret, config.bot.wsUrl)
        deps.setConfig({ enabled: true })
      }
      audit('robot.update', { connect: body.connect === true })
      json(res, 200, {
        ok: true,
        online: deps.transport.isOnline,
        secrets: deps.redactSecretsForUi(deps.readSecrets()),
        botId: deps.getConfig().bot.botId,
      })
    } catch (error) {
      json(res, 400, { error: redactText(String(error?.message ?? error)) })
    }
  }))

  // ---- 连接控制 ----
  add('exact', '/api/connect', guarded(async (req, res) => {
    const body = await readJsonBody(req)
    const action = body?.action ?? 'connect'
    try {
      if (action === 'disconnect') {
        await deps.transport.disconnect()
        deps.setConfig({ enabled: false })
        return json(res, 200, { ok: true, online: false })
      }
      const config = deps.getConfig()
      const secrets = deps.readSecrets()
      if (!config.bot.botId || !secrets.botSecret) return json(res, 400, { error: '还缺少 botId 或 secret' })
      await deps.transport.reconnect(config.bot.botId, secrets.botSecret, config.bot.wsUrl)
      deps.setConfig({ enabled: true })
      json(res, 200, { ok: true, online: deps.transport.isOnline, state: deps.transport.state })
    } catch (error) {
      json(res, 400, { error: redactText(String(error?.message ?? error)) })
    }
  }))

  // ---- 审批列表 ----
  // ---- 审批：列表 / 历史 / 单条决策（同一前缀，按路径与方法分发）----
  add('prefix', '/api/approvals', guarded(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.slice(`${PREFIX}/api/approvals`.length).replace(/^\//, '')
    const method = (req.method ?? 'GET').toUpperCase()

    // GET /api/approvals          列表
    // GET /api/approvals/history  历史
    if (rest === '' || rest === 'history') {
      if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
      if (rest === 'history') {
        const rows = tailNdjson(files.audit(), 100).filter((r) => String(r.type ?? '').startsWith('approval.'))
        return json(res, 200, { history: rows.map((r) => redactDeep(r)) })
      }
      return json(res, 200, { approvals: deps.approval.list().map(summarizeApproval) })
    }

    // POST /api/approvals/<id>    决策
    if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    let id = ''
    try { id = decodeURIComponent(rest.split('/')[0] ?? '') } catch { return json(res, 400, { error: 'bad id' }) }
    if (id.length === 0) return json(res, 400, { error: '缺少审批 ID' })
    const body = await readJsonBody(req)
    if (body === TOO_LARGE) return json(res, 413, { error: '请求体过大（上限 256KB）' })
    if (!body || body === INVALID_JSON || typeof body.verdict !== 'string') return json(res, 400, { error: '需要 verdict' })
    // 从设置面板审批：身份只能是负责人（本地用户视为负责人）
    const config = deps.getConfig()
    const userId = typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : config.ownerUserId
    if (!userId) return json(res, 400, { error: '未配置负责人，无法从面板审批' })
    const result = deps.approval.decide({
      approvalId: id,
      userId,
      verdict: body.verdict === 'approve' ? 'approve' : 'reject',
      comment: typeof body.comment === 'string' ? body.comment.slice(0, 500) : '',
      phrase: typeof body.phrase === 'string' ? body.phrase : undefined,
    })
    json(res, result.ok ? 200 : 400, result.ok ? { ok: true, note: result.note ?? '' } : { error: result.reason })
  }))

  // ---- 守望管理 ----
  add('exact', '/api/watches', guarded(async (req, res) => {
    if (req.method === 'GET') {
      return json(res, 200, { watchers: deps.getState().watchers ?? [] })
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || !body.repo || typeof body.repo !== 'string') return json(res, 400, { error: '需要 repo' })
      if (body.op === 'remove') {
        const r = await deps.gitwatch.remove({ repo: body.repo, chatId: body.chatId })
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.reason })
      }
      if (body.op === 'pause' || body.op === 'resume') {
        const ok = deps.gitwatch.setPaused(body.id, body.op === 'pause')
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: '未找到守望' })
      }
      const r = await deps.gitwatch.add({
        repo: body.repo,
        chatId: body.chatId,
        chatType: body.chatType ?? 'single',
        addedBy: body.addedBy ?? 'panel',
        intervalMs: body.intervalSec ? body.intervalSec * 1000 : undefined,
        sessionId: body.sessionId,
        events: body.events,
      })
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, intervalMs: r.intervalMs } : { error: r.reason })
    }
    json(res, 405, { error: 'method not allowed' })
  }))

  // ---- 审计 ----
  add('exact', '/api/audit', guarded(async (req, res) => {
    const rows = tailNdjson(files.audit(), 200).map((r) => redactDeep(r))
    json(res, 200, { records: rows.reverse() })
  }))

  // ---- 会话 ID 一览（从入站记录里聚合）----
  // 用户不知道自己的 userid / chatId 是什么，这里直接把「谁在哪个会话里说过话」列出来。
  add('exact', '/api/identities', guarded(async (req, res) => {
    const rows = tailNdjson(files.audit(), 2000).filter((r) => r.type === 'inbound')
    /** @type {Map<string, object>} */
    const chats = new Map()
    /** @type {Map<string, object>} */
    const users = new Map()
    for (const r of rows) {
      const chatId = String(r.chatId ?? '')
      const senderId = String(r.senderId ?? '')
      if (chatId) {
        const cur = chats.get(chatId) ?? {
          chatId,
          chatType: r.chatType ?? 'single',
          title: r.chatTitle || (r.chatType === 'group' ? '' : (r.senderName || senderId)),
          lastAt: r.at,
          lastText: r.text ?? '',
          messages: 0,
          bound: Boolean(r.sessionId),
          members: new Set(),
        }
        cur.messages += 1
        if (r.at > (cur.lastAt ?? '')) { cur.lastAt = r.at; cur.lastText = r.text ?? '' }
        if (r.chatTitle) cur.title = r.chatTitle
        if (r.sessionId) cur.bound = true
        if (senderId) cur.members.add(r.senderName ? `${r.senderName} (${senderId})` : senderId)
        chats.set(chatId, cur)
      }
      if (senderId) {
        const cur = users.get(senderId) ?? {
          userId: senderId,
          name: r.senderName || '',
          lastAt: r.at,
          messages: 0,
          chats: new Set(),
        }
        cur.messages += 1
        if (r.senderName) cur.name = r.senderName
        if (chatId) cur.chats.add(chatId)
        users.set(senderId, cur)
      }
    }
    json(res, 200, {
      chats: [...chats.values()]
        .map((c) => ({ ...c, members: [...c.members] }))
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
      users: [...users.values()]
        .map((u) => ({ ...u, chats: [...u.chats] }))
        .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
    })
  }))

  // ---- 规则 ----
  add('exact', '/api/rules', guarded(async (req, res) => {
    json(res, 200, { rules: mergeRules(deps.getConfig().rules) })
  }))

  // ---- 一键创建机器人（扫码授权）----
  add('exact', '/api/provision/start', guarded(async (req, res) => {
    try {
      const started = await provisioner.start()
      const dataUrl = await renderQr(started.verificationUrl)
      audit('provision.start', { expiresAt: started.expiresAt })
      json(res, 200, {
        scode: started.scode,
        verificationUrl: started.verificationUrl,
        expiresAt: started.expiresAt,
        pollIntervalMs: started.pollIntervalMs,
        qrCodeDataUrl: dataUrl,
      })
    } catch (error) {
      audit('provision.start.failed', { error: redactText(String(error?.message ?? error)) })
      json(res, 502, { error: redactText(String(error?.message ?? error)) })
    }
  }))

  add('exact', '/api/provision/poll', guarded(async (req, res) => {
    const body = await readJsonBody(req)
    try {
      const result = await provisioner.poll({ scode: body?.scode })
      if (result.status === 'success') {
        if (typeof body?.scode === 'string') {
          // 同一个 scode 只兑现一次
          if (consumedScodes.has(body.scode)) {
            return json(res, 200, { status: 'failed', error: '这个二维码已经用过了' })
          }
          consumedScodes.add(body.scode)
        }
        // 写入凭据并连接
        deps.setConfig({ bot: { ...deps.getConfig().bot, botId: result.remoteBotId } })
        deps.setBotSecret(result.secret)
        deps.setConfig({ enabled: true })
        const config = deps.getConfig()
        let online = false
        try {
          await deps.transport.reconnect(config.bot.botId, result.secret, config.bot.wsUrl)
          online = deps.transport.isOnline
        } catch (error) {
          audit('provision.connect.failed', { error: redactText(String(error?.message ?? error)) })
        }
        audit('provision.success', { botId: result.remoteBotId, online })
        return json(res, 200, {
          status: 'success',
          botId: result.remoteBotId,
          localBotId: deriveLocalBotId(result.remoteBotId),
          online,
          secrets: deps.redactSecretsForUi(deps.readSecrets()),
        })
      }
      if (result.status === 'expired' || result.status === 'failed') {
        audit(`provision.${result.status}`, {})
      }
      json(res, 200, { status: result.status })
    } catch (error) {
      json(res, 502, { error: redactText(String(error?.message ?? error)) })
    }
  }))

  add('exact', '/api/provision/cancel', guarded(async (req, res) => {
    provisioner.cancel()
    json(res, 200, { ok: true })
  }))

  // ---- 测试卡片（验证链路是否通）----
  add('exact', '/api/test-card', guarded(async (req, res) => {
    const body = await readJsonBody(req)
    const chatId = body?.chatId
    if (!chatId) return json(res, 400, { error: '需要 chatId' })
    try {
      await deps.transport.sendCard(chatId, {
        card_type: 'text_notice',
        source: { desc: 'DSH', desc_color: 3 },
        main_title: { title: '✅ 链路正常', desc: '这是一条测试消息' },
        sub_title_text: '你在设置面板点了「发送测试卡片」，说明机器人在线、chatId 正确。',
      })
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 400, { error: redactText(String(error?.message ?? error)) })
    }
  }))

  // ---- 前端页面（单页）----
  add('exact', '/ui', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(renderPanelHtml(token))
  })
  add('prefix', '/ui/', (req, res) => {
    // 静态资源：全部内联在单页里，这里只为避免 404
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  const dispose = () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
  // 把面板令牌挂在 disposer 上：设置入口注入需要同一个令牌，避免两处生成两份。
  dispose.panelToken = token
  return dispose

  // ---------- helpers ----------

  /** 校验请求：本机 + token。 */
  function guarded(handler) {
    return async (req, res) => {
      try {
        if (!isLocalRequest(req)) return json(res, 403, { error: '只允许本机访问' })
        if (!checkToken(req, token)) return json(res, 401, { error: '缺少或错误的访问令牌' })
        await handler(req, res)
      } catch (error) {
        log('warn', 'HTTP 处理失败：%s', String(error?.message ?? error))
        try { json(res, 500, { error: redactText(String(error?.message ?? error)) }) } catch { /* ignore */ }
      }
    }
  }
}

/** 生成/读取面板 token（持久化，刷新页面不变）。 */
function loadOrCreateToken() {
  const file = files.state()
  const state = readJson(file, {}) ?? {}
  if (typeof state.panelToken === 'string' && state.panelToken.length >= 32) return state.panelToken
  const token = randomBytes(24).toString('hex')
  writeJson(file, { ...state, panelToken: token })
  return token
}

/** 只允许回环来源。 */
function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  const isLoopback = remote === '' || remote === '::1' || remote === '127.0.0.1' || remote.startsWith('127.') || remote === '::ffff:127.0.0.1'
  if (!isLoopback) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const host = new URL(origin).hostname
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return false
    } catch { return false }
  }
  return true
}

/** 校验 token（header 或 cookie）。 */
function checkToken(req, token) {
  const header = req.headers['x-wecom-token']
  if (typeof header === 'string' && safeEqual(header, token)) return true
  const cookie = req.headers.cookie
  if (typeof cookie === 'string') {
    const m = /(?:^|;\s*)wecom_panel=([a-f0-9]+)/.exec(cookie)
    if (m && safeEqual(m[1], token)) return true
  }
  // 开发便利：同一页面加载时用 query 传一次
  const url = req.url ?? ''
  const q = /[?&]token=([a-f0-9]+)/.exec(url)
  if (q && safeEqual(q[1], token)) return true
  return false
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/** 读请求体（限额 256KB）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      // 超限：不急着断连接（那样客户端只会看到网络错误），
      // 先标记成 too-large 并让调用方回 413；同时暂停接收。
      if (size > 256 * 1024) { done(TOO_LARGE); req.pause(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        done(text.trim().length === 0 ? {} : JSON.parse(text))
      } catch { done(INVALID_JSON) }
    })
    req.on('error', () => done(INVALID_JSON))
  })
}

function summarizeApproval(a) {
  return {
    id: a.id,
    action: a.action,
    actionLabel: a.actionLabel,
    icon: a.icon,
    risk: a.risk,
    stage: a.stage,
    summary: a.summary,
    requestedBy: a.requestedBy,
    approvers: a.approvers,
    owner: a.owner,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    decisions: a.decisions,
    detail: a.detail,
    phrase: a.phrase,
  }
}

function audit(type, payload) {
  import('./core/state.js').then(({ appendNdjson }) => {
    appendNdjson(files.audit(), { at: new Date().toISOString(), type, ...redactDeep(payload) })
  }).catch(() => {})
}

/** 单页设置面板（无构建步骤，纯原生）。 */
function renderPanelHtml(token) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>企业微信 Superagent 设置</title>
<style>
:root {
  --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --line: #2a3040;
  --text: #e6e9ef; --dim: #98a0b3; --accent: #4d6bfe; --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  --radius: 10px;
}
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7f9; --panel:#fff; --panel-2:#f0f2f5; --line:#e2e5ea; --text:#1a1d23; --dim:#5c6373; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif; }
header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; position:sticky; top:0; background:var(--bg); z-index:5; }
header h1 { font-size:16px; margin:0; font-weight:600; }
.dot { width:8px; height:8px; border-radius:50%; background:var(--dim); }
.dot.on { background:var(--ok); box-shadow:0 0 0 3px rgba(52,211,153,.18); }
.dot.err { background:var(--bad); }
main { max-width:1080px; margin:0 auto; padding:20px 24px 80px; }
nav { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:18px; flex-wrap:wrap; }
nav button { background:none; border:0; color:var(--dim); padding:10px 14px; cursor:pointer; border-bottom:2px solid transparent; font-size:14px; }
nav button.active { color:var(--text); border-bottom-color:var(--accent); }
section { display:none; } section.active { display:block; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; margin-bottom:14px; }
.card h3 { margin:0 0 10px; font-size:14px; font-weight:600; }
.row { display:flex; gap:12px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
.row > label { min-width:170px; color:var(--dim); font-size:13px; }
input[type=text], input[type=password], input[type=number], select, textarea {
  flex:1; min-width:180px; background:var(--panel-2); border:1px solid var(--line); color:var(--text);
  border-radius:8px; padding:8px 10px; font:inherit; outline:none;
}
input:focus, select:focus, textarea:focus { border-color:var(--accent); }
textarea { min-height:70px; resize:vertical; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
button.btn { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font:inherit; }
button.btn.ghost { background:transparent; border:1px solid var(--line); color:var(--text); }
button.btn.danger { background:var(--bad); }
button.btn:disabled { opacity:.5; cursor:not-allowed; }
.switch { position:relative; width:38px; height:22px; background:var(--panel-2); border:1px solid var(--line); border-radius:999px; cursor:pointer; flex:0 0 auto; }
.switch::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:var(--dim); transition:.15s; }
.switch.on { background:rgba(77,107,254,.25); border-color:var(--accent); }
.switch.on::after { left:18px; background:var(--accent); }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:var(--panel-2); border:1px solid var(--line); color:var(--dim); }
.pill.ok { color:var(--ok); border-color:rgba(52,211,153,.35); }
.pill.warn { color:var(--warn); border-color:rgba(251,191,36,.35); }
.pill.bad { color:var(--bad); border-color:rgba(248,113,113,.35); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:500; font-size:12px; }
tr:last-child td { border-bottom:0; }
code { background:var(--panel-2); padding:1px 6px; border-radius:5px; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
.muted { color:var(--dim); font-size:12.5px; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 18px; opacity:0; transition:.2s; pointer-events:none; }
.toast.show { opacity:1; }
.toast.err { border-color:var(--bad); color:var(--bad); }
.toast.ok { border-color:var(--ok); color:var(--ok); }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
@media (max-width:760px){ .grid2{grid-template-columns:1fr;} .row>label{min-width:100%;} }
.actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>企业微信 Superagent</h1>
  <span class="pill" id="connPill">未连接</span>
  <span style="flex:1"></span>
  <button class="btn ghost" id="refreshBtn">刷新</button>
</header>
<main>
  <nav id="tabs">
    <button data-tab="basic" class="active">接入</button>
    <button data-tab="people">成员与角色</button>
    <button data-tab="context">上下文增强</button>
    <button data-tab="approval">审批</button>
    <button data-tab="watch">仓库守望</button>
    <button data-tab="pending">待审批</button>
    <button data-tab="ids">会话 ID</button>
    <button data-tab="audit">审计</button>
  </nav>

  <section id="tab-basic" class="active">
    <div class="card" id="qrCard">
      <h3>一键创建机器人</h3>
      <p class="muted" style="margin-top:0">用手机企业微信扫码，在腾讯官方页面确认创建，凭据会自动填到这里。不需要手工复制 ID 和 Secret。</p>
      <div class="actions" style="margin-top:0">
        <button class="btn" id="startQr">生成二维码</button>
        <button class="btn ghost" id="cancelQr" style="display:none">取消</button>
      </div>
      <div id="qrPanel" style="display:none;margin-top:14px">
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
          <div style="background:#fff;padding:10px;border-radius:10px">
            <img id="qrImg" alt="企业微信二维码" width="220" height="220" style="display:block">
          </div>
          <div style="flex:1;min-width:220px">
            <p style="margin-top:0" id="qrStatus">请在手机上打开企业微信，扫描左侧二维码</p>
            <ol class="muted" style="padding-left:18px;margin:8px 0">
              <li>企业微信 → 右上角「+」→ 扫一扫</li>
              <li>在腾讯授权页点「创建智能机器人」</li>
              <li>回到这里，凭据会自动写入</li>
            </ol>
            <p class="muted" id="qrCountdown"></p>
            <p class="muted" style="word-break:break-all"><a id="qrLink" href="#" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">打不开二维码？点此在浏览器中打开授权页</a></p>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>机器人（手动）</h3>
      <div class="row"><label>机器人 ID (botId)</label><input type="text" id="botId" placeholder="企微管理后台 → 智能机器人"></div>
      <div class="row"><label>Secret</label><input type="password" id="secret" placeholder="填写后保存；界面只显示指纹"><span class="muted" id="secretState"></span></div>
      <div class="row"><label>WebSocket 地址</label><input type="text" id="wsUrl" placeholder="私有部署才需要，默认官方地址"><span class="muted">可选</span></div>
      <div class="row"><label>自动连接</label><div class="switch" id="enabled"></div><span class="muted">保存后尝试连接</span></div>
      <div class="actions">
        <button class="btn" id="saveRobot">保存并连接</button>
        <button class="btn ghost" id="connectBtn">连接</button>
        <button class="btn ghost" id="disconnectBtn">断开</button>
      </div>
      <p class="muted" style="margin-top:12px">机器人创建方式：企业微信管理后台 → 应用管理 → 智能机器人 → 创建，拿到 ID 与 Secret 填到这里。长连接模式不需要公网地址。</p>
    </div>
    <div class="card">
      <h3>链路自检</h3>
      <div class="row"><label>目标 chatId</label><input type="text" id="testChat" placeholder="单聊填 userid，群聊填 chatid"></div>
      <div class="actions"><button class="btn ghost" id="testCard">发送测试卡片</button></div>
      <p class="muted" style="margin-top:10px">会话 ID 的来源：让目标用户/群先给机器人发一条消息，然后看「审计」里的 inbound 记录。</p>
    </div>
  </section>

  <section id="tab-people">
    <div class="card">
      <h3>负责人</h3>
      <div class="row"><label>负责人 userId</label><input type="text" id="ownerUserId" placeholder="所有审批都必须经过他"><span class="pill warn">必填</span></div>
      <div class="row"><label>第二负责人</label><input type="text" id="secondOwners" placeholder="逗号分隔，发布/部署需要双签"><span class="muted">可选</span></div>
      <div class="row"><label>默认一级审批人</label><input type="text" id="defaultApprovers" placeholder="逗号分隔；留空=所有 approver 角色"></div>
      <div class="row"><label>允许的群 chatId</label><input type="text" id="allowedGroupIds" placeholder="逗号分隔；留空=所有群"></div>
      <div class="row"><label>自动绑定会话</label><div class="switch" id="autoBind"></div><span class="muted">新消息自动绑定到最近活跃会话</span></div>
      <div class="actions"><button class="btn" id="savePeople">保存</button></div>
    </div>
    <div class="card">
      <h3>成员与角色</h3>
      <table><thead><tr><th>userId</th><th>姓名</th><th>角色</th><th>备注</th><th></th></tr></thead><tbody id="peopleBody"></tbody></table>
      <div class="row" style="margin-top:12px">
        <input type="text" id="newUserId" placeholder="userid" style="flex:0 0 140px">
        <input type="text" id="newName" placeholder="姓名" style="flex:0 0 120px">
        <select id="newRole" style="flex:0 0 120px">
          <option value="operator">操作员</option>
          <option value="approver">审批人</option>
          <option value="owner">负责人</option>
          <option value="viewer">旁观者</option>
        </select>
        <button class="btn ghost" id="addPerson">添加</button>
      </div>
      <p class="muted" style="margin-top:8px">操作员：可下任务、发起审批；审批人：可审批一级节点；负责人：最终审批；旁观者：只能查询。</p>
    </div>
  </section>

  <section id="tab-context">
    <div class="card">
      <h3>注入到会话的上下文字段</h3>
      <div class="row"><label>渠道名称</label><input type="text" id="channelLabel" placeholder="企业微信"></div>
      <div class="row"><label>渠道</label><div class="switch" id="ctxChannel"></div><code>渠道: 企业微信</code></div>
      <div class="row"><label>会话类型</label><div class="switch" id="ctxChatType"></div><code>会话类型: 群聊</code></div>
      <div class="row"><label>会话标题</label><div class="switch" id="ctxChatTitle"></div><code>会话: 研发一组</code></div>
      <div class="row"><label>发送者昵称</label><div class="switch" id="ctxSender"></div><code>发送者: 张三 (zhangsan)</code></div>
      <div class="row"><label>发送时间</label><div class="switch" id="ctxTime"></div><code>时间: 2026-11-21 22:10:00</code></div>
      <div class="row"><label>消息 ID</label><div class="switch" id="ctxMsgId"></div><span class="muted">排查用，通常关闭</span></div>
      <div class="row"><label>时区</label><input type="text" id="timeZone" placeholder="留空使用系统时区，如 Asia/Shanghai"></div>
      <div class="actions"><button class="btn" id="saveContext">保存</button></div>
    </div>
    <div class="card">
      <h3>预览</h3>
      <pre id="ctxPreview" style="background:var(--panel-2);padding:12px;border-radius:8px;overflow:auto;font-size:12.5px;margin:0"></pre>
    </div>
  </section>

  <section id="tab-approval">
    <div class="card">
      <h3>审批闸</h3>
      <div class="row"><label>启用</label><div class="switch" id="approvalEnabled"></div><span class="muted">关闭后所有工具调用都不再询问（不建议）</span></div>
      <div class="row"><label>默认时限（分钟）</label><input type="number" id="defaultTimeout" min="1" max="1440"></div>
      <div class="actions"><button class="btn" id="saveApproval">保存</button></div>
    </div>
    <div class="card">
      <h3>动作规则</h3>
      <table><thead><tr><th>动作</th><th>风险</th><th>审批策略</th><th>时限</th><th>启用</th></tr></thead><tbody id="rulesBody"></tbody></table>
      <p class="muted" style="margin-top:10px">策略：primary=一级审批 · owner=负责人直审 · dual=一级+负责人 · owner2=负责人+第二负责人 · phrase=dual+确认短语 · none=不审（仍记审计）</p>
    </div>
  </section>

  <section id="tab-watch">
    <div class="card">
      <h3>守望列表</h3>
      <table><thead><tr><th>仓库</th><th>会话</th><th>间隔</th><th>事件</th><th>最近检查</th><th></th></tr></thead><tbody id="watchBody"></tbody></table>
    </div>
    <div class="card">
      <h3>新增守望</h3>
      <div class="row"><label>仓库</label><input type="text" id="watchRepo" placeholder="owner/name 或 D:\\path\\to\\repo"></div>
      <div class="row"><label>目标 chatId</label><input type="text" id="watchChat" placeholder="企微会话 ID"></div>
      <div class="row"><label>间隔（秒）</label><input type="number" id="watchInterval" value="60" min="30" max="3600"></div>
      <div class="actions"><button class="btn" id="addWatch">添加</button></div>
    </div>
  </section>

  <section id="tab-pending">
    <div class="card">
      <h3>待审批</h3>
      <div id="pendingList"></div>
    </div>
  </section>

  <section id="tab-ids">
    <div class="card">
      <h3>怎么用这一页</h3>
      <p class="muted" style="margin-top:0">
        先让目标的人<b>在企业微信里给机器人随便发一条消息</b>（比如「你好」），这里就会自动出现他的
        <code>userid</code> 和所在会话的 <code>chatId</code>。复制粘贴即可，不用去企微后台找。
      </p>
      <div class="actions" style="margin-top:0">
        <button class="btn" id="reloadIds">刷新</button>
      </div>
    </div>
    <div class="card">
      <h3>会话（chatId）</h3>
      <p class="muted" style="margin-top:0">单聊的 chatId 就是对方的 userid；群聊是企微给的群 ID。填到「仓库守望」或绑定会话时用这个。</p>
      <table><thead><tr><th>chatId</th><th>类型</th><th>名称</th><th>消息</th><th>已绑定</th><th></th></tr></thead><tbody id="chatsBody"></tbody></table>
    </div>
    <div class="card">
      <h3>成员（userid）</h3>
      <p class="muted" style="margin-top:0">填到「成员与角色」的 userid 用这个。</p>
      <table><thead><tr><th>userid</th><th>昵称</th><th>消息</th><th></th></tr></thead><tbody id="usersBody"></tbody></table>
    </div>
  </section>

  <section id="tab-audit">
    <div class="card">
      <h3>最近 200 条审计</h3>
      <table><thead><tr><th>时间</th><th>类型</th><th>动作/对象</th><th>结果</th></tr></thead><tbody id="auditBody"></tbody></table>
    </div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
let CONFIG = null;

const $ = (id) => document.getElementById(String(id));
const api = async (path, opts = {}) => {
  const r = await fetch('/wecom-superagent' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Wecom-Token': TOKEN, ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
};
const toast = (msg, kind = '') => {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast ' + kind; }, 2600);
};
const switchEl = (id, value, onChange) => {
  const el = $(id);
  el.classList.toggle('on', !!value);
  el.onclick = () => {
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    onChange && onChange(next);
  };
};
const lines = (v) => Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
const splitList = (s) => String(s || '').split(/[,，\\s]+/).map(x => x.trim()).filter(Boolean);

// ---- tabs ----
document.querySelectorAll('#tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'audit') loadAudit();
    if (btn.dataset.tab === 'ids') loadIdentities();
    if (btn.dataset.tab === 'pending') loadPending();
    if (btn.dataset.tab === 'watch') loadWatches();
  };
});

// ---- load ----
async function loadAll() {
  try {
    const [status, cfg] = await Promise.all([api('/api/status'), api('/api/config')]);
    CONFIG = cfg.config;
    renderStatus(status);
    renderConfig(cfg.config);
  } catch (e) { toast(e.message, 'err'); }
}
function renderStatus(s) {
  $('dot').className = 'dot ' + (s.online ? 'on' : (s.state === 'error' ? 'err' : ''));
  $('connPill').textContent = s.online ? '在线' : (s.state === 'error' ? '连接错误' : '未连接');
  $('connPill').className = 'pill ' + (s.online ? 'ok' : (s.state === 'error' ? 'bad' : ''));
  $('secretState').textContent = s.secrets.botSecret ? ('已保存 ' + s.secrets.botSecret.preview) : '未设置';
}
function renderConfig(c) {
  $('botId').value = c.bot.botId || '';
  $('wsUrl').value = c.bot.wsUrl || '';
  switchEl('enabled', c.enabled);
  $('ownerUserId').value = c.ownerUserId || '';
  $('secondOwners').value = lines(c.secondOwners);
  $('defaultApprovers').value = lines(c.defaultApprovers);
  $('allowedGroupIds').value = lines(c.allowedGroupIds);
  switchEl('autoBind', c.autoBind);
  $('channelLabel').value = c.context.channelLabel || '企业微信';
  switchEl('ctxChannel', c.context.includeChannel);
  switchEl('ctxChatType', c.context.includeChatType);
  switchEl('ctxChatTitle', c.context.includeChatTitle);
  switchEl('ctxSender', c.context.includeSender);
  switchEl('ctxTime', c.context.includeTime);
  switchEl('ctxMsgId', c.context.includeMessageId);
  $('timeZone').value = c.context.timeZone || '';
  switchEl('approvalEnabled', c.approval.enabled);
  $('defaultTimeout').value = c.approval.defaultTimeoutMin;
  renderPeople(c.people || []);
  renderRules(c.rules || {});
  updatePreview();
}
const ROLE_LABEL = { owner: '负责人', approver: '审批人', operator: '操作员', viewer: '旁观者' };
function renderPeople(people) {
  const body = $('peopleBody');
  body.innerHTML = '';
  if (people.length === 0) { body.innerHTML = '<tr><td colspan="5" class="muted">还没有成员。没有成员时，只有负责人能操作。</td></tr>'; return; }
  people.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + esc(p.userId) + '</code></td><td>' + esc(p.name || '') + '</td>'
      + '<td><span class="pill">' + esc(ROLE_LABEL[p.role] || p.role) + '</span></td>'
      + '<td class="muted">' + esc(p.note || '') + '</td><td></td>';
    const del = document.createElement('button');
    del.className = 'btn ghost'; del.textContent = '移除';
    del.onclick = async () => {
      const next = people.filter((_, j) => j !== i);
      await saveConfig({ people: next });
    };
    tr.lastChild.appendChild(del);
    body.appendChild(tr);
  });
}
const RISK_LABEL = { low: '低', medium: '中', high: '高', critical: '严重' };
function renderRules(rules) {
  const body = $('rulesBody');
  body.innerHTML = '';
  Object.entries(rules).forEach(([key, r]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + esc(key) + '</td><td>' + esc(RISK_LABEL[r.risk] || r.risk) + '</td>'
      + '<td><code>' + esc(r.approval) + '</code></td><td>' + (r.timeoutMin ?? 30) + ' 分钟</td>';
    const td = document.createElement('td');
    const sw = document.createElement('div');
    sw.className = 'switch' + (r.enabled === false ? '' : ' on');
    sw.onclick = async () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      const rules2 = JSON.parse(JSON.stringify(rules));
      rules2[key].enabled = next;
      await saveConfig({ rules: rules2 });
    };
    td.appendChild(sw);
    tr.appendChild(td);
    body.appendChild(tr);
  });
}
function updatePreview() {
  const c = CONFIG.context;
  const out = [];
  out.push('<wecom-context>');
  if (c.includeChannel) out.push('渠道: ' + (c.channelLabel || '企业微信'));
  if (c.includeChatType) out.push('会话类型: 群聊');
  if (c.includeChatTitle) out.push('会话: 研发一组');
  if (c.includeSender) out.push('发送者: 张三 (zhangsan) ［角色: operator］');
  if (c.includeTime) out.push('时间: ' + new Date().toLocaleString('sv-SE'));
  if (c.includeMessageId) out.push('消息ID: msg_xxx');
  out.push('</wecom-context>');
  $('ctxPreview').textContent = out.join('\\n');
}

// ---- save ----
async function saveConfig(patch) {
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    CONFIG = r.config;
    renderConfig(r.config);
    toast('已保存', 'ok');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
$('savePeople').onclick = () => saveConfig({
  ownerUserId: $('ownerUserId').value.trim(),
  secondOwners: splitList($('secondOwners').value),
  defaultApprovers: splitList($('defaultApprovers').value),
  allowedGroupIds: splitList($('allowedGroupIds').value),
  autoBind: $('autoBind').classList.contains('on'),
});
$('addPerson').onclick = async () => {
  const userId = $('newUserId').value.trim();
  if (!userId) return toast('userid 不能为空', 'err');
  const people = [...(CONFIG.people || []), { userId, name: $('newName').value.trim(), role: $('newRole').value }];
  if (await saveConfig({ people })) { $('newUserId').value = ''; $('newName').value = ''; }
};
$('saveContext').onclick = () => saveConfig({ context: {
  channelLabel: $('channelLabel').value.trim() || '企业微信',
  includeChannel: $('ctxChannel').classList.contains('on'),
  includeChatType: $('ctxChatType').classList.contains('on'),
  includeChatTitle: $('ctxChatTitle').classList.contains('on'),
  includeSender: $('ctxSender').classList.contains('on'),
  includeTime: $('ctxTime').classList.contains('on'),
  includeMessageId: $('ctxMsgId').classList.contains('on'),
  timeZone: $('timeZone').value.trim(),
}});
$('saveApproval').onclick = () => saveConfig({ approval: {
  ...CONFIG.approval,
  enabled: $('approvalEnabled').classList.contains('on'),
  defaultTimeoutMin: Number($('defaultTimeout').value) || 30,
}});
$('saveRobot').onclick = async () => {
  try {
    const body = {
      botId: $('botId').value.trim(),
      wsUrl: $('wsUrl').value.trim(),
      secret: $('secret').value.trim(),
      connect: true,
    };
    const r = await api('/api/robot', { method: 'POST', body: JSON.stringify(body) });
    $('secret').value = '';
    toast(r.online ? '已连接' : '已保存，但未连上', r.online ? 'ok' : 'err');
    await loadAll();
  } catch (e) { toast(e.message, 'err'); }
};
$('connectBtn').onclick = async () => {
  try { const r = await api('/api/connect', { method: 'POST', body: '{"action":"connect"}' }); toast(r.online ? '在线' : '连接中…', 'ok'); await loadAll(); }
  catch (e) { toast(e.message, 'err'); }
};
$('disconnectBtn').onclick = async () => {
  try { await api('/api/connect', { method: 'POST', body: '{"action":"disconnect"}' }); toast('已断开'); await loadAll(); }
  catch (e) { toast(e.message, 'err'); }
};
$('testCard').onclick = async () => {
  try { await api('/api/test-card', { method: 'POST', body: JSON.stringify({ chatId: $('testChat').value.trim() }) }); toast('已发送', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

// ---- watches ----
async function loadWatches() {
  try {
    const r = await api('/api/watches');
    const body = $('watchBody');
    body.innerHTML = '';
    (r.watchers || []).forEach((w) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + esc(w.repo) + '</code></td><td>' + esc(w.chatId) + '</td>'
        + '<td>' + Math.round(w.intervalMs / 1000) + 's</td><td>' + esc((w.events || []).join('/')) + '</td>'
        + '<td class="muted">' + esc(w.lastCheckAt ? new Date(w.lastCheckAt).toLocaleTimeString() : '—') + (w.lastError ? ' ⚠️' : '') + '</td>';
      const td = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn ghost'; del.textContent = '移除';
      del.onclick = async () => {
        try { await api('/api/watches', { method: 'POST', body: JSON.stringify({ op: 'remove', repo: w.repo, chatId: w.chatId }) }); await loadWatches(); }
        catch (e) { toast(e.message, 'err'); }
      };
      td.appendChild(del); tr.appendChild(td); body.appendChild(tr);
    });
    if (!(r.watchers || []).length) body.innerHTML = '<tr><td colspan="6" class="muted">还没有守望任何仓库。</td></tr>';
  } catch (e) { toast(e.message, 'err'); }
}
$('addWatch').onclick = async () => {
  try {
    await api('/api/watches', { method: 'POST', body: JSON.stringify({
      repo: $('watchRepo').value.trim(), chatId: $('watchChat').value.trim(),
      intervalSec: Number($('watchInterval').value) || 60,
    }) });
    toast('已添加', 'ok'); $('watchRepo').value = ''; await loadWatches();
  } catch (e) { toast(e.message, 'err'); }
};

// ---- pending ----
async function loadPending() {
  try {
    const r = await api('/api/approvals');
    const box = $('pendingList');
    box.innerHTML = '';
    if (!r.approvals.length) { box.innerHTML = '<p class="muted">没有待审批。</p>'; return; }
    r.approvals.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '10px';
      card.innerHTML = '<h3>' + esc(a.icon || '') + ' ' + esc(a.actionLabel) + ' <code>' + esc(a.id.slice(-6)) + '</code></h3>'
        + '<p>' + esc(a.summary || '') + '</p>'
        + '<p class="muted">发起：' + esc((a.requestedBy && (a.requestedBy.name || a.requestedBy.userId)) || '—')
        + ' · 阶段：' + esc(a.stage) + ' · 负责人：' + esc(a.owner || '—') + '</p>';
      const actions = document.createElement('div');
      actions.className = 'actions';
      const ok = document.createElement('button'); ok.className = 'btn'; ok.textContent = '通过';
      ok.onclick = () => decide(a, 'approve');
      const no = document.createElement('button'); no.className = 'btn danger'; no.textContent = '驳回';
      no.onclick = () => decide(a, 'reject');
      actions.appendChild(ok); actions.appendChild(no); card.appendChild(actions);
      box.appendChild(card);
    });
  } catch (e) { toast(e.message, 'err'); }
}
async function decide(a, verdict) {
  try {
    let phrase;
    if (verdict === 'approve' && a.phrase) { phrase = prompt('该动作需要确认短语：' + a.phrase); if (phrase === null) return; }
    const comment = prompt('审批意见（可留空）') || '';
    await api('/api/approvals/' + encodeURIComponent(a.id), { method: 'POST', body: JSON.stringify({ verdict, comment, phrase }) });
    toast('已记录', 'ok'); await loadPending();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- audit ----
async function loadAudit() {
  try {
    const r = await api('/api/audit');
    const body = $('auditBody');
    body.innerHTML = '';
    (r.records || []).forEach((rec) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="muted">' + esc(rec.at || '') + '</td><td><code>' + esc(rec.type || '') + '</code></td>'
        + '<td>' + esc(rec.action || rec.repo || rec.toolName || '') + '</td>'
        + '<td>' + esc(rec.outcome || rec.reason || '') + '</td>';
      body.appendChild(tr);
    });
    if (!(r.records || []).length) body.innerHTML = '<tr><td colspan="4" class="muted">暂无记录。</td></tr>';
  } catch (e) { toast(e.message, 'err'); }
}
// ---- 会话 ID ----
function copyBtn(text) {
  const b = document.createElement('button');
  b.className = 'btn ghost';
  b.textContent = '复制';
  b.onclick = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast('已复制：' + text, 'ok');
    } catch (e) { prompt('复制这段：', text); }
  };
  return b;
}
async function loadIdentities() {
  try {
    const r = await api('/api/identities');
    const chatsBody = $('chatsBody');
    chatsBody.innerHTML = '';
    (r.chats || []).forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + esc(c.chatId) + '</code></td>'
        + '<td>' + esc(c.chatType === 'group' ? '群聊' : '单聊') + '</td>'
        + '<td>' + esc(c.title || '—') + '</td>'
        + '<td>' + (c.messages || 0) + '</td>'
        + '<td>' + (c.bound ? '<span class="pill ok">已绑定</span>' : '<span class="pill">未绑定</span>') + '</td>';
      const td = document.createElement('td');
      td.appendChild(copyBtn(c.chatId));
      tr.appendChild(td);
      chatsBody.appendChild(tr);
    });
    if (!(r.chats || []).length) {
      chatsBody.innerHTML = '<tr><td colspan="6" class="muted">还没有收到任何消息。让目标用户在企业微信里给机器人发一条「你好」，回来点刷新。</td></tr>';
    }

    const usersBody = $('usersBody');
    usersBody.innerHTML = '';
    (r.users || []).forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + esc(u.userId) + '</code></td>'
        + '<td>' + esc(u.name || '—') + '</td>'
        + '<td>' + (u.messages || 0) + '</td>';
      const td = document.createElement('td');
      td.appendChild(copyBtn(u.userId));
      const add = document.createElement('button');
      add.className = 'btn ghost';
      add.style.marginLeft = '6px';
      add.textContent = '设为负责人';
      add.onclick = async () => {
        try {
          await api('/api/config', { method: 'POST', body: JSON.stringify({ ownerUserId: u.userId }) });
          toast('已把 ' + u.userId + ' 设为负责人', 'ok');
          await loadAll();
        } catch (e) { toast(e.message, 'err'); }
      };
      td.appendChild(add);
      tr.appendChild(td);
      usersBody.appendChild(tr);
    });
    if (!(r.users || []).length) {
      usersBody.innerHTML = '<tr><td colspan="4" class="muted">还没有收到任何消息。</td></tr>';
    }
  } catch (e) { toast(e.message, 'err'); }
}
$('reloadIds').onclick = () => loadIdentities();

$('refreshBtn').onclick = () => loadAll();

// ---- 扫码创建 ----
let qrTimer = null;
let qrDeadline = 0;
let qrScode = null;

function stopQr() {
  if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; }
  qrScode = null;
  $('qrPanel').style.display = 'none';
  $('cancelQr').style.display = 'none';
  $('startQr').disabled = false;
  $('startQr').textContent = '生成二维码';
}
async function startQr() {
  stopQr();
  $('startQr').disabled = true;
  $('startQr').textContent = '生成中…';
  try {
    const r = await api('/api/provision/start', { method: 'POST', body: '{}' });
    qrScode = r.scode;
    qrDeadline = r.expiresAt;
    if (r.qrCodeDataUrl) {
      $('qrImg').src = r.qrCodeDataUrl;
      $('qrImg').style.display = 'block';
    } else {
      $('qrImg').style.display = 'none';
    }
    $('qrLink').href = r.verificationUrl;
    $('qrPanel').style.display = 'block';
    $('cancelQr').style.display = 'inline-block';
    $('startQr').disabled = false;
    $('startQr').textContent = '重新生成';
    $('qrStatus').textContent = '请在手机上打开企业微信，扫描左侧二维码';
    tickCountdown();
    pollQr();
  } catch (e) {
    toast(e.message, 'err');
    stopQr();
  }
}
function tickCountdown() {
  const left = Math.max(0, Math.round((qrDeadline - Date.now()) / 1000));
  $('qrCountdown').textContent = left > 0 ? ('二维码 ' + left + ' 秒后过期') : '二维码已过期，请重新生成';
  if (left <= 0) stopQr();
  else setTimeout(tickCountdown, 1000);
}
async function pollQr() {
  if (!qrScode) return;
  try {
    const r = await api('/api/provision/poll', { method: 'POST', body: JSON.stringify({ scode: qrScode }) });
    if (r.status === 'success') {
      $('qrStatus').textContent = r.online ? '✅ 创建成功，机器人已上线！' : '✅ 凭据已保存（尚未连上）';
      stopQr();
      toast('机器人已创建', 'ok');
      await loadAll();
      return;
    }
    if (r.status === 'expired') { $('qrStatus').textContent = '二维码已过期，请重新生成'; stopQr(); return; }
    if (r.status === 'failed') { $('qrStatus').textContent = '授权失败：' + (r.error || '请重试'); stopQr(); return; }
  } catch (e) {
    // 网络抖动不终止，继续轮询
  }
  if (qrScode) qrTimer = setTimeout(pollQr, 3000);
}
$('startQr').onclick = startQr;
$('cancelQr').onclick = async () => {
  stopQr();
  try { await api('/api/provision/cancel', { method: 'POST', body: '{}' }); } catch {}
};
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

loadAll();
setInterval(async () => {
  try { const s = await api('/api/status'); renderStatus(s); } catch {}
}, 8000);
</script>
</body>
</html>`
}

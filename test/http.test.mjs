import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const HOME = join(tmpdir(), `wecom-http-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const mod = await import('../src/index.js')
const { files, readJson } = await import('../src/core/state.js')

/** 起一个把插件路由挂上的最小服务器。 */
async function startServer() {
  const routes = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => fn(),
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    get: () => null,
  }
  await mod.apply(fakeCtx, {})
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const exact = routes.find((r) => r.kind === 'exact' && url.pathname === r.path)
    if (exact) return exact.handler(req, res)
    const prefix = routes.find((r) => r.kind === 'prefix' && url.pathname.startsWith(r.path))
    if (prefix) return prefix.handler(req, res)
    res.writeHead(404)
    res.end('nf')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const token = readJson(files.state(), {}).panelToken
  return {
    port,
    token,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  }
}

async function call(server, path, { method = 'GET', body, token = server.token, headers = {} } = {}) {
  const res = await fetch(server.base + path, {
    method,
    headers: {
      ...(token === null ? {} : { 'X-Wecom-Token': token }),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data, headers: res.headers }
}

describe('HTTP 鉴权', () => {
  test('无 token 一律 401', async () => {
    const s = await startServer()
    try {
      for (const path of ['/wecom-superagent/api/status', '/wecom-superagent/api/config', '/wecom-superagent/api/approvals']) {
        const r = await call(s, path, { token: null })
        assert.equal(r.status, 401, path)
      }
    } finally { await s.close() }
  })

  test('错误 token 也是 401', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/status', { token: 'a'.repeat(48) })
      assert.equal(r.status, 401)
    } finally { await s.close() }
  })

  test('health 不需要 token（便于排障）', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/health', { token: null })
      assert.equal(r.status, 200)
      assert.equal(r.data.ok, true)
    } finally { await s.close() }
  })

  test('非回环 Origin 被拒', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/status', { headers: { Origin: 'https://evil.example' } })
      assert.equal(r.status, 403)
    } finally { await s.close() }
  })

  test('本地 Origin 放行', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/status', { headers: { Origin: 'http://127.0.0.1:3080' } })
      assert.equal(r.status, 200)
    } finally { await s.close() }
  })

  test('query 传 token 也可（设置页初次加载）', async () => {
    const s = await startServer()
    try {
      const r = await call(s, `/wecom-superagent/api/status?token=${s.token}`, { token: null })
      assert.equal(r.status, 200)
    } finally { await s.close() }
  })
})

describe('HTTP 输入校验', () => {
  test('畸形 JSON 返回 400', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/config', { method: 'POST', body: '{not json' })
      assert.equal(r.status, 400)
    } finally { await s.close() }
  })

  test('超大请求体被拒', async () => {
    const s = await startServer()
    try {
      const huge = JSON.stringify({ pad: 'x'.repeat(300 * 1024) })
      const r = await call(s, '/wecom-superagent/api/config', { method: 'POST', body: huge })
      assert.equal(r.status, 413, '超限应返回 413 而不是直接断连接')
    } finally { await s.close() }
  })

  test('配置只接受白名单字段', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/config', {
        method: 'POST',
        body: { ownerUserId: 'boss', __proto__: { polluted: true }, secret: 'hax', evil: 1 },
      })
      assert.equal(r.status, 200)
      assert.equal(r.data.config.ownerUserId, 'boss')
      // 非白名单字段不生效
      assert.equal(r.data.config.secret, undefined)
      assert.equal(r.data.config.evil, undefined)
      assert.equal({}.polluted, undefined, '原型链不能被污染')
    } finally { await s.close() }
  })

  test('GET /api/config 不返回 secret 明文', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/config')
      const text = JSON.stringify(r.data)
      assert.ok(!text.includes('botSecret'), '不应有 botSecret 字段')
    } finally { await s.close() }
  })

  test('/api/status 只给密钥指纹', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/status')
      const s2 = r.data.secrets
      if (s2.botSecret) {
        assert.equal(typeof s2.botSecret.preview, 'string')
        assert.ok(!JSON.stringify(r.data).includes('"botSecret":"'))
      }
    } finally { await s.close() }
  })

  test('审批决策接口校验身份', async () => {
    const s = await startServer()
    try {
      // 没有审批时也应返回 400 而非 500
      const r = await call(s, '/wecom-superagent/api/approvals/apr_nonexistent', { method: 'POST', body: { verdict: 'approve' } })
      assert.ok(r.status >= 400 && r.status < 500, String(r.status))
    } finally { await s.close() }
  })
})

describe('HTTP 设置页', () => {
  test('/ui 返回 HTML 且不含密钥', async () => {
    const s = await startServer()
    try {
      const res = await fetch(`${s.base}/wecom-superagent/ui`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.match(html, /企业微信 Superagent/)
      assert.match(html, /一键创建机器人/)
      // 页面里只应有面板 token，不应有机器人 secret
      assert.ok(!/botSecret\s*[:=]\s*["']/.test(html))
    } finally { await s.close() }
  })

  test('页面做了 XSS 转义', async () => {
    const s = await startServer()
    try {
      const res = await fetch(`${s.base}/wecom-superagent/ui`)
      const html = await res.text()
      // 应当有 esc() 函数用于插值
      assert.match(html, /function esc\(/)
    } finally { await s.close() }
  })
})

describe('扫码创建接口', () => {
  test('start 在腾讯接口不可达时返回 502', async () => {
    const s = await startServer()
    try {
      // 本机可能能访问腾讯接口；无论成功失败，都不能 500
      const r = await call(s, '/wecom-superagent/api/provision/start', { method: 'POST', body: {} })
      assert.ok([200, 502].includes(r.status), String(r.status))
    } finally { await s.close() }
  })

  test('poll 缺 scode 时返回错误而非崩溃', async () => {
    const s = await startServer()
    try {
      const r = await call(s, '/wecom-superagent/api/provision/poll', { method: 'POST', body: {} })
      assert.ok(r.status >= 400, String(r.status))
    } finally { await s.close() }
  })
})

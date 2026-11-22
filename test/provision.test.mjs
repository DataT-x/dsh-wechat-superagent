import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { WeComProvisioner, safeAuthUrl, deriveLocalBotId } from '../src/wecom/provision.js'

/** 假的 fetch：按 URL 返回预设响应。 */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, opts) => {
    const u = typeof url === 'string' ? url : url.toString()
    calls.push({ url: u, opts })
    for (const [pattern, responder] of routes) {
      if (u.includes(pattern)) {
        const data = typeof responder === 'function' ? responder(u) : responder
        return { ok: true, status: 200, json: async () => data }
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  fn.calls = calls
  return fn
}

describe('safeAuthUrl', () => {
  test('接受官方地址', () => {
    assert.equal(safeAuthUrl('https://work.weixin.qq.com/ai/qc/abc'), 'https://work.weixin.qq.com/ai/qc/abc')
  })
  test('接受显式 443 端口', () => {
    assert.ok(safeAuthUrl('https://work.weixin.qq.com:443/x'))
  })
  test('拒绝 http', () => {
    assert.equal(safeAuthUrl('http://work.weixin.qq.com/x'), null)
  })
  test('拒绝其他域名（钓鱼防护）', () => {
    assert.equal(safeAuthUrl('https://evil.com/work.weixin.qq.com'), null)
    assert.equal(safeAuthUrl('https://work.weixin.qq.com.evil.com/x'), null)
  })
  test('拒绝自定义端口', () => {
    assert.equal(safeAuthUrl('https://work.weixin.qq.com:8443/x'), null)
  })
  test('拒绝非 URL', () => {
    assert.equal(safeAuthUrl('javascript:alert(1)'), null)
    assert.equal(safeAuthUrl(''), null)
    assert.equal(safeAuthUrl(null), null)
  })
})

describe('deriveLocalBotId', () => {
  test('稳定且带前缀', () => {
    const a = deriveLocalBotId('bot-1')
    assert.equal(a, deriveLocalBotId('bot-1'))
    assert.ok(a.startsWith('wecom_'))
  })
  test('不同输入不同输出', () => {
    assert.notEqual(deriveLocalBotId('a'), deriveLocalBotId('b'))
  })
  test('不泄露原值', () => {
    assert.ok(!deriveLocalBotId('secret-bot-id').includes('secret'))
  })
})

describe('WeComProvisioner.start', () => {
  test('解析 scode 与授权页', async () => {
    const fetch = fakeFetch([['/ai/qc/generate', { data: { scode: 'sc-1', auth_url: 'https://work.weixin.qq.com/ai/qc/xyz' } }]])
    const p = new WeComProvisioner({ fetch })
    const r = await p.start()
    assert.equal(r.scode, 'sc-1')
    assert.equal(r.verificationUrl, 'https://work.weixin.qq.com/ai/qc/xyz')
    assert.ok(r.expiresAt > Date.now())
    assert.equal(r.pollIntervalMs, 3000)
  })

  test('请求参数带 source 与 plat', async () => {
    const fetch = fakeFetch([['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }]])
    const p = new WeComProvisioner({ fetch, source: 'my-app', platform: 3 })
    await p.start()
    const url = fetch.calls[0].url
    assert.match(url, /source=my-app/)
    assert.match(url, /plat=3/)
  })

  test('缺字段时报错', async () => {
    const fetch = fakeFetch([['/ai/qc/generate', { data: { scode: 's' } }]])
    await assert.rejects(() => new WeComProvisioner({ fetch }).start(), /不完整/)
  })

  test('授权页被替换成外域时报错（防劫持）', async () => {
    const fetch = fakeFetch([['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://evil.example/x' } }]])
    await assert.rejects(() => new WeComProvisioner({ fetch }).start(), /不完整/)
  })

  test('HTTP 非 200 时报错', async () => {
    const fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
    await assert.rejects(() => new WeComProvisioner({ fetch }).start(), /HTTP 500/)
  })
})

describe('WeComProvisioner.poll', () => {
  test('waiting', async () => {
    const fetch = fakeFetch([
      ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
      ['/ai/qc/query_result', { data: { status: 'waiting' } }],
    ])
    const p = new WeComProvisioner({ fetch })
    await p.start()
    assert.equal((await p.poll({ scode: 's' })).status, 'waiting')
  })

  test('success 返回 botid 与 secret', async () => {
    const fetch = fakeFetch([
      ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
      ['/ai/qc/query_result', { data: { status: 'success', bot_info: { botid: 'bot-1', secret: 'sec-1' } } }],
    ])
    const p = new WeComProvisioner({ fetch })
    await p.start()
    const r = await p.poll({ scode: 's' })
    assert.equal(r.status, 'success')
    assert.equal(r.remoteBotId, 'bot-1')
    assert.equal(r.secret, 'sec-1')
  })

  test('success 但缺凭证时报错', async () => {
    const fetch = fakeFetch([
      ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
      ['/ai/qc/query_result', { data: { status: 'success', bot_info: { botid: 'bot-1' } } }],
    ])
    const p = new WeComProvisioner({ fetch })
    await p.start()
    await assert.rejects(() => p.poll({ scode: 's' }), /botid\/secret/)
  })

  test('成功一次后会话被清空（不可重复兑换）', async () => {
    let n = 0
    const fetch = fakeFetch([
      ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
      ['/ai/qc/query_result', () => {
        n += 1
        return { data: { status: 'success', bot_info: { botid: 'b', secret: 'x'.repeat(10) } } }
      }],
    ])
    const p = new WeComProvisioner({ fetch })
    await p.start()
    await p.poll({ scode: 's' })
    assert.equal(p.session, null)
    assert.equal(n, 1)
  })

  test('expired / timeout 归一化', async () => {
    for (const status of ['expired', 'timeout']) {
      const fetch = fakeFetch([
        ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
        ['/ai/qc/query_result', { data: { status } }],
      ])
      const p = new WeComProvisioner({ fetch })
      await p.start()
      assert.equal((await p.poll({ scode: 's' })).status, 'expired', status)
    }
  })

  test('fail / error 归一化', async () => {
    for (const status of ['fail', 'failed', 'error', 'FAILED']) {
      const fetch = fakeFetch([
        ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
        ['/ai/qc/query_result', { data: { status } }],
      ])
      const p = new WeComProvisioner({ fetch })
      await p.start()
      assert.equal((await p.poll({ scode: 's' })).status, 'failed', status)
    }
  })

  test('本地已超时直接返回 expired，不再请求', async () => {
    let now = 1_000_000
    const fetch = fakeFetch([
      ['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }],
      ['/ai/qc/query_result', { data: { status: 'waiting' } }],
    ])
    const p = new WeComProvisioner({ fetch, clock: () => now })
    await p.start()
    now += 6 * 60_000
    assert.equal((await p.poll({ scode: 's' })).status, 'expired')
    assert.equal(fetch.calls.filter((c) => c.url.includes('query_result')).length, 0)
  })

  test('缺 scode 时报错', async () => {
    await assert.rejects(() => new WeComProvisioner({ fetch: fakeFetch([]) }).poll({}), /scode/)
  })

  test('cancel 清空会话', async () => {
    const fetch = fakeFetch([['/ai/qc/generate', { data: { scode: 's', auth_url: 'https://work.weixin.qq.com/x' } }]])
    const p = new WeComProvisioner({ fetch })
    await p.start()
    assert.equal(p.active, true)
    p.cancel()
    assert.equal(p.active, false)
  })
})

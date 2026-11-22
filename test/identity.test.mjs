import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const HOME = join(tmpdir(), `wecom-ident-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { Router, loadState } = await import('../src/core/router.js')

const CONFIG = {
  ownerUserId: 'boss',
  people: [{ userId: 'boss', role: 'owner' }, { userId: 'g1', role: 'operator' }, { userId: 'u1', role: 'operator' }],
  context: { includeChannel: true, includeChatTitle: true, includeSender: true, includeChatType: true, includeTime: true },
  watch: {},
}

function makeRouter() {
  const state = loadState()
  const agent = {
    id: 's1', status: 'idle', session: { id: 's1', meta: { cwd: process.cwd() } },
    got: [], followup(m) { this.got.push(m) }, steer(m) { this.got.push(m) },
  }
  const router = new Router({ getConfig: () => CONFIG, state, resolveAgent: () => agent, log: () => {} })
  router.saveState = () => {}
  const sent = []
  router.on('outbound', ({ text }) => sent.push(text))
  return { router, state, agent, sent }
}

describe('身份学习', () => {
  test('从 from.name 学到昵称', async () => {
    const { router, state } = makeRouter()
    state.bindings.u1 = 's1'
    await router.handleMessage({
      headers: { req_id: 'r1' },
      body: { msgid: 'm1', chattype: 'single', from: { userid: 'u1', name: '张三' }, msgtype: 'text', text: { content: 'hi' } },
    })
    assert.equal(state.names.u1, '张三')
  })

  test('从 chatname 学到群名', async () => {
    const { router, state } = makeRouter()
    state.bindings.g1 = 's1'
    await router.handleMessage({
      headers: { req_id: 'r2' },
      body: { msgid: 'm2', chatid: 'g1', chatname: '研发一组', chattype: 'group', from: { userid: 'u1', name: '张三' }, msgtype: 'text', text: { content: 'hi' } },
    })
    assert.equal(state.titles.g1, '研发一组')
  })

  test('学到的昵称会出现在上下文里', async () => {
    const { router, state, agent } = makeRouter()
    state.bindings.u1 = 's1'
    state.names.u1 = '张三'
    await router.handleMessage({
      headers: { req_id: 'r3' },
      body: { msgid: 'm3', chattype: 'single', from: { userid: 'u1' }, msgtype: 'text', text: { content: '改个 bug' } },
    })
    const text = agent.got[0].content[0].text
    assert.match(text, /发送者: 张三 \(u1\)/)
  })

  test('群名会出现在上下文里', async () => {
    const { router, state, agent } = makeRouter()
    state.bindings.g1 = 's1'
    state.titles.g1 = '研发一组'
    await router.handleMessage({
      headers: { req_id: 'r4' },
      body: { msgid: 'm4', chatid: 'g1', chattype: 'group', from: { userid: 'u1' }, msgtype: 'text', text: { content: '看看这个' } },
    })
    const text = agent.got[0].content[0].text
    assert.match(text, /会话: 研发一组/)
  })

  test('昵称超长被截断', async () => {
    const { router, state } = makeRouter()
    state.bindings.u1 = 's1'
    await router.handleMessage({
      headers: { req_id: 'r5' },
      body: { msgid: 'm5', chattype: 'single', from: { userid: 'u1', name: 'X'.repeat(200) }, msgtype: 'text', text: { content: 'hi' } },
    })
    assert.ok(state.names.u1.length <= 64)
  })

  test('没有昵称时不写入垃圾值', async () => {
    const { router, state } = makeRouter()
    state.bindings.u1 = 's1'
    await router.handleMessage({
      headers: { req_id: 'r6' },
      body: { msgid: 'm6', chattype: 'single', from: { userid: 'u1', name: '   ' }, msgtype: 'text', text: { content: 'hi' } },
    })
    assert.equal(state.names.u1, undefined)
  })

  test('昵称表有上限', async () => {
    const { router, state } = makeRouter()
    for (let i = 0; i < 600; i++) state.names[`u${i}`] = `名字${i}`
    state.bindings.u1 = 's1'
    await router.handleMessage({
      headers: { req_id: 'r7' },
      body: { msgid: 'm7', chattype: 'single', from: { userid: 'u1', name: '新名字' }, msgtype: 'text', text: { content: 'hi' } },
    })
    assert.ok(Object.keys(state.names).length <= 500, String(Object.keys(state.names).length))
  })
})

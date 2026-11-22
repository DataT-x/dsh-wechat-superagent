import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const HOME = join(tmpdir(), `wecom-router-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { Router, loadState } = await import('../src/core/router.js')

/** 假的 agent：记录收到的消息。 */
function fakeAgent(sessionId = 'session-1') {
  return {
    id: sessionId,
    status: 'idle',
    session: { id: sessionId, meta: { cwd: process.cwd() } },
    received: [],
    followup(msg) { this.received.push({ kind: 'followup', msg }) },
    steer(msg) { this.received.push({ kind: 'steer', msg }) },
    cancel() { this.received.push({ kind: 'cancel' }) },
  }
}

const CONFIG = {
  ownerUserId: 'boss',
  defaultApprovers: ['alice'],
  people: [
    { userId: 'boss', role: 'owner', name: '老板' },
    { userId: 'alice', role: 'approver', name: '爱丽丝' },
    // 单聊里会话 ID 就是发送者 userid，所以测试里让操作员直接用 chat-1
    { userId: 'chat-1', role: 'operator', name: '鲍勃' },
    { userId: 'g-member', role: 'operator', name: '群成员' },
    { userId: 'eve', role: 'viewer' },
  ],
  allowedGroupIds: [],
  context: { channelLabel: '企业微信', includeChannel: true, includeChatType: true, includeChatTitle: true, includeSender: true, includeTime: true },
  watch: { maxWatchesPerChat: 6, defaultIntervalSec: 60 },
}

function frame(text, { chatId = 'chat-1', chatType = 'single', sender = 'chat-1', msgid } = {}) {
  // 长连接帧：单聊没有 chatid（会话就是发送者本人），群聊才有 chatid
  return {
    headers: { req_id: `req-${Math.random().toString(36).slice(2)}` },
    body: {
      msgid: msgid ?? `msg-${Math.random().toString(36).slice(2)}`,
      ...(chatType === 'group' ? { chatid: chatId } : {}),
      chattype: chatType,
      from: { userid: sender },
      msgtype: 'text',
      text: { content: text },
    },
  }
}

function setup({ bindChat = true, agent } = {}) {
  const state = loadState()
  if (bindChat) state.bindings['chat-1'] = 'session-1'
  const a = agent ?? fakeAgent()
  const sent = []
  const router = new Router({
    getConfig: () => CONFIG,
    state,
    resolveAgent: (id) => (id === 'session-1' ? a : null),
    log: () => {},
  })
  router.on('outbound', ({ frame: f, chatId, text }) => sent.push({ chatId, text }))
  router.saveState = () => {}
  return { router, state, agent: a, sent }
}

describe('普通消息 → 唤醒会话', () => {
  test('已绑定会话时注入 followup', async () => {
    const { router, agent, sent } = setup()
    await router.handleMessage(frame('修复登录页'))
    assert.equal(agent.received.length, 1)
    assert.equal(agent.received[0].kind, 'followup')
    const text = agent.received[0].msg.content[0].text
    assert.match(text, /<wecom-context>/)
    assert.match(text, /修复登录页/)
    assert.match(text, /发送者: chat-1/)
    // 首次会回一句「已收到」
    assert.ok(sent.some((s) => s.text.includes('已收到')))
  })

  test('会话忙碌时用 steer 而不是 followup', async () => {
    const agent = fakeAgent()
    agent.status = 'running'
    const { router } = setup({ agent })
    await router.handleMessage(frame('加个需求'))
    assert.equal(agent.received[0].kind, 'steer')
  })

  test('未绑定会话时提示如何绑定', async () => {
    const { router, agent, sent } = setup({ bindChat: false })
    await router.handleMessage(frame('你好'))
    assert.equal(agent.received.length, 0)
    assert.ok(sent.some((s) => s.text.includes('/wecom bind')))
  })

  test('绑定的会话已消失时自动解绑并提示', async () => {
    const state = loadState()
    state.bindings['chat-1'] = 'gone-session'
    const router = new Router({
      getConfig: () => CONFIG, state, resolveAgent: () => null, log: () => {},
    })
    router.saveState = () => {}
    const sent = []
    router.on('outbound', ({ text }) => sent.push(text))
    await router.handleMessage(frame('在吗'))
    assert.ok(sent.some((t) => t.includes('不存在') || t.includes('重新绑定')))
    assert.equal(state.bindings['chat-1'], undefined)
  })

  test('无权限的人被拒绝，且不唤醒会话', async () => {
    const { router, agent, sent } = setup()
    await router.handleMessage(frame('帮我删库', { sender: 'stranger' }))
    assert.equal(agent.received.length, 0)
    assert.ok(sent.some((s) => s.text.includes('⛔')))
  })

  test('旁观者不能下命令', async () => {
    const { router, agent } = setup()
    await router.handleMessage(frame('去改代码', { sender: 'eve' }))
    assert.equal(agent.received.length, 0)
  })

  test('重复消息只处理一次（去重）', async () => {
    const { router, agent } = setup()
    const f = frame('同一句话', { msgid: 'fixed-id' })
    await router.handleMessage(f)
    await router.handleMessage(f)
    await router.handleMessage(f)
    assert.equal(agent.received.length, 1)
  })

  test('空消息被忽略', async () => {
    const { router, agent } = setup()
    await router.handleMessage(frame('   '))
    assert.equal(agent.received.length, 0)
  })

  test('群聊消息也带上下文', async () => {
    const { router, agent } = setup()
    const state = router.state
    state.titles['group-1'] = '研发一组'
    state.bindings['group-1'] = 'session-1'
    await router.handleMessage(frame('看下这个', { chatId: 'group-1', chatType: 'group' }))
    const text = agent.received[0].msg.content[0].text
    assert.match(text, /会话类型: 群聊/)
    assert.match(text, /会话: 研发一组/)
  })
})

describe('聊天内指令', () => {
  test('/help 返回帮助', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/help'))
    assert.ok(sent.some((s) => s.text.includes('企业微信 Superagent 指令')))
  })

  test('/status 显示绑定与角色', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/status'))
    const text = sent.map((s) => s.text).join('\n')
    assert.match(text, /绑定会话/)
    assert.match(text, /operator/)
  })

  test('/stop 取消当前任务', async () => {
    const { router, agent } = setup()
    await router.handleMessage(frame('/stop'))
    assert.ok(agent.received.some((r) => r.kind === 'cancel'))
  })

  test('/pending 无待办时给友好提示', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/pending', { sender: 'alice' }))
    assert.ok(sent.some((s) => s.text.includes('没有待你处理')))
  })

  test('操作员不能看审批待办', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/pending', { sender: 'chat-1' }))
    assert.ok(sent.some((s) => s.text.includes('⛔')))
  })

  test('/approve 缺参数给用法提示', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/approve', { sender: 'alice' }))
    assert.ok(sent.some((s) => s.text.includes('用法')))
  })

  test('未知指令给提示', async () => {
    const { router, sent } = setup()
    await router.handleMessage(frame('/nonexistent', { sender: 'zzz' }))
    assert.ok(sent.length >= 1)
  })
})

describe('指令与审批联动', () => {
  test('/approve 走审批引擎', async () => {
    const { ApprovalEngine } = await import('../src/core/approval.js')
    const approval = new ApprovalEngine({ getConfig: () => CONFIG, getSigningSecret: () => 's', log: () => {} })
    const a = approval.create({
      action: 'git.push', risk: 'high', approvalPolicy: 'dual',
      detail: {}, summary: 'x', requestedBy: { userId: 'bob', chatId: 'chat-1' },
    })
    const state = loadState()
    state.bindings['chat-1'] = 'session-1'
    const router = new Router({
      getConfig: () => CONFIG, state, resolveAgent: () => fakeAgent(), log: () => {}, approval,
    })
    router.saveState = () => {}
    const sent = []
    router.on('outbound', ({ text }) => sent.push(text))
    const code = a.id.slice(-6)
    await router.handleMessage(frame(`/approve ${code}`, { sender: 'alice' }))
    assert.equal(a.stage, 'pending-owner')
    assert.ok(sent.some((t) => t.includes('已通过')))

    await router.handleMessage(frame(`/reject ${code} 不行`, { sender: 'boss' }))
    assert.equal(a.stage, 'rejected')
  })
})

describe('串行队列', () => {
  test('同一会话的消息按顺序处理', async () => {
    const { router, agent } = setup()
    const order = []
    const orig = agent.followup.bind(agent)
    agent.followup = (msg) => {
      order.push(msg.content[0].text.split('\n').pop())
      orig(msg)
    }
    await Promise.all([
      router.handleMessage(frame('第一条')),
      router.handleMessage(frame('第二条')),
      router.handleMessage(frame('第三条')),
    ])
    assert.deepEqual(order, ['第一条', '第二条', '第三条'])
  })
})

describe('loadState', () => {
  test('缺失字段补齐默认值', () => {
    const s = loadState()
    assert.deepEqual(s.bindings, {})
    assert.deepEqual(s.watchers, [])
    assert.deepEqual(s.titles, {})
  })
})

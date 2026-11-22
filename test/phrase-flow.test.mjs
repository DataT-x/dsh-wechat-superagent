import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const HOME = join(tmpdir(), `wecom-phrase-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { Router, loadState } = await import('../src/core/router.js')
const { ApprovalEngine } = await import('../src/core/approval.js')

const CONFIG = {
  ownerUserId: 'boss',
  defaultApprovers: ['alice'],
  people: [
    { userId: 'boss', role: 'owner' },
    { userId: 'alice', role: 'approver' },
    { userId: 'chat-1', role: 'operator' },
  ],
  context: {},
  watch: {},
}

function frame(text, { chatType = 'single', sender = 'chat-1', msgid } = {}) {
  return {
    headers: { req_id: `r-${Math.random().toString(36).slice(2)}` },
    body: {
      msgid: msgid ?? `m-${Math.random().toString(36).slice(2)}`,
      chattype: chatType,
      from: { userid: sender },
      msgtype: 'text',
      text: { content: text },
    },
  }
}

function setup() {
  const approval = new ApprovalEngine({ getConfig: () => CONFIG, getSigningSecret: () => 's', log: () => {} })
  const state = loadState()
  state.bindings['chat-1'] = 'sess-1'
  const router = new Router({
    getConfig: () => CONFIG,
    state,
    resolveAgent: () => null,
    log: () => {},
    approval,
  })
  router.saveState = () => {}
  const sent = []
  router.on('outbound', ({ text }) => sent.push(text))
  return { router, approval, sent }
}

describe('确认短语两级交互', () => {
  test('/approve 后要求单独发短语', async () => {
    const { router, approval, sent } = setup()
    const a = approval.create({
      action: 'git.force-push', risk: 'critical', approvalPolicy: 'phrase',
      detail: {}, summary: '强推', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'alice' }))
    assert.equal(a.stage, 'pending-primary', '还不应通过')
    assert.ok(sent.some((t) => t.includes('确认短语')), sent.join('\n'))
    // 短语还没输入，不能通过
    assert.equal(a.decisions.length, 0)
  })

  test('发错短语会取消', async () => {
    const { router, approval, sent } = setup()
    const a = approval.create({
      action: 'git.force-push', risk: 'critical', approvalPolicy: 'phrase',
      detail: {}, summary: '强推', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'alice' }))
    await router.handleMessage(frame('随便写点什么', { sender: 'alice' }))
    assert.equal(a.stage, 'pending-primary')
    assert.ok(sent.some((t) => t.includes('已取消')))
  })

  test('发对短语后通过', async () => {
    const { router, approval, sent } = setup()
    const a = approval.create({
      action: 'git.force-push', risk: 'critical', approvalPolicy: 'phrase',
      detail: {}, summary: '强推', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'alice' }))
    await router.handleMessage(frame('确认强推', { sender: 'alice' }))
    assert.equal(a.stage, 'pending-owner', '一级通过，进入负责人')
    assert.ok(sent.some((t) => t.includes('已通过')))
  })

  test('非短语动作直接通过', async () => {
    const { router, approval } = setup()
    const a = approval.create({
      action: 'git.push', risk: 'high', approvalPolicy: 'dual',
      detail: {}, summary: '推送', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'alice' }))
    assert.equal(a.stage, 'pending-owner')
  })

  test('不要审批的人发起短语流程', async () => {
    const { router, approval, sent } = setup()
    const a = approval.create({
      action: 'git.force-push', risk: 'critical', approvalPolicy: 'phrase',
      detail: {}, summary: '强推', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'chat-1' }))
    assert.equal(a.stage, 'pending-primary')
    assert.ok(sent.some((t) => t.includes('⛔')))
  })

  test('短语等待超时', async () => {
    const { router, approval, sent } = setup()
    const a = approval.create({
      action: 'git.push', risk: 'critical', approvalPolicy: 'phrase',
      detail: {}, summary: 'x', requestedBy: { userId: 'chat-1', chatId: 'chat-1' },
    })
    await router.handleMessage(frame(`/approve ${a.id.slice(-6)}`, { sender: 'alice' }))
    // 单聊时 chatId 就是发送者本人，所以等待键是 alice:alice
    const w = router.pendingPhrase.get('alice:alice')
    assert.ok(w, '应进入等待短语状态')
    w.at = Date.now() - 3 * 60_000
    await router.handleMessage(frame('确认推送代码', { sender: 'alice' }))
    assert.ok(sent.some((t) => t.includes('超时')), sent.join('\n---\n'))
  })
})

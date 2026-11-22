import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const HOME = join(tmpdir(), `wecom-native-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { NativeApprovalBridge } = await import('../src/host/native-approval.js')
const { ApprovalEngine } = await import('../src/core/approval.js')

const CONFIG = {
  ownerUserId: 'boss',
  defaultApprovers: ['alice'],
  people: [
    { userId: 'boss', role: 'owner' },
    { userId: 'alice', role: 'approver' },
    { userId: 'bob', role: 'operator' },
  ],
  approval: { enabled: true },
  rules: {},
}

function setup({ online = true, origin = { chatId: 'chat-1', chatType: 'single', senderId: 'bob' }, deliverFails = false } = {}) {
  const approval = new ApprovalEngine({ getConfig: () => CONFIG, getSigningSecret: () => 's', log: () => {} })
  const delivered = []
  const gate = {
    originOf: (sessionId) => (sessionId === 'sess-1' ? origin : null),
  }
  const bridge = new NativeApprovalBridge({
    getConfig: () => CONFIG,
    approval,
    gate,
    transport: { isOnline: online },
    deliver: async (payload) => {
      if (deliverFails) throw new Error('send failed')
      delivered.push(payload)
    },
    update: async () => {},
    log: () => {},
    isEnabled: () => online,
  })
  return { approval, bridge, delivered }
}

/** 构造 DSH 的 ApprovalRequestEvent。 */
function req(overrides = {}) {
  return {
    agent: { session: { id: 'sess-1' } },
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要写权限来安装依赖',
    ...overrides,
  }
}

describe('NativeApprovalBridge 接管条件', () => {
  test('机器人离线时交还 DSH', async () => {
    const { bridge } = setup({ online: false })
    let called = false
    const outcome = await bridge.handle(req(), async () => { called = true; return 'unavailable' })
    assert.equal(called, true)
    assert.equal(outcome, 'unavailable')
  })

  test('会话不来自企微时交还 DSH', async () => {
    const { bridge } = setup({ origin: null })
    let called = false
    const outcome = await bridge.handle(req(), async () => { called = true; return 'unavailable' })
    assert.equal(called, true)
    assert.equal(outcome, 'unavailable')
  })

  test('没有 agent/session 时交还', async () => {
    const { bridge } = setup()
    let called = false
    await bridge.handle({ toolName: 'bash' }, async () => { called = true; return 'unavailable' })
    assert.equal(called, true)
  })
})

describe('NativeApprovalBridge 决策映射', () => {
  let ctx
  beforeEach(() => { ctx = setup() })

  test('企微通过 → allowed-once', async () => {
    const { bridge, approval, delivered } = ctx
    const p = bridge.handle(req(), async () => 'unavailable')
    // 等卡片送出后审批
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(delivered.length, 1)
    const a = approval.list()[0]
    approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    approval.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(await p, 'allowed-once')
  })

  test('企微驳回 → rejected', async () => {
    const { bridge, approval } = ctx
    const p = bridge.handle(req(), async () => 'unavailable')
    await new Promise((r) => setTimeout(r, 20))
    const a = approval.list()[0]
    approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject', comment: '不用装' })
    assert.equal(await p, 'rejected')
  })

  test('cancel → cancelled', async () => {
    const { bridge, approval } = ctx
    const p = bridge.handle(req(), async () => 'unavailable')
    await new Promise((r) => setTimeout(r, 20))
    const a = approval.list()[0]
    approval.cancel(a.id, '用户中断')
    assert.equal(await p, 'cancelled')
  })

  test('abort signal 触发 cancelled', async () => {
    const { bridge } = ctx
    const ac = new AbortController()
    const p = bridge.handle(req({ signal: ac.signal }), async () => 'unavailable')
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    assert.equal(await p, 'cancelled')
  })

  test('发送失败 → 交还 DSH（不吞掉）', async () => {
    const { bridge } = setup({ deliverFails: true })
    let called = false
    const outcome = await bridge.handle(req(), async () => { called = true; return 'unavailable' })
    assert.equal(called, true)
    assert.equal(outcome, 'unavailable')
  })

  test('卡片里带工具名与原因', async () => {
    const { bridge, delivered } = ctx
    const p = bridge.handle(req({ toolName: 'pwsh', reason: '要执行构建脚本' }), async () => 'unavailable')
    await new Promise((r) => setTimeout(r, 20))
    const a = delivered[0].approval
    assert.equal(a.toolName, 'pwsh')
    assert.match(a.summary, /构建脚本/)
    assert.equal(a.detail.source, 'dsh-native')
    // 清理：让 promise 结束
    approvalOf(p, ctx.approval)
  })

  test('空 reason 也能给出可用摘要', async () => {
    const { bridge, delivered } = ctx
    const p = bridge.handle(req({ reason: undefined }), async () => 'unavailable')
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(delivered[0].approval.summary.length > 0)
    approvalOf(p, ctx.approval)
  })
})

/** 结束挂起的 promise，避免测试进程挂住。 */
function approvalOf(promise, approval) {
  const a = approval.list()[0]
  if (a) approval.cancel(a.id, 'cleanup')
  return promise.catch(() => {})
}

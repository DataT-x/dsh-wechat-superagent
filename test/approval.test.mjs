import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// 每个测试用独立数据目录
const HOME = join(tmpdir(), `wecom-test-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { ApprovalEngine, clampTimeout } = await import('../src/core/approval.js')

let engine
let config

function makeEngine(overrides = {}) {
  config = {
    ownerUserId: 'boss',
    secondOwners: ['boss2'],
    defaultApprovers: ['alice'],
    people: [
      { userId: 'boss', role: 'owner', name: '老板' },
      { userId: 'alice', role: 'approver', name: '爱丽丝' },
      { userId: 'bob', role: 'operator', name: '鲍勃' },
    ],
    rules: {},
    ...overrides,
  }
  return new ApprovalEngine({
    getConfig: () => config,
    getSigningSecret: () => 'secret',
    log: () => {},
  })
}

function create(engine, params = {}) {
  return engine.create({
    action: 'git.push',
    risk: 'high',
    approvalPolicy: 'dual',
    detail: { repo: 'acme/app', branch: 'main' },
    summary: '推送 2 个提交',
    requestedBy: { userId: 'bob', name: '鲍勃', chatId: 'chat-1' },
    ...params,
  })
}

describe('clampTimeout', () => {
  test('夹取到 1..1440', () => {
    assert.equal(clampTimeout(0), 1)
    assert.equal(clampTimeout(-5), 1)
    assert.equal(clampTimeout(5000), 1440)
    assert.equal(clampTimeout('abc'), 30)
    assert.equal(clampTimeout(45.6), 46)
  })
})

describe('审批创建', () => {
  beforeEach(() => { engine = makeEngine() })

  test('创建后处于待一级审批', () => {
    const a = create(engine)
    assert.equal(a.stage, 'pending-primary')
    assert.deepEqual(a.approvers, ['alice'])
    assert.equal(a.owner, 'boss')
    assert.ok(a.id.startsWith('apr_'))
  })

  test('没有负责人时拒绝创建（fail-closed）', () => {
    config.ownerUserId = ''
    assert.throws(() => create(engine), /负责人/)
  })

  test('没有一级审批人时直接走负责人', () => {
    config.defaultApprovers = []
    config.people = [{ userId: 'boss', role: 'owner' }]
    const a = create(engine)
    assert.equal(a.stage, 'pending-owner')
  })

  test('#owner 策略直接从负责人开始', () => {
    const a = create(engine, { approvalPolicy: 'owner' })
    assert.equal(a.stage, 'pending-owner')
  })

  test('#phrase 策略记录确认短语', () => {
    const a = create(engine, { action: 'git.force-push', approvalPolicy: 'phrase', risk: 'critical' })
    assert.equal(a.phrase, '确认强推')
  })

  test('详情会被脱敏', () => {
    const a = create(engine, { detail: { repo: 'a/b', token: 'ghp_abcdefghijklmnopqrstuvwx', branch: 'main' } })
    assert.equal(a.detail.token, '«REDACTED»')
    assert.equal(a.detail.repo, 'a/b')
  })

  test('超时时长来自规则', () => {
    config.rules = { 'git.push': { timeoutMin: 5 } }
    const a = create(engine)
    const minutes = Math.round((Date.parse(a.expiresAt) - Date.parse(a.createdAt)) / 60000)
    assert.equal(minutes, 5)
  })
})

describe('两级审批', () => {
  beforeEach(() => { engine = makeEngine() })

  test('一级通过后进入负责人', () => {
    const a = create(engine)
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(r.ok, true)
    assert.equal(r.approval.stage, 'pending-owner')
    assert.match(r.note ?? '', /负责人/)
  })

  test('负责人通过后结算', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    const r = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(r.ok, true)
    assert.equal(r.approval.stage, 'approved')
    assert.equal(engine.pending.has(a.id), false)
  })

  test('一级驳回立即终结', () => {
    const a = create(engine)
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject', comment: '再改改' })
    assert.equal(r.ok, true)
    assert.equal(r.approval.stage, 'rejected')
    assert.equal(r.approval.settleComment, '再改改')
  })

  test('负责人驳回也终结', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    const r = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'reject' })
    assert.equal(r.approval.stage, 'rejected')
  })

  test('没有一级审批就不能跳到结算', () => {
    const a = create(engine)
    const r = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    // 负责人可以介入，但一级仍要过
    assert.equal(r.ok, true)
    assert.equal(r.approval.stage, 'pending-primary')
  })
})

describe('权限与幂等', () => {
  beforeEach(() => { engine = makeEngine() })

  test('非审批人不能审批', () => {
    const a = create(engine)
    const r = engine.decide({ approvalId: a.id, userId: 'bob', verdict: 'approve' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不是本节点审批人/)
  })

  test('陌生人不能审批', () => {
    const a = create(engine)
    assert.equal(engine.decide({ approvalId: a.id, userId: 'stranger', verdict: 'approve' }).ok, false)
  })

  test('发起人不能审批自己', () => {
    config.defaultApprovers = ['alice', 'bob']
    const a = create(engine)
    const r = engine.decide({ approvalId: a.id, userId: 'bob', verdict: 'approve' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /自己/)
  })

  test('同一人重复投票被拒', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    // 此时已进入负责人阶段，alice 不再有资格
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(r.ok, false)
  })

  test('多一级审批人：必须都通过', () => {
    config.defaultApprovers = ['alice', 'carol']
    config.people.push({ userId: 'carol', role: 'approver' })
    const a = create(engine)
    const r1 = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(r1.approval.stage, 'pending-primary')
    assert.match(r1.note ?? '', /carol/)
    const r2 = engine.decide({ approvalId: a.id, userId: 'carol', verdict: 'approve' })
    assert.equal(r2.approval.stage, 'pending-owner')
  })

  test('已结束的审批不能再决策', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject' })
    const r = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不存在或已结束/)
  })

  test('不存在的审批返回错误', () => {
    assert.equal(engine.decide({ approvalId: 'apr_nope', userId: 'boss', verdict: 'approve' }).ok, false)
  })
})

describe('二次确认短语', () => {
  beforeEach(() => { engine = makeEngine() })

  test('缺少短语不能通过', () => {
    const a = create(engine, { action: 'git.force-push', approvalPolicy: 'phrase', risk: 'critical' })
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /确认短语/)
  })

  test('短语错误不能通过', () => {
    const a = create(engine, { action: 'git.force-push', approvalPolicy: 'phrase', risk: 'critical' })
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve', phrase: '随便写' })
    assert.equal(r.ok, false)
  })

  test('短语正确才放行', () => {
    const a = create(engine, { action: 'git.force-push', approvalPolicy: 'phrase', risk: 'critical' })
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve', phrase: '确认强推' })
    assert.equal(r.ok, true)
    assert.equal(r.approval.stage, 'pending-owner')
  })

  test('驳回不需要短语', () => {
    const a = create(engine, { action: 'git.force-push', approvalPolicy: 'phrase', risk: 'critical' })
    const r = engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject' })
    assert.equal(r.ok, true)
  })
})

describe('双负责人（owner2）', () => {
  beforeEach(() => { engine = makeEngine() })

  test('需要负责人与第二负责人都确认', () => {
    const a = create(engine, { action: 'release.publish', approvalPolicy: 'owner2', risk: 'critical' })
    assert.equal(a.stage, 'pending-owner')
    assert.equal(a.secondOwner, 'boss2')
    const r1 = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(r1.ok, true)
    assert.equal(r1.approval.stage, 'pending-owner')
    assert.match(r1.note ?? '', /boss2/)
    const r2 = engine.decide({ approvalId: a.id, userId: 'boss2', verdict: 'approve' })
    assert.equal(r2.ok, true)
    assert.equal(r2.approval.stage, 'approved')
  })

  test('第一负责人通过后不能重复通过，必须等第二负责人', () => {
    const a = create(engine, { action: 'release.publish', approvalPolicy: 'owner2', risk: 'critical' })
    engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    const again = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(again.ok, false)
    assert.match(again.reason, /已经审批过/)
  })

  test('没有配置第二负责人时降级为单负责人', () => {
    config.secondOwners = []
    const a = create(engine, { approvalPolicy: 'owner2' })
    assert.equal(a.secondOwner, null)
    const r = engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(r.approval.stage, 'approved')
  })
})

describe('等待与超时', () => {
  beforeEach(() => { engine = makeEngine() })

  test('waitFor 在结算后返回结果', async () => {
    const a = create(engine)
    const p = engine.waitFor(a.id)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    engine.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    const r = await p
    assert.equal(r.outcome, 'approved')
  })

  test('取消时等待者收到 cancelled', async () => {
    const a = create(engine)
    const p = engine.waitFor(a.id)
    engine.cancel(a.id, '测试取消')
    const r = await p
    assert.equal(r.outcome, 'cancelled')
  })

  test('abort signal 触发取消', async () => {
    const a = create(engine)
    const ac = new AbortController()
    const p = engine.waitFor(a.id, ac.signal)
    ac.abort()
    const r = await p
    assert.equal(r.outcome, 'cancelled')
  })

  test('waitFor 不存在的审批立即返回 expired', async () => {
    const r = await engine.waitFor('apr_nope')
    assert.equal(r.outcome, 'expired')
  })

  test('超时后按 expired 结算', async () => {
    const a = create(engine, { timeoutMin: 1 })
    // 手工把过期时间改到过去再触发计时器
    a.expiresAt = new Date(Date.now() - 1000).toISOString()
    engine.armTimer(a)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(engine.pending.has(a.id), false)
  })
})

describe('列表与查询', () => {
  beforeEach(() => { engine = makeEngine() })

  test('按审批人过滤', () => {
    const a = create(engine)
    assert.equal(engine.list({ userId: 'alice' }).length, 1)
    assert.equal(engine.list({ userId: 'bob' }).length, 0)
    assert.equal(engine.list({ userId: 'boss' }).length, 0)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(engine.list({ userId: 'alice' }).length, 0)
    assert.equal(engine.list({ userId: 'boss' }).length, 1)
  })

  test('按会话过滤', () => {
    create(engine, { sessionId: 's1' })
    create(engine, { sessionId: 's2' })
    assert.equal(engine.list({ sessionId: 's1' }).length, 1)
  })

  test('按阶段过滤', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(engine.list({ stage: 'pending-owner' }).length, 1)
    assert.equal(engine.list({ stage: 'pending-primary' }).length, 0)
  })

  test('已结束的能从磁盘读回', () => {
    const a = create(engine)
    engine.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject' })
    const got = engine.get(a.id)
    assert.equal(got.stage, 'rejected')
  })
})

describe('重启恢复', () => {
  test('未完成的审批能恢复', () => {
    const e1 = makeEngine()
    const a = create(e1)
    const e2 = makeEngine()
    const count = e2.restore()
    assert.ok(count >= 1)
    assert.ok(e2.get(a.id))
  })

  test('已过期的审批在恢复时结算为 expired', () => {
    const e1 = makeEngine()
    const a = create(e1, { timeoutMin: 1 })
    a.expiresAt = new Date(Date.now() - 60_000).toISOString()
    e1.save(a)
    const e2 = makeEngine()
    e2.restore()
    assert.equal(e2.pending.has(a.id), false)
    assert.equal(e2.get(a.id).stage, 'expired')
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const HOME = join(tmpdir(), `wecom-gate-${randomBytes(4).toString('hex')}`)
mkdirSync(HOME, { recursive: true })
process.env.DSH_WECOM_HOME = HOME

const { ApprovalGate } = await import('../src/host/gate.js')
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

function setup({ deliverFails = false } = {}) {
  const approval = new ApprovalEngine({ getConfig: () => CONFIG, getSigningSecret: () => 's', log: () => {} })
  const delivered = []
  const gate = new ApprovalGate({
    getConfig: () => CONFIG,
    approval,
    getSigningSecret: () => 's',
    deliver: async (p) => { if (deliverFails) throw new Error('offline'); delivered.push(p) },
    update: async () => {},
    log: { warn() {}, error() {}, info() {}, debug() {} },
    describeSession: () => ({ userId: 'bob', name: '鲍勃' }),
  })
  return { approval, gate, delivered }
}

/** 轮询等待条件成立（避免依赖固定 sleep）。 */
async function waitUntil(cond, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

/** 假的 exec：agent 会话在一个真实 git 目录里。 */
function exec(toolName, args, { cwd = process.cwd(), signal } = {}) {
  return {
    name: toolName,
    args,
    callId: 'call-1',
    signal,
    agent: { session: { id: 'sess-1', meta: { cwd } } },
  }
}

describe('pre-execute 闸门：必须审批的动作会被挂起', () => {
  test('git push 触发审批，点通过后放行', async () => {
    const { gate, approval, delivered } = setup()
    let allowed = false
    const p = gate.onPreExecute(exec('bash', { command: 'git push origin main' }), async () => {
      allowed = true
      return { kind: 'allow' }
    })
    await waitUntil(() => delivered.length === 1)
    assert.equal(delivered.length, 1)
    const a = approval.list()[0]
    assert.equal(a.action, 'git.push')
    approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    approval.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    const decision = await p
    assert.equal(decision.kind, 'allow')
    assert.equal(allowed, true)
  })

  test('驳回后返回 deny，工具体不执行', async () => {
    const { gate, approval } = setup()
    let allowed = false
    const p = gate.onPreExecute(exec('bash', { command: 'git push' }), async () => {
      allowed = true
      return { kind: 'allow' }
    })
    await waitUntil(() => approval.list().length > 0)
    const a = approval.list()[0]
    approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'reject', comment: '先别推' })
    const decision = await p
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /驳回|先别推/)
    assert.equal(allowed, false)
  })

  test('卡片发不出去 = 拒绝（绝不默默放行）', async () => {
    const { gate } = setup({ deliverFails: true })
    const decision = await gate.onPreExecute(exec('bash', { command: 'git push' }), async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /无法送达/)
  })

  test('调用方已取消 → deny', async () => {
    const { gate, approval } = setup()
    const ac = new AbortController()
    ac.abort() // 进入前就已取消
    const p = gate.onPreExecute(exec('bash', { command: 'git push' }, { signal: ac.signal }), async () => ({ kind: 'allow' }))
    const decision = await Promise.race([p, new Promise((r) => setTimeout(() => r({ kind: 'TIMEOUT' }), 8000))])
    assert.equal(decision.kind, 'deny')
    // 清理可能残留的审批
    for (const a of approval.list()) approval.cancel(a.id, 'cleanup')
  })
})

describe('pre-execute 闸门：免审路径', () => {
  test('test.run 默认免审', async () => {
    const { gate, delivered } = setup()
    const d = await gate.onPreExecute(exec('bash', { command: 'npm test' }), async () => ({ kind: 'allow' }))
    assert.equal(d.kind, 'allow')
    assert.equal(delivered.length, 0)
  })

  test('只读工具免审', async () => {
    const { gate, delivered } = setup()
    const d = await gate.onPreExecute(exec('read_file', { path: 'a.js' }), async () => ({ kind: 'allow' }))
    assert.equal(d.kind, 'allow')
    assert.equal(delivered.length, 0)
  })

  test('没有 agent 的调用放行（非会话上下文）', async () => {
    const { gate } = setup()
    const d = await gate.onPreExecute({ name: 'bash', args: { command: 'git push' } }, async () => ({ kind: 'allow' }))
    assert.equal(d.kind, 'allow')
  })

  test('全局关闭闸后放行但留审计', async () => {
    const { gate, delivered } = setup()
    CONFIG.approval.enabled = false
    const d = await gate.onPreExecute(exec('bash', { command: 'git push' }), async () => ({ kind: 'allow' }))
    CONFIG.approval.enabled = true
    assert.equal(d.kind, 'allow')
    assert.equal(delivered.length, 0)
  })

  test('规则级关闭某动作后放行', async () => {
    const { gate, delivered } = setup()
    CONFIG.rules = { 'git.push': { enabled: false } }
    const d = await gate.onPreExecute(exec('bash', { command: 'git push' }), async () => ({ kind: 'allow' }))
    CONFIG.rules = {}
    assert.equal(d.kind, 'allow')
    assert.equal(delivered.length, 0)
  })
})

describe('pre-execute 闸门：fail-closed', () => {
  test('参数含义不明的工具也走审批', async () => {
    const { gate, approval } = setup()
    const p = gate.onPreExecute(exec('some_unknown_tool', { weird: { deep: 'value' } }), async () => ({ kind: 'allow' }))
    await waitUntil(() => approval.list().length >= 1)
    assert.ok(approval.list().length >= 1)
    approval.cancel(approval.list()[0].id, 'cleanup')
    const d = await p
    assert.equal(d.kind, 'deny')
  })

  test('强推需要确认短语，缺短语不能放行', async () => {
    const { gate, approval, delivered } = setup()
    const p = gate.onPreExecute(exec('bash', { command: 'git push --force origin main' }), async () => ({ kind: 'allow' }))
    await waitUntil(() => approval.list().length > 0)
    const a = approval.list()[0]
    assert.equal(a.action, 'git.force-push')
    assert.ok(a.phrase)
    // 不带短语直接通过 → 失败（phrase 策略下每一级都要短语）
    const bad = approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve' })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /确认短语/)
    // 一级带短语通过
    const r1 = approval.decide({ approvalId: a.id, userId: 'alice', verdict: 'approve', phrase: a.phrase })
    assert.equal(r1.ok, true)
    assert.equal(r1.approval.stage, 'pending-owner')
    // 负责人也要短语
    const bad2 = approval.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve' })
    assert.equal(bad2.ok, false)
    const r2 = approval.decide({ approvalId: a.id, userId: 'boss', verdict: 'approve', phrase: a.phrase })
    assert.equal(r2.ok, true)
    const d = await p
    assert.equal(d.kind, 'allow')
  })

  test('分类抛错时拒绝（而不是放行）', async () => {
    const { gate } = setup()
    // 传一个会触发解析异常的 args（Proxy 模拟)
    const evilArgs = new Proxy({}, {
      get() { throw new Error('boom') },
      ownKeys() { throw new Error('boom') },
      getOwnPropertyDescriptor() { throw new Error('boom') },
    })
    const d = await gate.onPreExecute({ name: 'bash', args: evilArgs, agent: { session: { id: 's1', meta: { cwd: process.cwd() } } } }, async () => ({ kind: 'allow' }))
    assert.equal(d.kind, 'deny')
    assert.match(d.reason, /无法判定|已拒绝/)
  })
})

describe('证据构建', () => {
  test('卡片里带仓库与命令', async () => {
    const { gate, delivered } = setup()
    const p = gate.onPreExecute(exec('bash', { command: 'git push origin main' }), async () => ({ kind: 'allow' }))
    await waitUntil(() => delivered.length > 0)
    const a = delivered[0].approval
    assert.equal(a.action, 'git.push')
    assert.match(a.detail.command, /git push/)
    assert.ok(a.summary.length > 0)
    gate.approval.cancel(a.id, 'cleanup')
    await p
  })

  test('证据不含密钥', async () => {
    const { gate, delivered } = setup()
    const p = gate.onPreExecute(
      exec('bash', { command: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 && git push' }),
      async () => ({ kind: 'allow' }),
    )
    await waitUntil(() => delivered.length > 0)
    const text = JSON.stringify(delivered[0].approval)
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), '密钥不应出现在审批记录里')
    gate.approval.cancel(delivered[0].approval.id, 'cleanup')
    await p
  })
})

describe('来源标记', () => {
  test('来自企微的会话带上发送者', async () => {
    const { gate, delivered } = setup()
    gate.markOrigin('sess-1', { chatId: 'chat-9', chatType: 'group', senderId: 'bob' })
    const p = gate.onPreExecute(exec('bash', { command: 'git commit -m x' }), async () => ({ kind: 'allow' }))
    await waitUntil(() => delivered.length > 0)
    const a = delivered[0].approval
    assert.equal(a.requestedBy.userId, 'bob')
    assert.equal(a.requestedBy.chatId, 'chat-9')
    assert.equal(a.requestedBy.chatType, 'group')
    gate.approval.cancel(a.id, 'cleanup')
    await p
  })

  test('过期标记不再生效', () => {
    const { gate } = setup()
    gate.markOrigin('sess-1', { chatId: 'c', senderId: 'bob' })
    // 手工改成 5 小时前
    gate.wecomOrigins.get('sess-1').at = Date.now() - 5 * 3600_000
    assert.equal(gate.originOf('sess-1'), null)
  })
})

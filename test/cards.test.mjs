import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeButtonKey, decodeButtonKey, buildApprovalCard, buildResultCard,
  clip, signAction, LIMITS,
} from '../src/wecom/cards.js'

const SECRET = 'test-signing-secret-0123456789abcdef'
const approval = {
  id: 'apr_0123456789abcdef01234567',
  action: 'git.push',
  actionLabel: '推送代码',
  icon: '⬆️',
  risk: 'high',
  stage: 'pending-primary',
  summary: '推送 3 个提交到 origin/main',
  requestedBy: { userId: 'alice', name: '爱丽丝' },
  approvers: ['bob'],
  owner: 'boss',
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
  detail: {
    repo: 'acme/app', branch: 'main', diffStat: '4 files changed, 51 insertions(+)',
    files: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
    commits: [{ sha: 'abc1234', subject: '修复登录' }],
    repoUrl: 'https://github.com/acme/app',
  },
}

describe('按钮 key 签名', () => {
  test('编码后可解码', () => {
    const key = encodeButtonKey(SECRET, 'approve', approval.id)
    const d = decodeButtonKey(SECRET, key)
    assert.equal(d.ok, true)
    assert.equal(d.action, 'approve')
    assert.equal(d.approvalId, approval.id)
  })

  test('换密钥无法解码（防伪造）', () => {
    const key = encodeButtonKey(SECRET, 'approve', approval.id)
    const d = decodeButtonKey('attacker-secret', key)
    assert.equal(d.ok, false)
  })

  test('篡改动作被拒', () => {
    const key = encodeButtonKey(SECRET, 'approve', approval.id)
    const forged = key.replace(':approve:', ':reject:')
    assert.equal(decodeButtonKey(SECRET, forged).ok, false)
  })

  test('篡改审批 ID 被拒', () => {
    const key = encodeButtonKey(SECRET, 'approve', approval.id)
    const forged = key.replace(approval.id, 'apr_ffffffffffffffffffffffff')
    assert.equal(decodeButtonKey(SECRET, forged).ok, false)
  })

  test('格式错误被拒', () => {
    for (const bad of ['', 'garbage', 'wsa:approve:apr_123:zzzzzzzzzzzz', null, undefined, 'wsa:approve:apr_x:000000000000']) {
      assert.equal(decodeButtonKey(SECRET, bad).ok, false, String(bad))
    }
  })

  test('签名稳定', () => {
    assert.equal(signAction(SECRET, 'approve', 'apr_1'), signAction(SECRET, 'approve', 'apr_1'))
    assert.notEqual(signAction(SECRET, 'approve', 'apr_1'), signAction(SECRET, 'approve', 'apr_2'))
  })
})

describe('clip', () => {
  test('不超长原样返回', () => {
    assert.equal(clip('abc', 10), 'abc')
  })
  test('超长截断并加省略号', () => {
    const out = clip('abcdefghij', 5)
    assert.equal([...out].length, 5)
    assert.ok(out.endsWith('…'))
  })
  test('按码点截断不劈开 emoji', () => {
    const out = clip('🎉🎉🎉🎉🎉', 3)
    assert.equal([...out].length, 3)
    assert.ok(!out.includes('�'))
  })
})

describe('buildApprovalCard', () => {
  test('是 button_interaction，带四个按钮', () => {
    const card = buildApprovalCard({ approval, secret: SECRET, approvers: { primary: ['bob'], owner: 'boss' } })
    assert.equal(card.card_type, 'button_interaction')
    assert.equal(card.button_list.length, 4)
    assert.deepEqual(card.button_list.map((b) => b.key.split(':')[1]), ['approve', 'reject', 'detail', 'defer'])
  })

  test('task_id 是审批 ID', () => {
    const card = buildApprovalCard({ approval, secret: SECRET, approvers: { primary: ['bob'], owner: 'boss' } })
    assert.equal(card.task_id, approval.id)
  })

  test('标题不超限', () => {
    const long = { ...approval, actionLabel: 'A'.repeat(100) }
    const card = buildApprovalCard({ approval: long, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.ok([...card.main_title.title].length <= LIMITS.title)
  })

  test('横向列表不超过 6 条', () => {
    const card = buildApprovalCard({ approval, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.ok(card.horizontal_content_list.length <= LIMITS.horizontalList)
  })

  test('正文含仓库与统计', () => {
    const card = buildApprovalCard({ approval, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.match(card.sub_title_text, /acme\/app|改动|统计/)
  })

  test('已结束的审批只留详情按钮', () => {
    const done = { ...approval, stage: 'approved' }
    const card = buildApprovalCard({ approval: done, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.equal(card.button_list.length, 1)
    assert.equal(card.button_list[0].key.split(':')[1], 'detail')
  })

  test('没有可选链接时不产生空 jump_list', () => {
    const plain = { ...approval, detail: {} }
    const card = buildApprovalCard({ approval: plain, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.equal(card.jump_list.length, 0)
  })

  test('风险色：严重为红', () => {
    const crit = { ...approval, risk: 'critical' }
    const card = buildApprovalCard({ approval: crit, secret: SECRET, approvers: { primary: [], owner: 'boss' } })
    assert.equal(card.source.desc_color, 2)
  })
})

describe('buildResultCard', () => {
  test('通过用绿色与对勾', () => {
    const card = buildResultCard({ approval, outcome: 'approved', actor: { userId: 'boss', name: '老板' } })
    assert.equal(card.card_type, 'text_notice')
    assert.equal(card.source.desc_color, 3)
    assert.match(card.main_title.title, /✅/)
  })
  test('驳回用红色', () => {
    const card = buildResultCard({ approval, outcome: 'rejected', actor: { userId: 'boss' } })
    assert.equal(card.source.desc_color, 2)
    assert.match(card.main_title.title, /⛔/)
  })
  test('带审批意见', () => {
    const card = buildResultCard({ approval, outcome: 'rejected', actor: { name: '老板', comment: '测试没跑过' } })
    assert.ok(card.horizontal_content_list.some((r) => r.value === '测试没跑过'))
  })
})

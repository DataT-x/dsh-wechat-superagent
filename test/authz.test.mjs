import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, buildRoleTable, roleOf, atLeast, approversFor } from '../src/core/authz.js'

const baseConfig = {
  ownerUserId: 'boss',
  secondOwners: ['boss2'],
  people: [
    { userId: 'boss', role: 'owner', name: '老板' },
    { userId: 'alice', role: 'approver', name: '爱丽丝' },
    { userId: 'bob', role: 'operator', name: '鲍勃' },
    { userId: 'eve', role: 'viewer', name: '旁观者' },
  ],
  allowedGroupIds: ['group-ok'],
}

describe('buildRoleTable', () => {
  test('按配置建立角色', () => {
    const t = buildRoleTable(baseConfig)
    assert.equal(t.get('alice'), 'approver')
    assert.equal(t.get('bob'), 'operator')
  })

  test('负责人永远是 owner', () => {
    const t = buildRoleTable({ ownerUserId: 'boss', people: [{ userId: 'boss', role: 'viewer' }] })
    assert.equal(t.get('boss'), 'owner')
  })

  test('同一人多条取最高', () => {
    const t = buildRoleTable({ people: [{ userId: 'x', role: 'viewer' }, { userId: 'x', role: 'approver' }] })
    assert.equal(t.get('x'), 'approver')
  })

  test('忽略空 userid 与非法角色', () => {
    const t = buildRoleTable({ people: [{ userId: '', role: 'owner' }, { userId: 'y', role: 'superadmin' }] })
    assert.equal(t.size, 1)
    assert.equal(t.get('y'), 'viewer')
  })

  test('空配置不崩', () => {
    assert.equal(buildRoleTable(undefined).size, 0)
    assert.equal(buildRoleTable({}).size, 0)
  })
})

describe('roleOf / atLeast', () => {
  test('未登记返回 null', () => {
    assert.equal(roleOf(baseConfig, 'stranger'), null)
    assert.equal(roleOf(baseConfig, ''), null)
    assert.equal(roleOf(baseConfig, null), null)
  })

  test('级别比较正确', () => {
    assert.ok(atLeast(baseConfig, 'boss', 'approver'))
    assert.ok(atLeast(baseConfig, 'alice', 'operator'))
    assert.ok(!atLeast(baseConfig, 'bob', 'approver'))
    assert.ok(!atLeast(baseConfig, 'eve', 'operator'))
  })
})

describe('authorize', () => {
  test('未登记的人一律拒绝（fail-closed）', () => {
    const r = authorize({ config: baseConfig, userId: 'stranger', chatType: 'single', intent: 'command' })
    assert.equal(r.allowed, false)
    assert.match(r.reason, /授权名单/)
  })

  test('空配置时谁都不能用', () => {
    const r = authorize({ config: {}, userId: 'boss', chatType: 'single', intent: 'query' })
    assert.equal(r.allowed, false)
  })

  test('操作员可以下命令', () => {
    assert.equal(authorize({ config: baseConfig, userId: 'bob', chatType: 'single', intent: 'command' }).allowed, true)
  })

  test('操作员不能审批', () => {
    const r = authorize({ config: baseConfig, userId: 'bob', chatType: 'single', intent: 'approve' })
    assert.equal(r.allowed, false)
  })

  test('审批人可以审批', () => {
    assert.equal(authorize({ config: baseConfig, userId: 'alice', chatType: 'single', intent: 'approve' }).allowed, true)
  })

  test('只有负责人能改配置', () => {
    assert.equal(authorize({ config: baseConfig, userId: 'alice', chatType: 'single', intent: 'configure' }).allowed, false)
    assert.equal(authorize({ config: baseConfig, userId: 'boss', chatType: 'single', intent: 'configure' }).allowed, true)
  })

  test('旁观者只能查询', () => {
    assert.equal(authorize({ config: baseConfig, userId: 'eve', chatType: 'single', intent: 'query' }).allowed, true)
    assert.equal(authorize({ config: baseConfig, userId: 'eve', chatType: 'single', intent: 'command' }).allowed, false)
  })

  test('群聊白名单生效', () => {
    const ok = authorize({ config: baseConfig, userId: 'bob', chatType: 'group', chatId: 'group-ok', intent: 'command' })
    assert.equal(ok.allowed, true)
    const bad = authorize({ config: baseConfig, userId: 'bob', chatType: 'group', chatId: 'group-other', intent: 'command' })
    assert.equal(bad.allowed, false)
    assert.match(bad.reason, /群/)
  })

  test('没配群白名单时不限制群', () => {
    const config = { ...baseConfig, allowedGroupIds: [] }
    assert.equal(authorize({ config, userId: 'bob', chatType: 'group', chatId: 'any', intent: 'command' }).allowed, true)
  })

  test('单聊不受群白名单影响', () => {
    assert.equal(authorize({ config: baseConfig, userId: 'bob', chatType: 'single', chatId: 'x', intent: 'command' }).allowed, true)
  })
})

describe('approversFor', () => {
  test('默认排除负责人', () => {
    const r = approversFor(baseConfig, { approvers: [] })
    // 没有 defaultApprovers 时，所有 approver/owner 角色的人（除负责人）都算一级审批人
    assert.deepEqual(r.primary, ['alice'])
    assert.equal(r.owner, 'boss')
  })

  test('显式指定的审批人优先（集合语义，与顺序无关）', () => {
    const r = approversFor(baseConfig, { approvers: ['bob', 'alice'] })
    assert.deepEqual([...r.primary].sort(), ['alice', 'bob'])
  })

  test('没有负责人时 owner 为 null', () => {
    const r = approversFor({ people: [] }, {})
    assert.equal(r.owner, null)
  })
})

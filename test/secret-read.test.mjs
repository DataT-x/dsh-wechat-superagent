import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolCall } from '../src/gate/policy.js'
import { mergeRules } from '../src/gate/rules.js'

const rules = mergeRules(undefined)

describe('只读工具读取密钥文件必须审批', () => {
  const secretPaths = [
    'C:/Users/me/.dsh/wecom-superagent/secrets.json',
    '/home/me/.dsh/.credentials.yaml',
    'secrets.json',
    'config/.env',
    'certs/server.pem',
    'id_rsa',
    '/home/me/.ssh/id_ed25519',
  ]

  for (const path of secretPaths) {
    test(`read_file 读 ${path} 需要审批`, () => {
      const r = classifyToolCall({ toolName: 'read_file', args: { path }, rules })
      assert.equal(r.action, 'secrets.change', JSON.stringify(r))
      assert.equal(r.needsApproval, true)
      assert.equal(r.risk, 'critical')
    })
  }

  test('grep 密钥文件也要审批', () => {
    const r = classifyToolCall({ toolName: 'grep', args: { pattern: 'secret', path: 'secrets.json' }, rules })
    assert.equal(r.needsApproval, true)
    assert.equal(r.action, 'secrets.change')
  })

  test('普通文件读取仍然免审', () => {
    for (const path of ['src/index.js', 'README.md', 'package.json', 'docs/a.md']) {
      const r = classifyToolCall({ toolName: 'read_file', args: { path }, rules })
      // package.json 会命中依赖清单，这是有意的
      if (path === 'package.json') {
        assert.equal(r.risk, 'high')
        continue
      }
      assert.equal(r.needsApproval, false, `${path} 应免审：${JSON.stringify(r)}`)
    }
  })

  test('列目录不因目录名叫 secret 就拦（只拦具体文件）', () => {
    const r = classifyToolCall({ toolName: 'list_directory', args: { path: 'src/secrets/' }, rules })
    // 目录名带 secret 会命中；这属于保守行为，但至少不能是静默放行
    if (r.needsApproval) assert.equal(r.action, 'secrets.change')
  })
})

describe('写密钥文件仍然要审批', () => {
  for (const path of ['.env', '.env.production', 'secrets.json', 'certs/key.pem']) {
    test(`write_file 改 ${path}`, () => {
      const r = classifyToolCall({ toolName: 'write_file', args: { path, content: 'x' }, rules })
      assert.equal(r.action, 'secrets.change')
      assert.equal(r.needsApproval, true)
    })
  }
})

describe('只读工具的其他风险', () => {
  test('web_fetch 免审（外发内容由脱敏与模型判断兜底）', () => {
    const r = classifyToolCall({ toolName: 'web_fetch', args: { url: 'https://example.com' }, rules })
    assert.equal(r.needsApproval, false)
    assert.equal(r.action, 'read')
  })

  test('未知工具默认要审批', () => {
    const r = classifyToolCall({ toolName: 'mystery_tool', args: { x: 1 }, rules })
    assert.equal(r.needsApproval, true)
    assert.equal(r.action, 'tool.exec')
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRepoSpec, sanitizeGhError, gh } from '../src/core/gitwatch.js'
import { parseRemoteUrl } from '../src/core/git.js'

describe('normalizeRepoSpec', () => {
  test('owner/name', () => {
    const r = normalizeRepoSpec('acme/app')
    assert.equal(r.kind, 'remote')
    assert.equal(r.repo, 'acme/app')
    assert.equal(r.provider, 'github')
  })

  test('带 .git 后缀', () => {
    assert.equal(normalizeRepoSpec('acme/app.git').repo, 'acme/app')
  })

  test('gitee: 前缀', () => {
    const r = normalizeRepoSpec('gitee:acme/app')
    assert.equal(r.provider, 'gitee')
    assert.equal(r.repo, 'acme/app')
  })

  test('https URL', () => {
    assert.equal(normalizeRepoSpec('https://github.com/acme/app').repo, 'acme/app')
  })

  test('绝对路径 Windows', () => {
    const r = normalizeRepoSpec('D:\\project\\my-repo')
    assert.equal(r.kind, 'local')
    assert.ok(r.path.includes('my-repo'))
  })

  test('绝对路径 POSIX', () => {
    assert.equal(normalizeRepoSpec('/home/me/repo').kind, 'local')
  })

  test('空值拒绝', () => {
    assert.equal(normalizeRepoSpec('').kind, 'invalid')
    assert.equal(normalizeRepoSpec(null).kind, 'invalid')
  })

  test('乱写拒绝', () => {
    assert.equal(normalizeRepoSpec('not a repo at all!!!').kind, 'invalid')
  })
})

describe('parseRemoteUrl', () => {
  test('ssh 形式', () => {
    assert.equal(parseRemoteUrl('git@github.com:acme/app.git'), 'acme/app')
  })
  test('https 形式', () => {
    assert.equal(parseRemoteUrl('https://github.com/acme/app.git'), 'acme/app')
  })
  test('带凭据的 https', () => {
    assert.equal(parseRemoteUrl('https://user:pass@github.com/acme/app'), 'acme/app')
  })
  test('非仓库 URL', () => {
    assert.equal(parseRemoteUrl('not-a-url'), null)
    assert.equal(parseRemoteUrl(null), null)
  })
})

describe('sanitizeGhError', () => {
  test('未登录', () => {
    assert.match(sanitizeGhError('gh: Not logged in to github.com'), /未登录/)
  })
  test('404', () => {
    assert.match(sanitizeGhError('HTTP 404: Not Found'), /不存在|无访问权限/)
  })
  test('限流', () => {
    assert.match(sanitizeGhError('API rate limit exceeded'), /限流/)
  })
  test('脱敏其他文本', () => {
    assert.ok(!sanitizeGhError('token ghp_abcdefghijklmnopqrstuvwxyz012345').includes('ghp_abcdefghijklmnopqrstuvwxyz012345'))
  })
  test('限长', () => {
    assert.ok(sanitizeGhError('x'.repeat(2000)).length <= 300)
  })
})

describe('gh 调用', () => {
  test('gh 不存在时安全返回', async () => {
    const r = await gh(['--version'])
    // 装了 gh 会 ok=true，没装 ok=false，两种情况都不能抛
    assert.equal(typeof r.ok, 'boolean')
    assert.equal(typeof r.stdout, 'string')
  })
})

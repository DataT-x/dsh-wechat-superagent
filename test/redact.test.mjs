import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactDeep, isSecretKey, previewSecret, fingerprint } from '../src/core/redact.js'

describe('redactText', () => {
  test('遮盖 GitHub token', () => {
    const out = redactText('用 ghp_abcdefghijklmnopqrstuvwxyz012345 推送')
    assert.ok(out.includes('«REDACTED»'))
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'))
  })

  test('遮盖 sk- 与 sk-ant-', () => {
    assert.ok(!redactText('key sk-1234567890abcdefghij').includes('1234567890abcdefghij'))
    assert.ok(!redactText('key sk-ant-api03-abcdefghijklmnop').includes('api03-abcdefghijklmnop'))
  })

  test('遮盖 PEM 私钥块', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const out = redactText(pem)
    assert.ok(out.includes('«REDACTED»'))
    assert.ok(!out.includes('MIIEowIBAAKCAQEA'))
  })

  test('遮盖 Bearer 头', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnop123')
    assert.ok(!out.includes('abcdefghijklmnop123'))
  })

  test('遮盖 URL 里的密码', () => {
    const out = redactText('https://user:supersecret@example.com/repo')
    assert.ok(!out.includes('supersecret'))
  })

  test('遮盖 .env 形式的密钥', () => {
    const out = redactText('DB_PASSWORD=hunter2xyz')
    assert.ok(!out.includes('hunter2xyz'))
  })

  test('遮盖 AWS key', () => {
    const out = redactText('AKIAIOSFODNN7EXAMPLE')
    assert.ok(!out.includes('IOSFODNN7EXAMPLE'))
  })

  test('把绝对路径缩成占位符', () => {
    const out = redactText('D:\\Users\\xiong\\project\\secret.txt')
    assert.ok(!out.includes('xiong'), out)
  })

  test('普通文本原样返回', () => {
    const text = '修复了登录页的样式问题，见 src/login.css:42'
    assert.equal(redactText(text), text)
  })

  test('非字符串安全返回', () => {
    assert.equal(redactText(null), null)
    assert.equal(redactText(undefined), undefined)
    assert.equal(redactText(42), 42)
  })

  test('短 commit hash 不会被误伤', () => {
    assert.equal(redactText('commit abc1234f'), 'commit abc1234f')
  })
})

describe('isSecretKey', () => {
  test('识别常见密钥键名', () => {
    for (const key of ['secret', 'botSecret', 'access_token', 'apiKey', 'private-key', 'Authorization', 'password']) {
      assert.ok(isSecretKey(key), key)
    }
  })
  test('普通键名不误判', () => {
    for (const key of ['name', 'path', 'branch', 'summary']) {
      assert.ok(!isSecretKey(key), key)
    }
  })
})

describe('redactDeep', () => {
  test('嵌套对象的密钥字段被替换', () => {
    const input = { bot: { botId: 'abc', secret: 'xyz123456789' }, list: [{ token: 'q'.repeat(30) }] }
    const out = redactDeep(input)
    assert.equal(out.bot.botId, 'abc')
    assert.equal(out.bot.secret, '«REDACTED»')
    assert.equal(out.list[0].token, '«REDACTED»')
  })

  test('循环引用不崩', () => {
    const a = { name: 'x' }
    a.self = a
    const out = redactDeep(a)
    assert.equal(out.name, 'x')
    assert.equal(out.self, '«CIRCULAR»')
  })

  test('Error 转成可读对象', () => {
    const out = redactDeep(new Error('bad token ghp_abcdefghijklmnopqrstuvwx'))
    assert.equal(out.name, 'Error')
    assert.ok(!out.message.includes('ghp_abcdefghijklmnopqrstuvwx'))
  })

  test('深度保护', () => {
    let deep = {}
    let cursor = deep
    for (let i = 0; i < 20; i++) { cursor.next = {}; cursor = cursor.next }
    const out = redactDeep(deep)
    assert.ok(JSON.stringify(out).includes('MAX_DEPTH'))
  })
})

describe('previewSecret', () => {
  test('只露头尾', () => {
    const s = 'abcdefghijklmnop'
    const p = previewSecret(s)
    assert.ok(p.startsWith('abc'))
    assert.ok(p.endsWith('op'))
    assert.ok(!p.includes('defghijklmn'))
  })
  test('短密钥全遮', () => {
    assert.equal(previewSecret('abc'), '•••')
  })
  test('空值返回空串', () => {
    assert.equal(previewSecret(''), '')
    assert.equal(previewSecret(null), '')
  })
})

describe('fingerprint', () => {
  test('相同输入相同指纹', () => {
    assert.equal(fingerprint('secret-a'), fingerprint('secret-a'))
  })
  test('不同输入不同指纹', () => {
    assert.notEqual(fingerprint('secret-a'), fingerprint('secret-b'))
  })
  test('不泄露原值', () => {
    assert.ok(!fingerprint('secret-a').includes('secret'))
  })
})

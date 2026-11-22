import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { WeComTransport, STATE } from '../src/wecom/transport.js'

describe('WeComTransport 日志适配', () => {
  test('options.log 是 (level, msg) 形式的函数，不是对象', () => {
    const seen = []
    const t = new WeComTransport({
      botId: 'x', secret: 'y',
      log: (level, msg) => seen.push({ level, msg }),
    })
    t.log('info', 'hello')
    assert.deepEqual(seen, [{ level: 'info', msg: 'hello' }])
  })

  test('log 抛错时不冒泡（日志失败不能打断连接）', () => {
    const t = new WeComTransport({
      botId: 'x', secret: 'y',
      log: () => { throw new Error('logger boom') },
    })
    assert.doesNotThrow(() => t.log('info', 'x'))
  })

  test('没有 log 时静默不崩', () => {
    const t = new WeComTransport({ botId: 'x', secret: 'y' })
    assert.doesNotThrow(() => t.log('info', 'x'))
  })

  test('初始状态为 idle 且不在线', () => {
    const t = new WeComTransport({ botId: 'x', secret: 'y' })
    assert.equal(t.state, STATE.idle)
    assert.equal(t.isOnline, false)
  })

  test('未在线时发消息抛出清晰错误', async () => {
    const t = new WeComTransport({ botId: 'x', secret: 'y' })
    await assert.rejects(() => t.sendMarkdown('chat', 'hi'), /未在线/)
  })

  test('SDK logger 回调的形状与 our log 方法兼容（回归：曾把方法当对象用）', () => {
    const t = new WeComTransport({ botId: 'x', secret: 'y', log: () => {} })
    // this.log 必须是函数，而不是带 info/warn 的对象
    assert.equal(typeof t.log, 'function')
    assert.equal(t.log.info, undefined, 'this.log 不应被当作对象使用')
  })
})

describe('reconnect 不能清掉监听器（回归）', () => {
  test('disconnect 保留监听器，dispose 清空监听器', async () => {
    const t1 = new WeComTransport({ botId: 'x', secret: 'y' })
    t1.on('state', () => {})
    await t1.disconnect()
    assert.equal(t1.listenerCount('state'), 1, 'disconnect 必须保留监听器（否则重连后收不到事件）')

    const t2 = new WeComTransport({ botId: 'x', secret: 'y' })
    t2.on('state', () => {})
    await t2.dispose()
    assert.equal(t2.listenerCount('state'), 0, 'dispose 应清空监听器')
  })
})

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderContext, composeInboundMessage, inboundHint, formatTime, chatTypeLabel,
  toWecomMarkdown, zoneName,
} from '../src/core/context.js'

const config = {
  channelLabel: '企业微信',
  includeChannel: true,
  includeChatType: true,
  includeChatTitle: true,
  includeSender: true,
  includeTime: true,
  includeMessageId: false,
  timeZone: 'Asia/Shanghai',
}

const base = {
  config,
  chatType: 'group',
  chatTitle: '研发一组',
  chatId: 'group-1',
  senderId: 'zhangsan',
  senderName: '张三',
  at: new Date('2026-11-21T14:10:00Z'),
  role: 'operator',
}

describe('chatTypeLabel', () => {
  test('群聊/单聊', () => {
    assert.equal(chatTypeLabel('group'), '群聊')
    assert.equal(chatTypeLabel('single'), '单聊')
    assert.equal(chatTypeLabel(undefined), '单聊')
  })
})

describe('formatTime', () => {
  test('输出 YYYY-MM-DD HH:mm:ss', () => {
    const out = formatTime(new Date('2026-11-21T14:10:05Z'), 'UTC')
    assert.equal(out, '2026-11-21 14:10:05')
  })
  test('时区换算正确', () => {
    const out = formatTime(new Date('2026-11-21T14:10:05Z'), 'Asia/Shanghai')
    assert.equal(out, '2026-11-21 22:10:05')
  })
  test('坏时区不崩', () => {
    const out = formatTime(new Date(), 'Not/AZone')
    assert.match(out, /^\d{4}-\d{2}-\d{2}/)
  })
})

describe('zoneName', () => {
  test('返回字符串', () => {
    assert.equal(typeof zoneName(), 'string')
    assert.equal(zoneName('UTC'), 'UTC')
  })
})

describe('renderContext', () => {
  test('包含所有启用的字段', () => {
    const out = renderContext(base)
    assert.match(out, /<wecom-context>/)
    assert.match(out, /渠道: 企业微信/)
    assert.match(out, /会话类型: 群聊/)
    assert.match(out, /会话: 研发一组/)
    assert.match(out, /发送者: 张三 \(zhangsan\)/)
    assert.match(out, /角色: operator/)
    assert.match(out, /时间: 2026-11-21 22:10:00/)
    assert.match(out, /<\/wecom-context>/)
  })

  test('关闭字段后不出现', () => {
    const out = renderContext({
      ...base,
      config: { ...config, includeTime: false, includeSender: false, includeChatTitle: false },
    })
    assert.ok(!out.includes('时间:'))
    assert.ok(!out.includes('发送者:'))
    assert.ok(!out.includes('会话:'))
    assert.ok(out.includes('渠道:'))
  })

  test('全部关闭返回空串', () => {
    const out = renderContext({
      ...base,
      config: {
        includeChannel: false, includeChatType: false, includeChatTitle: false,
        includeSender: false, includeTime: false, includeMessageId: false,
      },
    })
    assert.equal(out, '')
  })

  test('没有昵称时只显示 userid', () => {
    const out = renderContext({ ...base, senderName: '' })
    assert.match(out, /发送者: zhangsan/)
  })

  test('没有标题时用 chatId', () => {
    const out = renderContext({ ...base, chatTitle: '' })
    assert.match(out, /会话: group-1/)
  })

  test('消息 ID 默认不出现', () => {
    assert.ok(!renderContext({ ...base, messageId: 'm1' }).includes('消息ID'))
  })

  test('开启后出现消息 ID', () => {
    const out = renderContext({ ...base, messageId: 'm1', config: { ...config, includeMessageId: true } })
    assert.match(out, /消息ID: m1/)
  })

  test('config 为 undefined 时用默认值', () => {
    const out = renderContext({ ...base, config: undefined })
    assert.match(out, /渠道: 企业微信/)
  })
})

describe('composeInboundMessage', () => {
  test('上下文 + 提示 + 正文，用空行分隔', () => {
    const out = composeInboundMessage({ context: '<wecom-context>x</wecom-context>', hint: '（提示）', content: '修 bug' })
    assert.equal(out, '<wecom-context>x</wecom-context>\n\n（提示）\n\n修 bug')
  })
  test('空上下文时不留多余空行', () => {
    assert.equal(composeInboundMessage({ context: '', hint: '', content: 'hi' }), 'hi')
  })
})

describe('inboundHint', () => {
  test('群聊与单聊不同', () => {
    assert.match(inboundHint('group'), /群聊/)
    assert.match(inboundHint('single'), /单聊/)
  })
})

describe('toWecomMarkdown', () => {
  test('普通文本不变', () => {
    assert.equal(toWecomMarkdown('hello'), 'hello')
  })

  test('超长代码块被裁剪', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = toWecomMarkdown(`\`\`\`js\n${lines}\n\`\`\``, { maxCodeLines: 10 })
    // 100 行内容 + 结尾换行会得到 101 个片段，被裁掉 91 行
    assert.match(out, /省略 \d+ 行/)
    assert.ok(out.split('\n').length < 30)
    assert.match(out, /line 9/)
    assert.ok(!out.includes('line 50'))
  })

  test('表格转成列表', () => {
    const table = '| 名字 | 年龄 |\n|---|---|\n| 张三 | 18 |\n| 李四 | 20 |'
    const out = toWecomMarkdown(table)
    assert.match(out, /- \*\*名字\*\* 张三/)
    assert.ok(!out.includes('|---'))
  })

  test('字节上限截断', () => {
    const big = 'a'.repeat(1000)
    const out = toWecomMarkdown(big, { maxBytes: 100 })
    assert.ok(Buffer.byteLength(out, 'utf8') <= 220)
    assert.match(out, /截断/)
  })

  test('非字符串安全', () => {
    assert.equal(toWecomMarkdown(null), '')
    assert.equal(toWecomMarkdown(undefined), '')
  })

  test('中文不会被截成半个字符', () => {
    const text = '中文内容'.repeat(500)
    const out = toWecomMarkdown(text, { maxBytes: 200 })
    assert.ok(!out.includes('�'))
  })
})

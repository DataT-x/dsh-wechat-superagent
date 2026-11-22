/**
 * 上下文增强：把「渠道、会话标题、发送时间、发送者昵称、会话类型」
 * 组装成一段结构化前缀，注入到唤醒会话的 UserMessage 里。
 *
 * 与 dsh-im 的做法对齐：**不改 system prompt**（那会破坏提示词缓存），
 * 而是把上下文作为消息正文的前缀。这样：
 *   - 模型每轮都能看到「这条消息从哪来、谁发的、什么时候」；
 *   - 会话历史里留有痕迹，回放时能还原当时的上下文；
 *   - 用户可以通过配置裁剪字段，控制 token 开销。
 *
 * 输出形如：
 *   <wecom-context>
 *   渠道: 企业微信
 *   会话类型: 群聊
 *   会话: 研发一组
 *   发送者: 张三 (zhangsan)
 *   时间: 2026-11-21 22:10:00 (Asia/Shanghai)
 *   </wecom-context>
 *
 *   实际消息正文...
 */

const DEFAULTS = {
  channelLabel: '企业微信',
  includeChannel: true,
  includeChatType: true,
  includeChatTitle: true,
  includeSender: true,
  includeTime: true,
  includeMessageId: false,
  includeApprovalHint: true,
  timeZone: undefined,
}

/** 会话类型的中文名。 */
export function chatTypeLabel(chatType) {
  return chatType === 'group' ? '群聊' : '单聊'
}

/** 把时间格式化成 `YYYY-MM-DD HH:mm:ss`。 */
export function formatTime(date = new Date(), timeZone = undefined) {
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      ...(timeZone === undefined ? {} : { timeZone }),
    }).formatToParts(date)
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
  } catch {
    return date.toISOString().slice(0, 19).replace('T', ' ')
  }
}

/** 当前时区名。 */
export function zoneName(timeZone = undefined) {
  try {
    return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 渲染上下文块。
 * @param {object} params
 * @param {object} params.config 插件配置（读 context 小节）
 * @param {string} params.chatType
 * @param {string} [params.chatTitle] 群名或单聊对方昵称
 * @param {string} [params.chatId]
 * @param {string} params.senderId
 * @param {string} [params.senderName]
 * @param {Date} [params.at]
 * @param {string} [params.messageId]
 * @param {string} [params.role] 发送者角色
 * @returns {string} 以 `<wecom-context>` 开头的多行文本；未启用任何字段时返回空串
 */
export function renderContext({
  config,
  chatType,
  chatTitle,
  chatId,
  senderId,
  senderName,
  at = new Date(),
  messageId,
  role,
}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const lines = []
  if (cfg.includeChannel) lines.push(`渠道: ${cfg.channelLabel}`)
  if (cfg.includeChatType) lines.push(`会话类型: ${chatTypeLabel(chatType)}`)
  if (cfg.includeChatTitle && chatTitle) lines.push(`会话: ${chatTitle}`)
  else if (cfg.includeChatTitle && chatId) lines.push(`会话: ${chatId}`)
  if (cfg.includeSender) {
    const who = senderName ? `${senderName} (${senderId})` : senderId
    lines.push(`发送者: ${who}${role ? ` ［角色: ${role}］` : ''}`)
  }
  if (cfg.includeTime) lines.push(`时间: ${formatTime(at, cfg.timeZone)} (${zoneName(cfg.timeZone)})`)
  if (cfg.includeMessageId && messageId) lines.push(`消息ID: ${messageId}`)
  if (lines.length === 0) return ''
  return `<wecom-context>\n${lines.join('\n')}\n</wecom-context>`
}

/**
 * 把上下文块与实际内容拼成一条完整的模型输入。
 * 审批类提示（`includeApprovalHint`）告诉模型「用户在企微里等着」，
 * 避免它输出面向 IDE 的长篇大论。
 */
export function composeInboundMessage({ context, content, hint }) {
  const parts = []
  if (context) parts.push(context)
  if (hint) parts.push(hint)
  parts.push(content)
  return parts.join('\n\n')
}

/** 入站消息的默认行为提示。 */
export function inboundHint(chatType) {
  return chatType === 'group'
    ? '（这条消息来自企业微信群聊。请简明作答，必要时用 Markdown；不要输出只有终端看得懂的字符画。）'
    : '（这条消息来自企业微信单聊。请简明作答，必要时用 Markdown。）'
}

/**
 * 出站把模型回答裁剪成适合企微的形态：
 * - 企微 markdown 不支持表格语法，转成列表；
 * - 去掉超长代码块（保留前后各 N 行）；
 * - 限制总长度（企微单条 20480 字节）。
 */
export function toWecomMarkdown(text, { maxBytes = 20000, maxCodeLines = 30 } = {}) {
  if (typeof text !== 'string') return ''
  let out = text
  // 代码块瘦身
  out = out.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const lines = String(body).split('\n')
    const head = lines.slice(0, maxCodeLines).join('\n')
    const omitted = lines.length - maxCodeLines
    const tail = omitted > 0 ? `\n…（省略 ${omitted} 行）` : ''
    return `\`\`\`${lang}\n${head}${tail}\n\`\`\``
  })
  // 表格 → 列表（企微 markdown 不渲染表格）
  out = out.replace(/((?:^\|.*\|\s*$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').map((r) => r.trim()).filter((r) => r.length > 0)
    if (rows.length < 2) return block
    const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const header = cells(rows[0])
    const body = rows.slice(2).map(cells) // 跳过 |---| 分隔行
    return body.map((row) => `- ${header.map((h, i) => `**${h}** ${row[i] ?? ''}`).join('，')}`).join('\n')
  })
  // 字节上限
  const buf = Buffer.from(out, 'utf8')
  if (buf.length > maxBytes) {
    out = `${buf.subarray(0, maxBytes - 32).toString('utf8')}\n\n…（内容过长已截断）`
  }
  return out
}

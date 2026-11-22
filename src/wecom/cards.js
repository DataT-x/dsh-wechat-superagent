/**
 * 企微模板卡片构造。
 *
 * 目标：**简洁好看 + 信息完整 + 点一下就批**。
 *
 * 卡片选型：
 *   - button_interaction —— 审批卡（最多 6 个按钮，足够放「通过/驳回/查看详情/转交/暂缓」）
 *   - text_notice        —— 结果通知卡（审批结束后原地更新）
 *
 * 按钮 key 编码（必须能防伪造）：
 *   `wsa:<action>:<approvalId>:<hmac8>`
 *   其中 hmac8 是 `HMAC-SHA256(secret, "<action>|<approvalId>")` 的前 8 位十六进制。
 *   用户点按钮时企微只回传 key，我们用同一密钥重算即可验证来源与动作未被篡改。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** 卡片规范限制（企微官方限制，超出会被拒或截断）。 */
export const LIMITS = {
  title: 26,
  titleDesc: 30,
  subTitleText: 112,
  horizontalList: 6,
  horizontalKeyname: 5,
  horizontalValue: 26,
  jumpList: 3,
  jumpTitle: 13,
  buttonList: 6,
  buttonText: 10,
  verticalList: 4,
  verticalTitle: 26,
  verticalDesc: 112,
  taskId: 128,
}

/** 截断到 N 个字符（按码点，避免劈开代理对）。 */
export function clip(text, max) {
  if (typeof text !== 'string') return ''
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** 卡片按钮 key 的 HMAC。 */
export function signAction(secret, action, approvalId) {
  return createHmac('sha256', String(secret ?? ''))
    .update(`${action}|${approvalId}`)
    .digest('hex')
    .slice(0, 12)
}

/** 编码按钮 key。 */
export function encodeButtonKey(secret, action, approvalId) {
  return `wsa:${action}:${approvalId}:${signAction(secret, action, approvalId)}`
}

/**
 * 解析并校验按钮 key。
 * @returns {{ ok: true, action: string, approvalId: string } | { ok: false, reason: string }}
 */
export function decodeButtonKey(secret, key) {
  if (typeof key !== 'string') return { ok: false, reason: '按钮 key 缺失' }
  const m = /^wsa:([a-z0-9._-]{1,32}):(apr_[A-Za-z0-9]{6,40}):([a-f0-9]{12})$/.exec(key)
  if (!m) return { ok: false, reason: '按钮 key 格式不对（可能来自旧版本卡片）' }
  const [, action, approvalId, mac] = m
  const expected = signAction(secret, action, approvalId)
  // 定长比较，避免时序侧信道
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: '按钮 key 签名校验失败' }
  }
  return { ok: true, action, approvalId }
}

/** 风险色（企微 desc_color: 0灰 1黑 2红 3绿）。 */
const RISK_COLOR = { low: 3, medium: 1, high: 2, critical: 2 }

/** 风险徽标。 */
const RISK_BADGE = { low: '🟢 低风险', medium: '🟡 中风险', high: '🟠 高风险', critical: '🔴 严重' }

/** 阶段文案。 */
const STAGE_TEXT = {
  'pending-primary': '待一级审批',
  'pending-owner': '待负责人审批',
  approved: '已通过',
  rejected: '已驳回',
  expired: '已过期',
  cancelled: '已取消',
}

/**
 * 构造审批卡。
 * @param {object} params
 * @param {object} params.approval 审批记录（见 ARCHITECTURE 四）
 * @param {string} params.secret 签名密钥
 * @param {{ primary: string[], owner: string|null }} params.approvers
 * @param {number} [params.now]
 * @returns {object} TemplateCard
 */
export function buildApprovalCard({ approval, secret, approvers, now = Date.now() }) {
  const risk = approval.risk ?? 'medium'
  const remaining = Math.max(0, Math.round(((approval.expiresAt ? Date.parse(approval.expiresAt) : now) - now) / 60000))
  const detail = approval.detail ?? {}

  const horizontal = [
    { keyname: '动作', value: clip(approval.actionLabel ?? approval.action ?? '', LIMITS.horizontalValue) },
    { keyname: '仓库', value: clip(detail.repo || '—', LIMITS.horizontalValue) },
    { keyname: '分支', value: clip(detail.branch || '—', LIMITS.horizontalValue) },
    { keyname: '发起', value: clip(approval.requestedBy?.name || approval.requestedBy?.userId || '—', LIMITS.horizontalValue) },
    { keyname: '剩余', value: `${remaining} 分钟` },
  ].filter((row) => row.value.length > 0).slice(0, LIMITS.horizontalList)

  /** @type {Array<{ text: string, key: string, style?: number }>} */
  const buttons = []

  if (approval.stage === 'pending-primary' || approval.stage === 'pending-owner') {
    buttons.push({ text: '通过', key: encodeButtonKey(secret, 'approve', approval.id), style: 1 })
    buttons.push({ text: '驳回', key: encodeButtonKey(secret, 'reject', approval.id), style: 2 })
    buttons.push({ text: '详情', key: encodeButtonKey(secret, 'detail', approval.id), style: 4 })
    buttons.push({ text: '暂缓', key: encodeButtonKey(secret, 'defer', approval.id), style: 3 })
  } else {
    buttons.push({ text: '查看详情', key: encodeButtonKey(secret, 'detail', approval.id), style: 4 })
  }

  const card = {
    card_type: 'button_interaction',
    source: {
      desc: 'DSH 审批',
      desc_color: RISK_COLOR[risk] ?? 1,
    },
    main_title: {
      title: clip(`${approval.icon ?? '🔐'} ${approval.actionLabel ?? '操作审批'}`, LIMITS.title),
      desc: clip(`${RISK_BADGE[risk] ?? ''} · ${STAGE_TEXT[approval.stage] ?? approval.stage}`, LIMITS.titleDesc),
    },
    sub_title_text: clip(buildBody(detail, approval), LIMITS.subTitleText),
    horizontal_content_list: horizontal,
    jump_list: buildJumps(detail),
    button_list: buttons.slice(0, LIMITS.buttonList),
    task_id: clip(approval.id, LIMITS.taskId),
  }
  return card
}

/** 卡片正文：把证据压成 2–3 行可读文字。 */
function buildBody(detail, approval) {
  const lines = []
  if (approval.summary) lines.push(approval.summary)
  if (Array.isArray(detail.files) && detail.files.length > 0) {
    const names = detail.files.slice(0, 3).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean)
    const more = detail.files.length > 3 ? ` 等 ${detail.files.length} 个文件` : ''
    lines.push(`改动: ${names.join('、')}${more}`)
  }
  if (Array.isArray(detail.commits) && detail.commits.length > 0) {
    const first = detail.commits[0]
    lines.push(`提交: ${detail.commits.length} 个，最新 ${typeof first === 'string' ? first : first.subject}`)
  }
  if (detail.diffStat) lines.push(`统计: ${detail.diffStat}`)
  if (detail.command) lines.push(`命令: ${detail.command}`)
  // 需要输入确认短语的动作，必须在卡片上写明「点通过后会发生什么」，
  // 否则审批人不知道还要再输一次短语。
  if (approval.phrase) {
    lines.push(`⚠️ 通过需确认短语「${approval.phrase}」`)
  }
  return lines.join('\n')
}

/** 跳转链接：仓库、提交、DSH 本地页面（可选）。 */
function buildJumps(detail) {
  const jumps = []
  if (detail.repoUrl) jumps.push({ type: 1, title: clip('打开仓库', LIMITS.jumpTitle), url: detail.repoUrl })
  if (detail.compareUrl) jumps.push({ type: 1, title: clip('查看改动', LIMITS.jumpTitle), url: detail.compareUrl })
  if (detail.dshUrl) jumps.push({ type: 1, title: clip('在 DSH 处理', LIMITS.jumpTitle), url: detail.dshUrl })
  return jumps.slice(0, LIMITS.jumpList)
}

/**
 * 构造审批结果通知卡（批准/驳回后原地更新）。
 * @param {object} params
 * @param {object} params.approval
 * @param {'approved'|'rejected'|'expired'|'cancelled'} params.outcome
 * @param {object} [params.actor] { userId, name, comment }
 */
export function buildResultCard({ approval, outcome, actor }) {
  const icon = outcome === 'approved' ? '✅' : outcome === 'rejected' ? '⛔' : outcome === 'expired' ? '⌛' : '🚫'
  const titleText = outcome === 'approved' ? '审批通过' : outcome === 'rejected' ? '审批驳回' : outcome === 'expired' ? '审批已过期' : '审批已取消'
  const horizontal = [
    { keyname: '动作', value: clip(approval.actionLabel ?? approval.action ?? '', LIMITS.horizontalValue) },
    { keyname: '决策人', value: clip(actor?.name || actor?.userId || '—', LIMITS.horizontalValue) },
  ]
  if (actor?.comment) horizontal.push({ keyname: '意见', value: clip(actor.comment, LIMITS.horizontalValue) })
  return {
    card_type: 'text_notice',
    source: { desc: 'DSH 审批', desc_color: outcome === 'approved' ? 3 : 2 },
    main_title: {
      title: clip(`${icon} ${titleText}`, LIMITS.title),
      desc: clip(approval.actionLabel ?? approval.action ?? '', LIMITS.titleDesc),
    },
    sub_title_text: clip(approval.summary ?? '', LIMITS.subTitleText),
    horizontal_content_list: horizontal.slice(0, LIMITS.horizontalList),
    task_id: clip(approval.id, LIMITS.taskId),
  }
}

/**
 * 构造「任务已受理」的通知卡。
 */
export function buildTaskCard({ title, summary, rows, jumpUrl }) {
  return {
    card_type: 'text_notice',
    source: { desc: 'DSH', desc_color: 0 },
    main_title: { title: clip(title, LIMITS.title), desc: clip(summary ?? '', LIMITS.titleDesc) },
    horizontal_content_list: (rows ?? []).slice(0, LIMITS.horizontalList).map((r) => ({
      keyname: clip(r.keyname, LIMITS.horizontalKeyname),
      value: clip(r.value, LIMITS.horizontalValue),
    })),
    jump_list: jumpUrl ? [{ type: 1, title: '查看', url: jumpUrl }] : [],
  }
}

/** 审批卡的文字摘要（用于单聊/群聊里 @ 人的那句提示）。 */
export function approvalMentionText(approval, approvers, stage) {
  const who = stage === 'pending-owner'
    ? (approvers.owner ? `<@${approvers.owner}>` : '负责人')
    : (approvers.primary.length > 0 ? approvers.primary.map((u) => `<@${u}>`).join(' ') : '审批人')
  return `${who} 请审批：${approval.actionLabel ?? approval.action}（${approval.id.slice(-6)}）`
}

export { RISK_BADGE, STAGE_TEXT }

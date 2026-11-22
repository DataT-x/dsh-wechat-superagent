/**
 * 配置：schema + 默认值 + 归一化。
 *
 * 两份文件分工：
 *   config.json   可公开的配置（会出现在设置面板、日志、卡片里）
 *   secrets.json  机器人 secret、审批签名密钥（永不回传模型）
 *
 * 配置的每一层都要能在**缺失**的情况下工作：
 * 插件首次加载时用户还没填任何东西，此时不能崩。
 */
import { ROLES } from './core/authz.js'
import { defaultRules } from './gate/rules.js'

/** 默认配置。 */
export function defaultConfig() {
  return {
    version: 1,
    enabled: false,
    bot: {
      botId: '',
      secretRef: 'secret.json', // 占位：真实 secret 在 secrets.json
      wsUrl: '',
      autoReconnect: true,
    },
    ownerUserId: '',
    secondOwners: [],
    people: [], // [{ userId, name, role, note }]
    defaultApprovers: [],
    allowedGroupIds: [],
    autoBind: false,
    context: {
      channelLabel: '企业微信',
      includeChannel: true,
      includeChatType: true,
      includeChatTitle: true,
      includeSender: true,
      includeTime: true,
      includeMessageId: false,
      includeApprovalHint: true,
      timeZone: '',
    },
    approval: {
      enabled: true,
      defaultTimeoutMin: 30,
      notifyOnCreate: true,
      notifyOnSettle: true,
      allowSelfApproveByOwner: false,
      phraseRequiredForCritical: true,
    },
    rules: defaultRules(),
    watch: {
      defaultIntervalSec: 60,
      maxWatchesPerChat: 6,
      autoWake: true,
    },
    ui: {
      language: 'zh',
      showStatusBar: true,
    },
  }
}

/** 深合并默认值（用户配置优先），数组整体替换。 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = deepMerge(base, input)
  // 校验与夹取
  merged.people = (Array.isArray(merged.people) ? merged.people : [])
    .filter((p) => p && typeof p.userId === 'string' && p.userId.trim().length > 0)
    .map((p) => ({
      userId: p.userId.trim(),
      name: typeof p.name === 'string' ? p.name.trim() : '',
      role: ROLES.includes(p.role) ? p.role : 'viewer',
      note: typeof p.note === 'string' ? p.note.slice(0, 200) : '',
    }))
  merged.secondOwners = uniqStrings(merged.secondOwners)
  merged.defaultApprovers = uniqStrings(merged.defaultApprovers)
  merged.allowedGroupIds = uniqStrings(merged.allowedGroupIds)
  merged.ownerUserId = typeof merged.ownerUserId === 'string' ? merged.ownerUserId.trim() : ''
  merged.bot.botId = typeof merged.bot.botId === 'string' ? merged.bot.botId.trim() : ''
  merged.bot.wsUrl = typeof merged.bot.wsUrl === 'string' ? merged.bot.wsUrl.trim() : ''
  merged.watch.defaultIntervalSec = clamp(merged.watch.defaultIntervalSec, 30, 3600, 60)
  merged.watch.maxWatchesPerChat = clamp(merged.watch.maxWatchesPerChat, 1, 50, 6)
  merged.approval.defaultTimeoutMin = clamp(merged.approval.defaultTimeoutMin, 1, 1440, 30)
  // 规则表：保证每个已知动作都在
  merged.rules = { ...defaultRules(), ...(merged.rules && typeof merged.rules === 'object' ? merged.rules : {}) }
  merged.version = 1
  return merged
}

/** 配置里哪些字段**不能**给模型看（其实都不该给，但明确标注）。 */
export const NEVER_TO_MODEL = new Set(['bot.secret', 'signingSecret'])

function uniqStrings(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()))]
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out = { ...base }
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in out ? deepMerge(out[k], v) : v
    }
    return out
  }
  return override === undefined ? base : override
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 给设置面板用的 schema 描述（前端渲染表单）。 */
export function configSchema() {
  return {
    fields: [
      { key: 'enabled', type: 'boolean', label: '启用企业微信连接', group: 'basic' },
      { key: 'bot.botId', type: 'string', label: '机器人 ID (botId)', group: 'basic', placeholder: '从企微管理后台复制' },
      { key: 'bot.wsUrl', type: 'string', label: 'WebSocket 地址（私有部署才填）', group: 'basic', advanced: true },
      { key: 'ownerUserId', type: 'string', label: '负责人 userId', group: 'people', required: true },
      { key: 'secondOwners', type: 'string[]', label: '第二负责人（发布/部署需要）', group: 'people' },
      { key: 'defaultApprovers', type: 'string[]', label: '默认一级审批人', group: 'people' },
      { key: 'people', type: 'people', label: '成员与角色', group: 'people' },
      { key: 'allowedGroupIds', type: 'string[]', label: '允许响应的群 chatId（空=不限）', group: 'people', advanced: true },
      { key: 'autoBind', type: 'boolean', label: '自动绑定最近活跃会话', group: 'routing' },
      { key: 'context.includeChannel', type: 'boolean', label: '上下文：渠道', group: 'context' },
      { key: 'context.includeChatType', type: 'boolean', label: '上下文：会话类型', group: 'context' },
      { key: 'context.includeChatTitle', type: 'boolean', label: '上下文：会话标题', group: 'context' },
      { key: 'context.includeSender', type: 'boolean', label: '上下文：发送者昵称', group: 'context' },
      { key: 'context.includeTime', type: 'boolean', label: '上下文：发送时间', group: 'context' },
      { key: 'context.includeMessageId', type: 'boolean', label: '上下文：消息 ID', group: 'context' },
      { key: 'approval.enabled', type: 'boolean', label: '启用审批闸', group: 'approval' },
      { key: 'approval.defaultTimeoutMin', type: 'number', label: '默认审批时限（分钟）', group: 'approval' },
      { key: 'watch.defaultIntervalSec', type: 'number', label: '守望轮询间隔（秒）', group: 'watch' },
    ],
  }
}

/** 从配置中取某个点路径的值。 */
export function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}

/** 设置某个点路径的值（返回新对象）。 */
export function setPath(obj, path, value) {
  const keys = String(path).split('.')
  const clone = JSON.parse(JSON.stringify(obj ?? {}))
  let cursor = clone
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (!isPlainObject(cursor[k])) cursor[k] = {}
    cursor = cursor[k]
  }
  cursor[keys[keys.length - 1]] = value
  return clone
}

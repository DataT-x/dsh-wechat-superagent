/**
 * 权限判定：谁能给机器人下命令、谁能审批、谁能改配置。
 *
 * 企业微信长连接帧里的 `from.userid` 由企微侧签发，不可伪造；
 * 但**群聊里任何人都能发消息**，所以身份可信 ≠ 有权限。
 *
 * 角色模型（自高到低）：
 *   owner     负责人 —— 一切审批的最终关卡；可改配置、可管角色
 *   approver  审批人 —— 可审批一级节点
 *   operator  操作员 —— 可下任务、可发起审批，不能审批
 *   viewer    旁观者 —— 只能查询状态
 *
 * 未登记的一律 `denied`（fail-closed），不会因为「没配置」而放开。
 */

export const ROLES = /** @type {const} */ (['owner', 'approver', 'operator', 'viewer'])
const RANK = { owner: 3, approver: 2, operator: 1, viewer: 0 }

/** 把配置里的角色表规范化成 Map<userId, role>。 */
export function buildRoleTable(config) {
  /** @type {Map<string, string>} */
  const table = new Map()
  const people = Array.isArray(config?.people) ? config.people : []
  for (const person of people) {
    if (!person || typeof person.userId !== 'string' || person.userId.length === 0) continue
    const role = ROLES.includes(person.role) ? person.role : 'viewer'
    // 同一人出现多次取最高权限，避免配置顺序依赖
    const prev = table.get(person.userId)
    if (prev === undefined || RANK[role] > RANK[prev]) table.set(person.userId, role)
  }
  // 负责人默认是 owner，且永远不能把自己降级掉（防止配置写错锁死系统）
  const owner = config?.ownerUserId
  if (typeof owner === 'string' && owner.length > 0) {
    const prev = table.get(owner)
    if (prev === undefined || RANK[prev] < RANK.owner) table.set(owner, 'owner')
  }
  return table
}

/** 查某人的角色；未登记返回 null。 */
export function roleOf(config, userId) {
  if (typeof userId !== 'string' || userId.length === 0) return null
  return buildRoleTable(config).get(userId) ?? null
}

/** 某人是否至少达到某角色。 */
export function atLeast(config, userId, role) {
  const actual = roleOf(config, userId)
  if (actual === null) return false
  return RANK[actual] >= RANK[role]
}

/**
 * 判定一次入站操作是否允许。
 * @param {object} params
 * @param {object} params.config 插件配置
 * @param {string} params.userId 企微 userid
 * @param {string} params.chatType 'single' | 'group'
 * @param {string} [params.chatId]
 * @param {'command'|'approve'|'query'|'configure'} params.intent
 * @returns {{ allowed: boolean, role: string|null, reason?: string }}
 */
export function authorize({ config, userId, chatType, chatId, intent }) {
  const role = roleOf(config, userId)
  if (role === null) {
    return { allowed: false, role: null, reason: '你不在授权名单里。请让负责人把你加入「成员」并分配角色。' }
  }
  // 群聊闸：允许指定「只在这些群里响应」，未配置则所有群都响应（但仍要求角色）
  const allowedGroups = Array.isArray(config?.allowedGroupIds) ? config.allowedGroupIds : []
  if (chatType === 'group' && allowedGroups.length > 0 && !allowedGroups.includes(chatId)) {
    return { allowed: false, role, reason: '这个群不在允许列表里。' }
  }
  const need = intent === 'configure' ? 'owner'
    : intent === 'approve' ? 'approver'
      : intent === 'command' ? 'operator'
        : 'viewer'
  if (!atLeast(config, userId, need)) {
    return { allowed: false, role, reason: `该操作需要「${need}」及以上权限，你当前是「${role}」。` }
  }
  return { allowed: true, role }
}

/** 某个审批节点应该由谁处理。 */
export function approversFor(config, request) {
  const owner = typeof config?.ownerUserId === 'string' && config.ownerUserId.length > 0
    ? config.ownerUserId : null
  const explicit = Array.isArray(request?.approvers)
    ? request.approvers.filter((u) => typeof u === 'string' && u.length > 0)
    : []
  const configured = Array.isArray(config?.defaultApprovers)
    ? config.defaultApprovers.filter((u) => typeof u === 'string' && u.length > 0)
    : []
  const base = explicit.length > 0 ? explicit : configured.length > 0 ? configured : eligibleApprovers(config)
  // 去重且排除负责人（负责人单独走二级）
  const primary = [...new Set(base)].filter((u) => u !== owner)
  return { primary, owner }
}

/** 默认的「谁能被 @」。 */
export function mentionTargets(config, request) {
  const { primary, owner } = approversFor(config, request)
  const out = [...primary]
  if (owner !== null && !out.includes(owner)) out.push(owner)
  return out
}

/** 默认一级审批人的兜底名单：approver 与 owner 角色（负责人单独走二级）。 */
export function eligibleApprovers(config) {
  const table = buildRoleTable(config)
  const owner = typeof config?.ownerUserId === 'string' && config.ownerUserId.length > 0 ? config.ownerUserId : null
  return [...table.entries()]
    .filter(([, role]) => role === 'approver' || role === 'owner')
    .map(([id]) => id)
    .filter((id) => id !== owner)
}

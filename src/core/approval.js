/**
 * 审批引擎：把「工具调用」变成「有人点了通过才算数」。
 *
 * 生命周期：
 *   classify → createApproval → (推卡片) → decide(primary) → decide(owner) → settle
 *
 * 关键约束（全部 fail-closed）：
 *   1. 超时 = 拒绝。
 *   2. 断线 = 拒绝（不能因为发不出卡片就默默放行）。
 *   3. 审批人不在线时，卡片仍然发出；但任何决策都必须通过身份校验。
 *   4. 发起人不能审批自己的请求（除非他是负责人且配置允许）。
 *   5. 同一审批只结算一次（幂等）。
 *
 * 本模块不直接依赖企微，只暴露 `on('ask', ...)` 让上层决定怎么送达。
 */
import { EventEmitter } from 'node:events'
import { asLogger } from './log.js'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { buildRoleTable, roleOf, approversFor } from './authz.js'
import { mergeRules, ACTIONS, actionLabel, confirmationPhrase } from '../gate/rules.js'
import { appendNdjson, files, readJson, writeJson } from './state.js'
import { redactDeep } from './redact.js'

/** 生成审批 ID。 */
export function newApprovalId() {
  return `apr_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * 审批状态机允许的转移。
 */
const TRANSITIONS = {
  'pending-primary': ['approved', 'rejected', 'expired', 'cancelled'],
  'pending-owner': ['approved', 'rejected', 'expired', 'cancelled'],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
}

export class ApprovalEngine extends EventEmitter {
  /**
   * @param {object} params
   * @param {() => object} params.getConfig 读取当前配置（热更新）
   * @param {() => string} params.getSigningSecret 卡片签名密钥
   * @param {(level: string, msg: string, ...a: unknown[]) => void} [params.log]
   */
  constructor({ getConfig, getSigningSecret, log }) {
    super()
    this.getConfig = getConfig
    this.getSigningSecret = getSigningSecret
    this.log = asLogger(log)
    /** @type {Map<string, object>} */
    this.pending = new Map()
    /** @type {Map<string, { resolve: Function, timer: any }>} */
    this.waiters = new Map()
    this.disposed = false
    this.timers = new Set()
    /** @type {Map<string, any>} 审批 ID → 过期定时器 */
    this.timerIndex = new Map()
  }

  /** 启动时恢复未完成的审批（进程重启不丢）。 */
  restore() {
    const dir = files.pendingDir()
    let names = []
    try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return 0 }
    let count = 0
    for (const name of names) {
      const record = readJson(`${dir}/${name}`, null)
      if (!record || typeof record.id !== 'string') continue
      const expiresAt = Date.parse(record.expiresAt ?? '')
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        // 已过期的直接落盘为 expired（不经过 finalize：它只处理 pending 表里的记录）
        const expired = {
          ...record,
          stage: 'expired',
          settledAt: new Date().toISOString(),
          settledBy: { userId: 'system', name: '系统' },
          settleComment: '插件重启时已过期',
        }
        writeJson(files.pending(expired.id), expired)
        this.audit({ type: 'approval.settled', id: expired.id, outcome: 'expired', by: 'system', comment: '重启时已过期' })
        continue
      }
      this.pending.set(record.id, record)
      this.armTimer(record)
      count += 1
    }
    if (count > 0) this.log.info('恢复了 %d 个未完成审批', count)
    return count
  }

  /**
   * 创建审批。
   * @param {object} params
   * @param {string} params.action
   * @param {string} params.risk
   * @param {string} params.approvalPolicy primary|owner|dual|owner2|phrase|none
   * @param {object} params.detail 证据
   * @param {string} [params.summary]
   * @param {{ userId: string, name?: string, chatId?: string, chatType?: string }} params.requestedBy
   * @param {string[]} [params.approvers] 显式指定的一级审批人
   * @param {number} [params.timeoutMin]
   * @param {string} [params.sessionId]
   * @returns {object} 审批记录
   */
  create(params) {
    const config = this.getConfig()
    const rules = mergeRules(config.rules)
    const rule = rules[params.action] ?? {}
    const timeoutMin = clampTimeout(params.timeoutMin ?? rule.timeoutMin ?? 30)
    const policy = params.approvalPolicy ?? rule.approval ?? 'primary'
    const { primary, owner } = resolveApprovers({ config, explicit: params.approvers ?? rule.approvers ?? [] })
    const now = Date.now()
    const approval = {
      id: newApprovalId(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMin * 60_000).toISOString(),
      action: params.action,
      actionLabel: actionLabel(params.action),
      icon: ACTIONS[params.action]?.icon ?? '🔐',
      risk: params.risk,
      approvalPolicy: policy,
      summary: params.summary ?? ACTIONS[params.action]?.summary ?? '',
      detail: redactDeep(params.detail ?? {}),
      requestedBy: {
        userId: params.requestedBy.userId,
        name: params.requestedBy.name ?? '',
        chatId: params.requestedBy.chatId ?? '',
        chatType: params.requestedBy.chatType ?? 'single',
      },
      approvers: primary,
      owner,
      stage: policy === 'owner' || policy === 'owner2' ? 'pending-owner' : 'pending-primary',
      // `owner2` = 负责人 + 第二负责人双签；`phrase` 只加短语，不改双签语义
      // （但 critical 动作由 rules 决定是否升级为 owner2）。
      secondOwner: policy === 'owner2' ? resolveSecondOwner(config, owner) : null,
      decisions: [],
      phrase: policy === 'phrase' ? (rule.phrase ?? confirmationPhrase(params.action)) : null,
      sessionId: params.sessionId ?? null,
      toolName: params.toolName ?? null,
    }
    // owner 必须存在，否则无法完成二级审批 → 直接拒绝（fail-closed）
    if (approval.owner === null) {
      this.audit({ type: 'approval.create.refused', id: approval.id, reason: '未配置负责人', action: approval.action })
      throw new Error('未配置负责人（ownerUserId），无法发起审批。请先在设置里指定负责人。')
    }
    if (approval.stage === 'pending-primary' && approval.approvers.length === 0) {
      // 没有一级审批人 → 退回负责人
      approval.stage = 'pending-owner'
    }
    this.pending.set(approval.id, approval)
    writeJson(files.pending(approval.id), approval)
    this.armTimer(approval)
    this.audit({ type: 'approval.created', id: approval.id, action: approval.action, risk: approval.risk, by: approval.requestedBy.userId })
    this.emit('created', approval)
    return approval
  }

  /** 等待某个审批出结果（工具执行前调用）。 */
  waitFor(approvalId, signal) {
    const approval = this.pending.get(approvalId)
    if (!approval) return Promise.resolve({ outcome: 'expired', reason: '审批不存在' })
    if (this.waiters.has(approvalId)) return this.waiters.get(approvalId).promise

    let resolveFn
    const promise = new Promise((resolve) => { resolveFn = resolve })
    const entry = { resolve: resolveFn, promise, timer: null }
    this.waiters.set(approvalId, entry)
    // 有等待者了：定时器必须把进程撑住（重新 arm 一次以去掉 unref）
    this.armTimer(approval)

    const onAbort = () => {
      this.cancel(approvalId, '调用方已取消')
      resolveFn({ outcome: 'cancelled', reason: '调用方取消' })
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return promise
  }

  /**
   * 记录一个决策。
   * @param {object} params
   * @param {string} params.approvalId
   * @param {string} params.userId
   * @param {string} [params.userName]
   * @param {'approve'|'reject'} params.verdict
   * @param {string} [params.comment]
   * @param {string} [params.phrase] 二次确认短语（phrase 策略要求）
   * @param {string} [params.stage] 强制指定阶段（转交场景）
   * @returns {{ ok: boolean, reason?: string, approval?: object }}
   */
  decide({ approvalId, userId, userName, verdict, comment, phrase }) {
    const approval = this.pending.get(approvalId)
    if (!approval) return { ok: false, reason: '审批不存在或已结束' }
    const config = this.getConfig()

    // ---- 身份与阶段校验 ----
    const allowedStages = approval.stage === 'pending-primary'
      ? approval.approvers
      : approval.stage === 'pending-owner'
        ? [approval.owner, approval.secondOwner].filter(Boolean)
        : []
    if (allowedStages.length === 0) return { ok: false, reason: `审批已结束（${approval.stage}）` }
    if (!allowedStages.includes(userId)) {
      const role = roleOf(config, userId)
      // 负责人可以在任何阶段介入（兜底），但必须有 owner 角色
      if (!(role === 'owner' && userId === approval.owner)) {
        return { ok: false, reason: '你不是本节点审批人' }
      }
    }
    // 发起人不能审批自己（除非他就是负责人）
    if (userId === approval.requestedBy.userId && userId !== approval.owner) {
      return { ok: false, reason: '不能审批自己发起的请求' }
    }
    // 已经在本阶段投过票
    if (approval.decisions.some((d) => d.stage === approval.stage && d.userId === userId)) {
      return { ok: false, reason: '你已经审批过了' }
    }

    if (verdict === 'reject') {
      approval.decisions.push({ stage: approval.stage, userId, name: userName ?? '', outcome: 'reject', comment: comment ?? '', at: new Date().toISOString() })
      this.finalize(approval, 'rejected', { userId, name: userName }, comment)
      return { ok: true, approval }
    }

    // ---- 通过：校验二次确认短语 ----
    // 短语策略下，一级与负责人**都要**输入短语（各点一次，各留一次痕），
    // 这样「谁在什么时候确认了这件事」在审计里是完整的。
    if (approval.phrase !== null) {
      const provided = String(phrase ?? '').trim()
      if (provided !== approval.phrase) {
        return { ok: false, reason: `需要输入确认短语「${approval.phrase}」` }
      }
    }

    approval.decisions.push({ stage: approval.stage, userId, name: userName ?? '', outcome: 'approve', comment: comment ?? '', at: new Date().toISOString() })

    // ---- 阶段推进 ----
    if (approval.stage === 'pending-primary') {
      // 一级审批：所有人都通过才推进
      const approved = new Set(approval.decisions.filter((d) => d.stage === 'pending-primary' && d.outcome === 'approve').map((d) => d.userId))
      const missing = approval.approvers.filter((u) => !approved.has(u))
      if (missing.length > 0) {
        this.audit({ type: 'approval.partial', id: approval.id, stage: approval.stage, by: userId, missing })
        this.save(approval)
        this.emit('stage', approval, { missing })
        return { ok: true, approval, note: `还差 ${missing.join('、')} 通过` }
      }
      approval.stage = 'pending-owner'
      this.save(approval)
      this.audit({ type: 'approval.stage', id: approval.id, stage: approval.stage })
      this.emit('stage', approval, {})
      return { ok: true, approval, note: '已提交负责人二次审批' }
    }

    // 二级审批：负责人（owner2 时还要第二负责人）
    if (approval.stage === 'pending-owner') {
      if (approval.secondOwner !== null) {
        const approvedOwners = new Set(approval.decisions.filter((d) => d.stage === 'pending-owner' && d.outcome === 'approve').map((d) => d.userId))
        const need = [approval.owner, approval.secondOwner].filter(Boolean)
        const missing = need.filter((u) => !approvedOwners.has(u))
        if (missing.length > 0) {
          this.save(approval)
          this.audit({ type: 'approval.partial', id: approval.id, stage: approval.stage, by: userId, missing })
          this.emit('stage', approval, { missing })
          return { ok: true, approval, note: `还差 ${missing.join('、')} 确认` }
        }
      }
      this.finalize(approval, 'approved', { userId, name: userName }, comment)
      return { ok: true, approval }
    }
    return { ok: false, reason: '状态异常' }
  }

  /** 拒绝一个审批（引擎内部或外部取消）。 */
  cancel(approvalId, reason) {
    const approval = this.pending.get(approvalId)
    if (!approval) return false
    this.finalize(approval, 'cancelled', { userId: 'system', name: '系统' }, reason)
    return true
  }

  /** 取审批记录（含已结束的，从磁盘读）。 */
  get(approvalId) {
    return this.pending.get(approvalId) ?? readJson(files.pending(approvalId), null)
  }

  /** 列出待审批。 */
  list(filter = {}) {
    let items = [...this.pending.values()]
    if (filter.sessionId) items = items.filter((a) => a.sessionId === filter.sessionId)
    if (filter.userId) {
      items = items.filter((a) => a.stage === 'pending-primary'
        ? a.approvers.includes(filter.userId)
        : a.owner === filter.userId || a.secondOwner === filter.userId)
    }
    if (filter.stage) items = items.filter((a) => a.stage === filter.stage)
    return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }

  save(approval) {
    if (!this.pending.has(approval.id)) return
    writeJson(files.pending(approval.id), approval)
  }

  /** 终结并唤醒等待者。 */
  finalize(approval, outcome, actor, comment) {
    if (!TRANSITIONS[approval.stage]?.includes(outcome)) {
      if (approval.stage === outcome) return
    }
    approval.stage = outcome
    approval.settledAt = new Date().toISOString()
    approval.settledBy = { userId: actor?.userId ?? 'system', name: actor?.name ?? '' }
    approval.settleComment = comment ?? ''
    this.save(approval)
    this.clearTimer(approval.id)
    this.pending.delete(approval.id)
    this.audit({ type: 'approval.settled', id: approval.id, outcome, by: approval.settledBy.userId, comment: comment ?? '' })
    const waiter = this.waiters.get(approval.id)
    if (waiter) {
      this.waiters.delete(approval.id)
      waiter.resolve({ outcome, approval })
    }
    this.emit('settled', approval)
  }

  armTimer(approval) {
    this.clearTimer(approval.id)
    const expires = Date.parse(approval.expiresAt ?? '')
    if (!Number.isFinite(expires)) return
    const delay = Math.max(0, expires - Date.now())
    // setTimeout 上限约 24.8 天：超长时限分段续期，而不是一次性把时间截断
    const MAX_DELAY = 2_147_483_000
    const step = Math.min(delay, MAX_DELAY)
    const timer = setTimeout(() => {
      if (!this.pending.has(approval.id)) return
      if (delay > MAX_DELAY) {
        this.armTimer(approval)
        return
      }
      this.finalize(approval, 'expired', { userId: 'system', name: '系统' }, '超过审批时限')
    }, step)
    // 只有「当前没人等待结果」时才 unref：
    // 有等待者（某个工具调用正挂在这里）时进程必须被这个定时器撑住，
    // 否则进程提前退出会让那次调用永远拿不到结果。
    if (!this.waiters.has(approval.id) && typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    this.timerIndex.set(approval.id, timer)
  }

  clearTimer(approvalId) {
    const timer = this.timerIndex.get(approvalId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(timer)
      this.timerIndex.delete(approvalId)
    }
  }

  audit(record) {
    appendNdjson(files.audit(), { at: new Date().toISOString(), ...redactDeep(record) })
  }

  dispose() {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.timerIndex.clear()
    for (const [, waiter] of this.waiters) waiter.resolve({ outcome: 'cancelled', reason: '插件卸载' })
    this.waiters.clear()
    this.removeAllListeners()
  }
}

/** 超时时长夹取到 [1, 1440] 分钟。 */
export function clampTimeout(minutes) {
  const n = Number(minutes)
  if (!Number.isFinite(n)) return 30
  return Math.min(1440, Math.max(1, Math.round(n)))
}

/** 解析一级审批人（委托给 authz 的同一套规则，避免两处逻辑漂移）。 */
function resolveApprovers({ config, explicit }) {
  return approversFor(config, { approvers: explicit })
}

/** 第二负责人：用于 owner2 策略。 */
function resolveSecondOwner(config, owner) {
  const candidates = Array.isArray(config?.secondOwners) ? config.secondOwners : []
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c !== owner) return c
  }
  return null
}

export { approversFor }

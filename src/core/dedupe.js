/**
 * 入站消息去重。
 *
 * 企业微信长连接可能重投同一帧（网络抖动、重连补偿），
 * 而我们的一个「指令」可能触发一整个 agent 轮次——重复投递代价很高。
 *
 * 策略：msgid LRU，保留最近 N 条与 T 分钟。
 * 另外提供「幂等键」：同一审批的同一决策只生效一次。
 */

export class Dedupe {
  /**
   * @param {{ capacity?: number, ttlMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? 2000
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000
    /** @type {Map<string, number>} */
    this.seen = new Map()
  }

  /** 是否已见过（不写入）。 */
  has(key) {
    const at = this.seen.get(key)
    if (at === undefined) return false
    if (Date.now() - at > this.ttlMs) { this.seen.delete(key); return false }
    return true
  }

  /**
   * 登记并返回「是否首次」。
   * @param {string} key
   * @returns {boolean} true = 首次见到
   */
  claim(key) {
    if (typeof key !== 'string' || key.length === 0) return true
    if (this.has(key)) return false
    this.seen.set(key, Date.now())
    this.evict()
    return true
  }

  /** 释放一个键（处理失败时允许重试）。 */
  release(key) {
    this.seen.delete(key)
  }

  evict() {
    if (this.seen.size <= this.capacity) {
      // 仍然清理过期项，防止长期运行内存增长
      if (this.seen.size < this.capacity * 0.8) return
    }
    const now = Date.now()
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key)
    }
    // 仍超限：按插入顺序删最老的
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
  }

  get size() { return this.seen.size }
}

/** 审批决策的幂等键：同一审批、同一阶段、同一人，只认第一次。 */
export function decisionKey(approvalId, stage, userId) {
  return `decision:${approvalId}:${stage}:${userId}`
}

/** 入站消息的幂等键。 */
export function messageKey(frame) {
  const msgid = frame?.body?.msgid
  if (typeof msgid === 'string' && msgid.length > 0) return `msg:${msgid}`
  const reqId = frame?.headers?.req_id
  if (typeof reqId === 'string' && reqId.length > 0) return `req:${reqId}`
  return ''
}

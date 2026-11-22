/**
 * 一键创建企微机器人：复用腾讯官方的扫码授权页。
 *
 * 流程（四步，全部由本机发起，用户只需在手机企微里点两下）：
 *   1. `GET work.weixin.qq.com/ai/qc/generate?source=<来源>&plat=<平台>`
 *      → 返回 `scode`（一次性轮询码）与 `auth_url`（腾讯官方授权页）
 *   2. 把 `auth_url` 生成二维码给用户扫
 *   3. 用户在企微 App 里确认创建机器人（在腾讯页面上完成，不经过我们）
 *   4. `GET work.weixin.qq.com/ai/qc/query_result?scode=<scode>`
 *      → 成功时返回 `bot_info.botid` 与 `bot_info.secret`
 *
 * 安全要点：
 *   - `auth_url` 必须是 https + work.weixin.qq.com + 无自定义端口（防开放重定向）；
 *   - `scode` 只是轮询码，不含权限，但一旦拿到 botid/secret 就要立刻落盘并停止轮询；
 *   - 二维码 5 分钟过期；轮询有退避，不会打爆腾讯接口；
 *   - secret 只写进 secrets.json，绝不出现在任何模型可见处。
 */
import { createHash } from 'node:crypto'

const GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
const POLL_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
const QR_TTL_MS = 5 * 60_000
const POLL_INTERVAL_MS = 3_000
const REQUEST_TIMEOUT_MS = 10_000

/** 平台码：企微用它区分扫码后的落地页形态。 */
function platformCode() {
  if (process.platform === 'win32') return 2
  if (process.platform === 'linux') return 3
  return 1
}

function clean(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 校验授权页 URL：只允许腾讯官方域名，防止被中间人替换成钓鱼页。
 * @returns {string|null}
 */
export function safeAuthUrl(value) {
  const raw = clean(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'work.weixin.qq.com') return null
    if (url.port && url.port !== '443') return null
    return url.href
  } catch {
    return null
  }
}

/** 带超时的 fetch。 */
async function requestJson(url, signal, fetchImpl = globalThis.fetch) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal: combined,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`企微扫码服务返回 HTTP ${response.status}`)
  return response.json()
}

export class WeComProvisioner {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.clock]
   * @param {string} [opts.source] 来源标识，企微后台可据此统计
   * @param {number} [opts.platform]
   * @param {typeof fetch} [opts.fetch]
   */
  constructor({ clock = () => Date.now(), source = 'dsh-wecom-superagent', platform, fetch: fetchImpl } = {}) {
    this.clock = clock
    this.source = source
    this.platform = [1, 2, 3].includes(platform) ? platform : platformCode()
    this.fetch = fetchImpl ?? globalThis.fetch
    if (typeof this.fetch !== 'function') throw new TypeError('需要 fetch 实现（Node 18+ 自带）')
    /** 当前进行中的授权尝试 */
    this.session = null
  }

  /**
   * 第一步：申请二维码。
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ scode: string, verificationUrl: string, expiresAt: number, pollIntervalMs: number }>}
   */
  async start({ signal } = {}) {
    const url = new URL(GENERATE_URL)
    url.searchParams.set('source', this.source)
    url.searchParams.set('plat', String(this.platform))
    const body = await requestJson(url, signal, this.fetch)
    const scode = clean(body?.data?.scode)
    const verificationUrl = safeAuthUrl(body?.data?.auth_url)
    if (!scode || !verificationUrl) {
      throw new Error('企微扫码服务返回的数据不完整（可能是接口变更或网络被劫持）')
    }
    this.session = {
      scode,
      verificationUrl,
      startedAt: this.clock(),
      expiresAt: this.clock() + QR_TTL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    }
    return { ...this.session }
  }

  /**
   * 第二步：轮询结果。
   * @param {{ scode?: string, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ status: 'waiting'|'success'|'expired'|'failed', remoteBotId?: string, secret?: string }>}
   */
  async poll({ scode, signal } = {}) {
    const code = clean(scode) ?? this.session?.scode
    if (!code) throw new TypeError('需要一个 scode（先调用 start()）')
    if (this.session && this.session.expiresAt < this.clock()) {
      return { status: 'expired' }
    }
    const url = new URL(POLL_URL)
    url.searchParams.set('scode', code)
    const body = await requestJson(url, signal, this.fetch)
    const state = clean(body?.data?.status)?.toLowerCase()
    if (state === 'success') {
      const remoteBotId = clean(body?.data?.bot_info?.botid)
      const secret = clean(body?.data?.bot_info?.secret)
      if (!remoteBotId || !secret) throw new Error('企微返回了成功但没有带上 botid/secret')
      // 拿到了就清掉会话，避免重复使用
      this.session = null
      return { status: 'success', remoteBotId, secret }
    }
    if (state === 'expired' || state === 'timeout') return { status: 'expired' }
    if (state === 'fail' || state === 'failed' || state === 'error') return { status: 'failed' }
    return { status: 'waiting' }
  }

  /** 当前会话是否还在有效期内。 */
  get active() {
    return this.session !== null && this.session.expiresAt > this.clock()
  }

  /** 取消当前尝试。 */
  cancel() {
    this.session = null
  }
}

/** 本地 ID：由 botid 派生，稳定且不泄露原值。 */
export function deriveLocalBotId(remoteBotId) {
  const digest = createHash('sha256').update(String(remoteBotId)).digest('hex').slice(0, 20)
  return `wecom_${digest}`
}

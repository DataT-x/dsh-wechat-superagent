/**
 * 仓库守望：盯住 Git 项目，有动静就叫醒会话。
 *
 * 两条腿：
 *   1. **本地 git**（主路径）：每 N 秒 `git fetch` + 比较远端分支，发现新提交/新标签。
 *      优点：不需要任何 token，私有仓库也能用，正好覆盖「有企微机器人权限的人
 *      都能给他下达任务」的场景——任务在企微里下，代码在本地跑。
 *   2. **GitHub API**（可选）：盯 issue / PR / review request，用于「别人提了 PR
 *      或者 @ 我」这类事件。需要 `gh` 已登录或提供 token。
 *
 * 水位（watermark）设计：每个 watch 记录上次报告的 commit sha / issue updated_at，
 * 只在**真正唤醒成功后**前移，避免「会话忙时错过消息」。
 */
import { EventEmitter } from 'node:events'
import { asLogger } from './log.js'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { git, repoRoot, primaryRemote, currentBranch } from './git.js'
import { appendNdjson, files, readJson, writeJson } from './state.js'
import { parseRemoteUrl } from './git.js'
import { redactText } from './redact.js'

const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 3600_000
const COOLDOWN_MS = 3 * 60_000

/** 规范化仓库标识：支持 owner/name、gitee:owner/name、本地绝对路径。 */
export function normalizeRepoSpec(spec) {
  const raw = String(spec ?? '').trim()
  if (raw.length === 0) return { kind: 'invalid', reason: '空的仓库标识' }
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { kind: 'local', path: resolve(raw) }
  }
  const provider = raw.includes(':') && !raw.includes('//') ? raw.split(':')[0].toLowerCase() : 'github'
  const rest = provider === raw.split(':')[0] ? raw.slice(provider.length + 1) : raw
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(rest)
  if (m) return { kind: 'remote', provider, repo: `${m[1]}/${m[2]}` }
  if (/^https?:\/\//.test(raw)) {
    const parsed = parseRemoteUrl(raw)
    if (parsed) return { kind: 'remote', provider, repo: parsed }
  }
  return { kind: 'invalid', reason: `看不懂的仓库标识：${raw}` }
}

export class GitWatcher extends EventEmitter {
  /**
   * @param {object} params
   * @param {() => object} params.getConfig
   * @param {object} params.state 共享状态（含 watchers 数组）
   * @param {(w: object, text: string) => Promise<boolean>} params.wake 唤醒回调，返回是否成功
   * @param {(level: string, msg: string, ...a: unknown[]) => void} [params.log]
   */
  constructor({ getConfig, state, wake, log, saveState }) {
    super()
    this.getConfig = getConfig
    this.state = state
    this.wake = wake
    this.log = asLogger(log)
    this.saveState = saveState ?? (() => {})
    /** @type {Map<string, { timer: any, running: boolean }>} */
    this.runtimes = new Map()
    this.disposed = false
  }

  /** 启动所有守望。 */
  start() {
    for (const w of this.state.watchers ?? []) this.arm(w)
    this.log.info('启动 %d 个仓库守望', (this.state.watchers ?? []).length)
  }

  /** 列出所有守望。 */
  list() {
    return [...(this.state.watchers ?? [])]
  }

  /**
   * 新增一个守望。
   * @param {object} params
   * @param {string} params.repo
   * @param {string} params.chatId
   * @param {string} [params.chatType]
   * @param {string} [params.addedBy]
   * @param {number} [params.intervalMs]
   * @param {string} [params.sessionId]
   * @param {string[]} [params.events] 订阅的事件：commits, tags, issues, pulls
   */
  async add({ repo, chatId, chatType = 'single', addedBy, intervalMs, sessionId, events }) {
    const spec = normalizeRepoSpec(repo)
    if (spec.kind === 'invalid') return { ok: false, reason: spec.reason }
    const existing = (this.state.watchers ?? []).find((w) => w.chatId === chatId && w.spec.chatId !== false && sameRepo(w, spec))
    if (existing) return { ok: false, reason: `已经在守望 ${repo} 了` }

    const watch = {
      id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      spec,
      repo: spec.kind === 'local' ? spec.path : spec.repo,
      provider: spec.provider ?? 'local',
      chatId,
      chatType,
      sessionId: sessionId ?? null,
      addedBy: addedBy ?? '',
      addedAt: new Date().toISOString(),
      intervalMs: clampInterval(intervalMs ?? DEFAULT_INTERVAL_MS),
      events: Array.isArray(events) && events.length > 0 ? events : ['commits', 'tags'],
      watermark: {},
      ghSeen: {},
      ghCursor: null,
      ghLogin: null,
      lastCheckAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextAt: null,
      paused: false,
    }
    // 首次检查只记录水位，不唤惊醒 —— 否则一订阅就收到一堆历史提交
    const baseline = await this.snapshot(watch)
    if (baseline.ok) {
      watch.watermark = baseline.watermark
      watch.lastCheckAt = new Date().toISOString()
    } else {
      watch.lastError = baseline.error ?? '首次检查失败'
    }
    this.state.watchers = [...(this.state.watchers ?? []), watch]
    this.saveState()
    this.arm(watch)
    this.audit({ type: 'watch.add', id: watch.id, repo: watch.repo, by: addedBy })
    return { ok: true, intervalMs: watch.intervalMs, baseline: watch.watermark }
  }

  /** 移除一个守望。 */
  async remove({ repo, chatId }) {
    const spec = normalizeRepoSpec(repo)
    const before = (this.state.watchers ?? []).length
    this.state.watchers = (this.state.watchers ?? []).filter((w) => !(w.chatId === chatId && sameRepo(w, spec)))
    if (this.state.watchers.length === before) return { ok: false, reason: `没有在守望 ${repo}` }
    for (const [id, rt] of this.runtimes) {
      if (!this.state.watchers.some((w) => w.id === id)) { clearTimeout(rt.timer); this.runtimes.delete(id) }
    }
    this.saveState()
    this.audit({ type: 'watch.remove', repo, by: chatId })
    return { ok: true }
  }

  /** 暂停/恢复。 */
  setPaused(id, paused) {
    const w = (this.state.watchers ?? []).find((x) => x.id === id)
    if (!w) return false
    w.paused = paused
    if (paused) {
      const rt = this.runtimes.get(id)
      if (rt) { clearTimeout(rt.timer); this.runtimes.delete(id) }
    } else {
      this.arm(w)
    }
    this.saveState()
    return true
  }

  /** 给一个守望装定时器。 */
  arm(watch) {
    if (this.disposed || watch.paused) return
    const existing = this.runtimes.get(watch.id)
    if (existing?.timer) clearTimeout(existing.timer)
    const rt = existing ?? { timer: null, running: false }
    const delay = this.nextDelay(watch)
    rt.timer = setTimeout(() => { void this.tick(watch.id) }, delay)
    if (typeof rt.timer.unref === 'function') rt.timer.unref()
    this.runtimes.set(watch.id, rt)
  }

  nextDelay(watch) {
    const now = Date.now()
    if (watch.nextAt) {
      const at = Date.parse(watch.nextAt)
      if (Number.isFinite(at) && at > now) return Math.min(at - now, watch.intervalMs)
    }
    // 加入抖动，避免多个守望同时打远端
    const jitter = Math.floor(Math.random() * Math.min(5000, watch.intervalMs * 0.1))
    return watch.intervalMs + jitter
  }

  /** 一次检查。 */
  async tick(id) {
    if (this.disposed) return
    const watch = (this.state.watchers ?? []).find((w) => w.id === id)
    if (!watch || watch.paused) return
    const rt = this.runtimes.get(id) ?? { timer: null, running: false }
    if (rt.running) return
    rt.running = true
    this.runtimes.set(id, rt)
    try {
      await this.check(watch)
    } catch (error) {
      watch.lastError = redactText(String(error?.message ?? error))
      watch.consecutiveFailures = (watch.consecutiveFailures ?? 0) + 1
      this.log.warn('守望 %s 检查失败: %s', watch.repo, watch.lastError)
    } finally {
      rt.running = false
      rt.timer = null
      watch.lastCheckAt = new Date().toISOString()
      this.saveState()
      if (!this.disposed) this.arm(watch)
    }
  }

  /** 取当前状态快照（不唤醒）。 */
  async snapshot(watch) {
    if (watch.spec.kind === 'local' || existsSync(watch.repo)) return this.snapshotLocal(watch)
    return this.snapshotRemote(watch)
  }

  async snapshotLocal(watch) {
    const cwd = watch.repo
    if (!existsSync(cwd)) return { ok: false, error: `本地路径不存在：${cwd}` }
    const root = await repoRoot(cwd)
    if (!root) return { ok: false, error: '不是 git 仓库' }
    watch.root = root
    const branch = await currentBranch(root)
    const remote = await primaryRemote(root)
    if (remote.name) {
      // 静默 fetch，失败不算致命（可能离线）
      const f = await git(root, ['fetch', '--quiet', '--prune', remote.name])
      if (!f.ok) this.log.debug('fetch 失败（可忽略）: %s', redactText(f.stderr.slice(0, 200)))
    }
    const head = await git(root, ['rev-parse', 'HEAD'])
    const tags = await git(root, ['tag', '--sort=-creatordate', '--points-at', 'HEAD'])
    const log = await git(root, ['log', '--format=%H%x09%h%x09%s%x09%an%x09%aI', '--max-count=30'])
    const latestTags = await git(root, ['tag', '--sort=-creatordate'])
    return {
      ok: true,
      watermark: {
        head: head.ok ? head.stdout.trim() : '',
        branch,
        remote: remote.name,
        repo: remote.repo,
        tags: tags.ok ? tags.stdout.split(/\r?\n/).filter(Boolean) : [],
        latestTag: latestTags.ok ? (latestTags.stdout.split(/\r?\n/).filter(Boolean)[0] ?? '') : '',
        recentCommits: log.ok ? log.stdout.split(/\r?\n/).filter(Boolean).slice(0, 10) : [],
        checkedAt: new Date().toISOString(),
      },
    }
  }

  async snapshotRemote(watch) {
    // 远端仓库：本地没有克隆时，用 gh api 读分支头
    const repo = watch.repo
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: '仓库标识不合法' }
    const r = await gh(['api', `repos/${repo}/commits?per_page=5`, '--jq', 'map({sha: .sha, subject: .commit.message, author: .commit.author.name, date: .commit.author.date})'])
    if (!r.ok) return { ok: false, error: sanitizeGhError(r.stderr) }
    let commits = []
    try { commits = JSON.parse(r.stdout) } catch { return { ok: false, error: '返回不是合法 JSON' } }
    return {
      ok: true,
      watermark: {
        head: Array.isArray(commits) && commits[0] ? commits[0].sha : '',
        repo,
        recentCommits: Array.isArray(commits) ? commits.slice(0, 5).map((c) => `${c.sha.slice(0, 7)}\t${String(c.subject).split('\n')[0]}\t${c.author}`) : [],
        checkedAt: new Date().toISOString(),
      },
    }
  }

  /** 比较快照与水位，产出「新事件」。 */
  diff(watch, snapshot) {
    const wm = watch.watermark ?? {}
    const cur = snapshot.watermark ?? {}
    const events = []
    const subs = new Set(watch.events ?? ['commits', 'tags'])

    if (subs.has('commits') && cur.head && wm.head && cur.head !== wm.head) {
      // 找 wm.head 之后的新提交
      const list = (cur.recentCommits ?? []).map((line) => String(line).split('\t'))
      const idx = list.findIndex((c) => c[0] === wm.head)
      const fresh = idx >= 0 ? list.slice(0, idx) : list.slice(0, 1)
      if (fresh.length > 0) events.push({ kind: 'commits', items: fresh })
    }
    if (subs.has('tags') && cur.latestTag && cur.latestTag !== wm.latestTag) {
      events.push({ kind: 'tag', tag: cur.latestTag })
    }
    return events
  }

  /** 一次检查 → 有新事件则唤醒。 */
  async check(watch) {
    const snapshot = await this.snapshot(watch)
    if (!snapshot.ok) {
      watch.lastError = snapshot.error ?? '检查失败'
      watch.consecutiveFailures = (watch.consecutiveFailures ?? 0) + 1
      // 连续失败退避，最长 30 分钟
      if (watch.consecutiveFailures >= 3) {
        watch.nextAt = new Date(Date.now() + Math.min(30 * 60_000, watch.intervalMs * watch.consecutiveFailures)).toISOString()
      }
      this.saveState()
      this.emit('error', { watch, error: watch.lastError })
      return
    }
    watch.lastError = null
    watch.consecutiveFailures = 0
    watch.nextAt = null

    // 首次运行：只记水位
    if (!watch.watermark || !watch.watermark.head) {
      watch.watermark = snapshot.watermark
      this.saveState()
      return
    }
    const events = this.diff(watch, snapshot)

    // GitHub issue / PR 订阅（可选，需要 gh）
    if ((watch.events ?? []).some((e) => e === 'issues' || e === 'pulls') && watch.spec.kind === 'remote') {
      try {
        const ghEvents = await this.checkGithubItems(watch)
        events.push(...ghEvents)
      } catch (error) {
        this.log('debug', 'GitHub 订阅检查失败: %s', redactText(String(error?.message ?? error)))
      }
    }

    if (events.length === 0) {
      watch.watermark = { ...watch.watermark, checkedAt: snapshot.watermark.checkedAt }
      this.saveState()
      return
    }
    // 冷却期：刚唤醒过就别连着叫
    if (watch.lastWakeAt && Date.now() - Date.parse(watch.lastWakeAt) < COOLDOWN_MS) {
      this.audit({ type: 'watch.cooldown', id: watch.id, repo: watch.repo })
      this.saveState()
      return
    }
    const text = this.renderWake(watch, events, snapshot)
    const woke = await this.wake(watch, text)
    if (woke) {
      // 只有真正唤醒成功才前移水位
      watch.watermark = snapshot.watermark
      if (watch.ghPendingSeen) {
        watch.ghSeen = watch.ghPendingSeen
        delete watch.ghPendingSeen
      }
      watch.lastWakeAt = new Date().toISOString()
      watch.lastWakeSummary = text.slice(0, 300)
      this.audit({ type: 'watch.wake', id: watch.id, repo: watch.repo, events: events.map((e) => e.kind) })
      this.emit('wake', { watch, events })
    } else {
      // 唤醒失败：不退水位，下一轮重试
      delete watch.ghPendingSeen
      this.audit({ type: 'watch.wake.failed', id: watch.id, repo: watch.repo })
    }
    this.saveState()
  }

  /**
   * 检查 GitHub issue / PR。
   * 水位记在 `watch.ghSeen`（number → updated_at），只有唤醒成功才前移。
   */
  async checkGithubItems(watch) {
    const repo = watch.repo
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return []
    const wantIssues = (watch.events ?? []).includes('issues')
    const wantPulls = (watch.events ?? []).includes('pulls')
    const since = watch.ghCursor ?? null
    const args = ['api', `repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=20`]
    if (since) args.push('--jq', `map(select(.updated_at > "${since}"))`)
    const r = await gh(args)
    if (!r.ok) throw new Error(sanitizeGhError(r.stderr))
    let items = []
    try { items = JSON.parse(r.stdout || '[]') } catch { return [] }
    if (!Array.isArray(items)) return []
    const seen = watch.ghSeen ?? {}
    const fresh = []
    for (const item of items) {
      const isPull = Boolean(item.pull_request)
      if (isPull && !wantPulls) continue
      if (!isPull && !wantIssues) continue
      // 跳过自己建的（避免自我唤醒）
      if (watch.ghLogin && item.user?.login === watch.ghLogin) continue
      const prev = seen[String(item.number)]
      if (prev && item.updated_at <= prev) continue
      fresh.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        isPull,
        author: item.user?.login ?? '',
        labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        updatedAt: item.updated_at,
      })
    }
    if (fresh.length === 0) return []
    // 记录最近的已见（等唤醒成功后再提交）
    const pending = { ...seen }
    for (const f of fresh) pending[String(f.number)] = f.updatedAt
    watch.ghPendingSeen = pending
    return [{ kind: wantIssues && wantPulls ? 'items' : (wantPulls ? 'pulls' : 'issues'), items: fresh }]
  }

  /** 组装唤醒文本。 */
  renderWake(watch, events, snapshot) {
    const total = events.reduce((n, e) => n + (e.items ? e.items.length : 1), 0)
    const lines = [`【企业微信 Superagent】\`${watch.repo}\` 有 ${total} 条新动态`]
    for (const ev of events) {
      if (ev.kind === 'commits') {
        lines.push('', `**新提交 ${ev.items.length} 个**`)
        for (const [sha, short, subject, author] of ev.items.slice(0, 10)) {
          lines.push(`- \`${short ?? String(sha).slice(0, 7)}\` ${subject ?? ''}${author ? ` — ${author}` : ''}`)
        }
      }
      if (ev.kind === 'tag') lines.push('', `**新标签**：\`${ev.tag}\``)
      if (ev.kind === 'items' || ev.kind === 'issues' || ev.kind === 'pulls') {
        const label = ev.kind === 'pulls' ? 'PR' : ev.kind === 'issues' ? 'Issue' : 'Issue/PR'
        lines.push('', `**新${label} ${ev.items.length} 条**`)
        for (const item of ev.items.slice(0, 10)) {
          const tags = item.isPull ? 'PR' : 'Issue'
          const labels = item.labels.length > 0 ? ` ［${item.labels.join('、')}］` : ''
          lines.push(`- ${tags} #${item.number} ${item.title}${labels} — @${item.author}`)
          if (item.url) lines.push(`  ${item.url}`)
        }
      }
    }
    if (snapshot?.watermark?.branch) lines.push('', `分支：\`${snapshot.watermark.branch}\``)
    lines.push('', '请判断这些动静是否需要你处理；需要就直接开始，不需要就在会话里说明原因。')
    return lines.join('\n')
  }

  audit(record) {
    appendNdjson(files.audit(), { at: new Date().toISOString(), ...record })
  }

  dispose() {
    this.disposed = true
    for (const [, rt] of this.runtimes) if (rt.timer) clearTimeout(rt.timer)
    this.runtimes.clear()
    this.removeAllListeners()
  }
}

function clampInterval(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)))
}

function sameRepo(watch, spec) {
  if (spec.kind === 'local') return watch.repo === spec.path
  if (spec.kind === 'remote') return String(watch.repo).toLowerCase() === spec.repo.toLowerCase()
  return false
}

/** 调用 gh（若存在）。 */
export function gh(args) {
  return new Promise((resolvePromise) => {
    execFile('gh', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
  })
}

/** gh 错误信息脱敏 + 常见原因归类。 */
export function sanitizeGhError(stderr) {
  const text = redactText(String(stderr ?? ''))
  if (/not logged|authentication|401/i.test(text)) return 'gh 未登录或无权限（请先 `gh auth login`）'
  if (/not found|404/i.test(text)) return '仓库不存在或无访问权限'
  if (/rate limit/i.test(text)) return 'GitHub API 限流，请稍后再试'
  return text.slice(0, 300)
}

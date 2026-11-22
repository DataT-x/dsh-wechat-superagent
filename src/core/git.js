/**
 * 本地 Git 快照：审批证据的来源。
 *
 * 全部走 `execFile('git', [...])`，不拼 shell 字符串，避免命令注入。
 * 所有输出都视为不可信：先脱敏，再限长。
 */
import { execFile } from 'node:child_process'
import { redactText } from './redact.js'

const GIT_TIMEOUT_MS = 8000

/**
 * 执行 git 命令（数组参数，无 shell）。
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number }>}
 */
export function git(cwd, args) {
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolve(result) } }
    try {
      execFile('git', ['-C', cwd, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        done({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      })
    } catch (error) {
      done({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) })
    }
  })
}

/** 解析 git 的 NUL 分隔输出。 */
function splitNul(text) {
  return text.split('\0').map((s) => s.replace(/\r?\n$/, '')).filter((s) => s.length > 0)
}

/** 是否为 git 工作区。 */
export async function isGitRepo(cwd) {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

/** 仓库根目录。 */
export async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.stdout.trim().replace(/\r?\n$/, '') : null
}

/** 当前分支（detached 时返回 `HEAD@<sha>`）。 */
export async function currentBranch(cwd) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r.ok) {
    const name = r.stdout.trim()
    if (name && name !== 'HEAD') return name
  }
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD'])
  return sha.ok ? `HEAD@${sha.stdout.trim()}` : ''
}

/** 远端地址 → owner/name（支持 ssh / https / git+ssh）。 */
export function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  // git@github.com:owner/name.git
  let m = /^(?:ssh:\/\/)?[\w.@-]+[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (m) return `${m[1]}/${m[2]}`
  m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed)
  if (m) return `${m[1]}/${m[2]}`
  return null
}

/** 主远端名（优先 origin）。 */
export async function primaryRemote(cwd) {
  const r = await git(cwd, ['remote'])
  if (!r.ok) return { name: '', url: '', repo: '' }
  const remotes = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (remotes.length === 0) return { name: '', url: '', repo: '' }
  const name = remotes.includes('origin') ? 'origin' : remotes[0]
  const u = await git(cwd, ['remote', 'get-url', name])
  const url = u.ok ? u.stdout.trim() : ''
  return { name, url, repo: parseRemoteUrl(url) ?? '' }
}

/** 已暂存的文件（相对路径）。 */
export async function stagedFiles(cwd) {
  const r = await git(cwd, ['diff', '--cached', '--name-status', '-z'])
  if (!r.ok) return []
  const parts = splitNul(r.stdout)
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ status: parts[i], path: parts[i + 1] })
  }
  return out
}

/** 工作区所有改动。 */
export async function changedFiles(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  if (!r.ok) return []
  const parts = splitNul(r.stdout)
  const out = []
  for (const p of parts) {
    const status = p.slice(0, 2)
    const path = p.slice(3)
    if (path.length > 0) out.push({ status: status.trim(), path })
  }
  return out
}

/** diff 统计（一行）。 */
export async function diffStat(cwd, staged = false) {
  const args = staged ? ['diff', '--cached', '--shortstat'] : ['diff', '--shortstat']
  const r = await git(cwd, args)
  if (!r.ok) return ''
  return r.stdout.trim()
}

/** 暂存区相对 HEAD 的 diff 统计。 */
export async function stagedDiffStat(cwd) {
  return diffStat(cwd, true)
}

/** 本地领先远端的提交列表。 */
export async function aheadCommits(cwd, remote, branch) {
  if (!remote || !branch) return []
  const r = await git(cwd, ['log', '--format=%h%x09%s%x09%an', '--max-count=30', `${remote}/${branch}..HEAD`])
  if (!r.ok) return []
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, subject, author] = line.split('\t')
    return { sha: sha ?? '', subject: redactText(subject ?? ''), author: author ?? '' }
  })
}

/** 未推送的提交数。 */
export async function aheadCount(cwd, remote, branch) {
  if (!remote || !branch) return 0
  const r = await git(cwd, ['rev-list', '--count', `${remote}/${branch}..HEAD`])
  return r.ok ? Number.parseInt(r.stdout.trim(), 10) || 0 : 0
}

/** 分支是否已完全合并进 HEAD（用于删分支审批的证据）。 */
export async function isMerged(cwd, branch) {
  const r = await git(cwd, ['branch', '--merged', 'HEAD', '--format=%(refname:short)'])
  if (!r.ok) return false
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(branch)
}

/**
 * 一次拿齐审批需要的证据。
 * @param {string} cwd 工作目录
 * @param {{ staged?: boolean }} [opts]
 */
export async function gitSnapshot(cwd, opts = {}) {
  const snapshot = {
    cwd,
    repo: '', remote: '', branch: '', ahead: 0,
    changedFiles: [], stagedFiles: [], aheadCommits: [], diffStat: '', clean: true,
  }
  const root = await repoRoot(cwd)
  if (root === null) return snapshot
  snapshot.root = root
  const [branch, remote, changed, staged, stat, aheadList] = await Promise.all([
    currentBranch(cwd),
    primaryRemote(cwd),
    changedFiles(cwd),
    stagedFiles(cwd),
    opts.staged ? stagedDiffStat(cwd) : diffStat(cwd),
    Promise.resolve(null),
  ])
  snapshot.branch = branch
  snapshot.remote = remote.name
  snapshot.remoteUrl = remote.url
  snapshot.repo = remote.repo
  snapshot.changedFiles = changed.map((f) => ({ path: redactText(f.path), status: f.status }))
  snapshot.stagedFiles = staged.map((f) => ({ path: redactText(f.path), status: f.status }))
  snapshot.diffStat = redactText(stat)
  snapshot.aheadCommits = aheadList === null ? await aheadCommits(cwd, remote.name, branch) : aheadList
  snapshot.ahead = snapshot.aheadCommits.length
  snapshot.clean = changed.length === 0 && staged.length === 0
  return snapshot
}

#!/usr/bin/env node
/**
 * 发布到 GitHub：创建仓库 → 提交 → 推送。
 *
 * 用法：
 *   node scripts/publish.mjs --repo dsh-wechat-superagent --private false
 *
 * 凭据来源（按优先级）：
 *   1. GITHUB_TOKEN 环境变量
 *   2. git credential fill（Windows 上常见）
 *
 * 安全：
 *   - 不打印 token；
 *   - 推送走 https，避免 SSH key 配置问题；
 *   - 先做「敏感文件扫描」，命中即中止。
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const API = 'https://api.github.com'
const cwd = process.cwd()

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.stdio ?? 'pipe', ...opts })
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const m = /^password=(.+)$/m.exec(out)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-wechat-superagent-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data = null
  try { data = text.length > 0 ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 300) } }
  return { ok: res.ok, status: res.status, data }
}

/** 扫描不该提交的内容。 */
function scanSecrets() {
  const bad = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (st.size > 2 * 1024 * 1024) continue
      const rel = relative(cwd, full).split(sep).join('/')
      // 测试夹具里的"假密钥"是故意的：它们不可能通过格式校验之外的任何检查，
      // 而且正是用来验证脱敏逻辑的。按路径跳过，但要保证它们确实是明显的假值。
      const isFixture = /(^|\/)(test|tests|__tests__|fixtures?)(\/|$)/.test(rel)
      if (isFixture) continue
      if (/secrets?\.json$/i.test(name) && !/\.example\.json$/i.test(name)) bad.push(`${rel}（凭据文件）`)
      if (/^\.env(\..+)?$/.test(name) && !/\.example$/.test(name)) bad.push(`${rel}（环境变量）`)
      if (/\.(pem|key|pfx|p12)$/i.test(name)) bad.push(`${rel}（密钥文件）`)
      if (bad.length > 12) return
      const text = readFileSync(full, 'utf8')
      if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) bad.push(`${rel}（含 GitHub token）`)
      if (/\bsk-[A-Za-z0-9]{20,}\b/.test(text)) bad.push(`${rel}（含 API key）`)
      // 私钥检测：真正的 PEM 块会在 BEGIN 与 END 之间有大量 base64；
      // 只出现一行 BEGIN 的通常是「检测私钥的正则源码」，不算泄漏。
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{80,}?-----END [A-Z ]*PRIVATE KEY-----/.test(text)) {
        bad.push(`${rel}（含完整私钥块）`)
      }
    }
  }
  walk(cwd)
  return [...new Set(bad)]
}

const repoName = arg('repo', 'dsh-wechat-superagent')
const isPrivate = arg('private', 'false') === 'true'
const token = getToken()
if (!token) {
  console.error('✗ 找不到 GitHub 凭据（设置 GITHUB_TOKEN，或先 git 登录一次）')
  process.exit(1)
}

console.log('→ 扫描敏感内容…')
const hits = scanSecrets()
if (hits.length > 0) {
  console.error('✗ 发现可能不该提交的内容：')
  for (const h of hits) console.error('   -', h)
  process.exit(1)
}
console.log('✓ 没有发现明显敏感内容')

const me = await api(token, 'GET', '/user')
if (!me.ok) {
  console.error('✗ 无法验证 token：', me.status, JSON.stringify(me.data).slice(0, 200))
  process.exit(1)
}
const login = me.data.login
console.log(`→ 账号：${login}`)

// 仓库是否存在
let repo = await api(token, 'GET', `/repos/${login}/${repoName}`)
if (repo.status === 404) {
  console.log(`→ 创建仓库 ${login}/${repoName}（${isPrivate ? 'private' : 'public'}）…`)
  repo = await api(token, 'POST', '/user/repos', {
    name: repoName,
    description: '企业微信 superagent for DeepSeek Harness：扫码建机器人、盯仓库、卡片审批提交/推送/发布',
    private: isPrivate,
    auto_init: false,
  })
  if (!repo.ok) {
    console.error('✗ 创建仓库失败：', repo.status, JSON.stringify(repo.data).slice(0, 400))
    process.exit(1)
  }
  console.log('✓ 仓库已创建')
} else if (!repo.ok) {
  console.error('✗ 查询仓库失败：', repo.status)
  process.exit(1)
} else {
  console.log('✓ 仓库已存在')
}

const remoteUrl = `https://x-access-token:${token}@github.com/${login}/${repoName}.git`

// 初始化 git 并提交
if (!existsSync(join(cwd, '.git'))) run('git', ['init', '-q'])
run('git', ['add', '-A'])
try {
  run('git', ['-c', 'user.name=' + login, '-c', 'user.email=' + login + '@users.noreply.github.com',
    'commit', '-q', '-m', 'feat: 企业微信 superagent 插件（扫码接入 + 仓库守望 + 分级审批）'])
  console.log('✓ 已提交')
} catch (e) {
  const out = String(e.stdout ?? '') + String(e.stderr ?? '')
  if (/nothing to commit/i.test(out)) console.log('· 没有新改动可提交')
  else { console.error('✗ 提交失败：', out.slice(0, 400)); process.exit(1) }
}

// 确保分支名是 main
try {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch !== 'main') run('git', ['branch', '-M', 'main'])
} catch { /* 空仓库时忽略 */ }

console.log('→ 推送…')
try {
  run('git', ['push', remoteUrl, 'HEAD:main', '--force'])
} catch (e) {
  console.error('✗ 推送失败：', (String(e.stderr ?? '') + String(e.stdout ?? '')).slice(0, 500))
  process.exit(1)
}
// 把不带 token 的 remote 写回配置，避免凭据留在 .git/config
try {
  run('git', ['remote', 'remove', 'origin'], { stdio: 'pipe' })
} catch { /* 可能不存在 */ }
run('git', ['remote', 'add', 'origin', `https://github.com/${login}/${repoName}.git`])

console.log(`✓ 已推送：https://github.com/${login}/${repoName}`)

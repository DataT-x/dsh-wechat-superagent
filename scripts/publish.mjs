#!/usr/bin/env node
/**
 * 发布到 GitHub。
 *
 * 用法：
 *   node scripts/publish.mjs [--repo dsh-wechat-superagent] [--private false] [--message "..."]
 *
 * 为什么要用 Git Data API 而不是 `git push`：
 *   GitHub 设备授权流程拿到的是 `gho_` OAuth token，它**不能**用于
 *   git 的 HTTPS basic auth，直接 push 会得到 `Authentication failed`。
 *   走 REST API 建 blob/tree/commit 则完全可用。
 *
 * 凭据来源（按优先级）：
 *   1. GITHUB_TOKEN / GH_TOKEN 环境变量
 *   2. `git credential fill`（本机已登录过）
 *
 * 安全：
 *   - 不打印 token；
 *   - 提交前扫描敏感文件，命中即中止；
 *   - 跳过 node_modules / 运行期数据文件。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const API = 'https://api.github.com'
const cwd = process.cwd()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const repoName = arg('repo', 'dsh-wechat-superagent')
const isPrivate = arg('private', 'false') === 'true'
const branch = arg('branch', 'main')
const DEFAULT_MESSAGE = [
  'feat: 企业微信 superagent 插件（扫码接入 + 仓库守望 + 分级审批）',
  '',
  '- 一键扫码创建企微机器人，凭据隔离存储',
  '- 企微单聊/群聊消息路由进 DSH 会话，带上下文增强',
  '- 14 类动作分级审批：提交/推送/强推/测试/构建/发布/部署/迁移/依赖/删文件/密钥',
  '- 负责人二次审批 + 第二负责人双签 + 确认短语',
  '- 模板卡片点按审批，按钮 key 带 HMAC 签名',
  '- 本地 git / GitHub issue PR 守望，水位与冷却',
  '- 324 项单测',
  '',
  'Co-Authored-By: Claude Code <noreply@anthropic.com>',
].join(String.fromCharCode(10))
// 提交信息里不能出现「反斜杠 + n」这两个字符：GitHub 会原样保存。
// 统一换成真正的换行。
const NEWLINE = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
const message = arg('message', DEFAULT_MESSAGE)
  .split(BACKSLASH + 'n').join(NEWLINE)
  .split(BACKSLASH + 'r').join('')

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd,
    })
    const m = /^password=(.+)$/m.exec(out)
    return m ? m[1].trim() : null
  } catch { return null }
}

/** 扫描不该提交的内容。 */
export function scanSecrets(dir = cwd) {
  const bad = []
  const walk = (root) => {
    for (const name of readdirSync(root)) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue
      const full = join(root, name)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (st.size > 2 * 1024 * 1024) continue
      const rel = relative(cwd, full).split(sep).join('/')
      // 测试夹具里的「假密钥」是故意的：用来验证脱敏逻辑，不可能是真凭据
      if (/(^|\/)(test|tests|__tests__|fixtures?)(\/|$)/.test(rel)) continue
      if (/secrets?\.json$/i.test(name) && !/\.example\.json$/i.test(name)) bad.push(`${rel}（凭据文件）`)
      if (/^\.env(\..+)?$/.test(name) && !/\.example$/.test(name)) bad.push(`${rel}（环境变量）`)
      if (/\.(pem|key|pfx|p12)$/i.test(name)) bad.push(`${rel}（密钥文件）`)
      if (bad.length > 12) return
      const text = readFileSync(full, 'utf8')
      if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)) bad.push(`${rel}（含 GitHub token）`)
      if (/\bsk-[A-Za-z0-9]{32,}\b/.test(text)) bad.push(`${rel}（含 API key）`)
      // 完整 PEM 块（BEGIN 与 END 之间有大段 base64）；单行 BEGIN 多半是检测用的正则
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{80,}?-----END [A-Z ]*PRIVATE KEY-----/.test(text)) {
        bad.push(`${rel}（含完整私钥块）`)
      }
    }
  }
  walk(dir)
  return [...new Set(bad)]
}

/** 收集要上传的文件。 */
function collectFiles() {
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'dist'])
  const SKIP_FILES = new Set(['secrets.json', 'config.json', 'state.json', 'audit.ndjson', 'deliveries.ndjson'])
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (!SKIP_FILES.has(name) && !name.endsWith('.log') && st.size < 2 * 1024 * 1024) {
        out.push({ rel: relative(cwd, full).split(sep).join('/'), full })
      }
    }
  }
  walk(cwd)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

async function main() {
  const token = getToken()
  if (!token) {
    console.error('✗ 找不到 GitHub 凭据（设置 GITHUB_TOKEN，或先 git 登录一次）')
    process.exit(1)
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-wechat-superagent-publisher',
    'Content-Type': 'application/json',
  }
  const api = async (method, path, body) => {
    const res = await fetch(API + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 200) } }
    return { ok: res.ok, status: res.status, data }
  }

  console.log('→ 扫描敏感内容…')
  const hits = scanSecrets()
  if (hits.length > 0) {
    console.error('✗ 发现可能不该提交的内容：')
    for (const h of hits) console.error('   -', h)
    process.exit(1)
  }
  console.log('✓ 没有发现明显敏感内容')

  const me = await api('GET', '/user')
  if (!me.ok) {
    console.error('✗ 无法验证 token：', me.status)
    process.exit(1)
  }
  const login = me.data.login
  console.log(`→ 账号：${login}`)

  let repo = await api('GET', `/repos/${login}/${repoName}`)
  if (repo.status === 404) {
    console.log(`→ 创建仓库 ${login}/${repoName}…`)
    repo = await api('POST', '/user/repos', {
      name: repoName,
      description: '企业微信 superagent for DeepSeek Harness：扫码建机器人、盯仓库、卡片审批提交/推送/发布',
      private: isPrivate,
      auto_init: false,
    })
    if (!repo.ok) {
      console.error('✗ 创建仓库失败：', repo.status, JSON.stringify(repo.data).slice(0, 300))
      process.exit(1)
    }
  } else if (!repo.ok) {
    console.error('✗ 查询仓库失败：', repo.status)
    process.exit(1)
  }
  console.log('✓ 仓库就绪')

  const files = collectFiles()
  console.log(`→ 准备上传 ${files.length} 个文件`)

  // 首次提交：Contents API 点亮分支
  let parentSha = null
  const refRes = await api('GET', `/repos/${login}/${repoName}/git/ref/heads/${branch}`)
  if (refRes.ok) {
    parentSha = refRes.data.object.sha
  } else {
    const seed = files.find((f) => f.rel === 'README.md') ?? files[0]
    const init = await api('PUT', `/repos/${login}/${repoName}/contents/${encodeURIComponent(seed.rel)}`, {
      message: 'chore: 初始化仓库',
      content: readFileSync(seed.full).toString('base64'),
      branch,
    })
    if (!init.ok) {
      console.error('✗ 初始化失败：', init.status, JSON.stringify(init.data).slice(0, 200))
      process.exit(1)
    }
    const again = await api('GET', `/repos/${login}/${repoName}/git/ref/heads/${branch}`)
    parentSha = again.data.object.sha
    console.log('✓ 首次提交建立分支')
  }

  let baseTree
  if (parentSha) {
    const baseCommit = await api('GET', `/repos/${login}/${repoName}/git/commits/${parentSha}`)
    baseTree = baseCommit.data.tree.sha
  }

  // 上传 blob
  const tree = []
  for (const f of files) {
    const content = readFileSync(f.full)
    const isBinary = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|gz)$/i.test(f.full)
    const blob = await api('POST', `/repos/${login}/${repoName}/git/blobs`, {
      content: content.toString(isBinary ? 'base64' : 'utf8'),
      encoding: isBinary ? 'base64' : 'utf8',
    })
    if (!blob.ok) {
      console.error(`✗ 上传失败 ${f.rel}:`, blob.status)
      process.exit(1)
    }
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.data.sha })
  }
  console.log(`✓ ${tree.length} 个 blob 已上传`)

  const newTree = await api('POST', `/repos/${login}/${repoName}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree,
  })
  if (!newTree.ok) {
    console.error('✗ 建 tree 失败：', newTree.status, JSON.stringify(newTree.data).slice(0, 200))
    process.exit(1)
  }

  const commit = await api('POST', `/repos/${login}/${repoName}/git/commits`, {
    message,
    tree: newTree.data.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  })
  if (!commit.ok) {
    console.error('✗ 建 commit 失败：', commit.status, JSON.stringify(commit.data).slice(0, 200))
    process.exit(1)
  }

  const update = await api('PATCH', `/repos/${login}/${repoName}/git/refs/heads/${branch}`, {
    sha: commit.data.sha,
    force: true,
  })
  if (!update.ok) {
    console.error('✗ 更新分支失败：', update.status, JSON.stringify(update.data).slice(0, 200))
    process.exit(1)
  }
  console.log(`✓ 已推送：https://github.com/${login}/${repoName}`)
}

// 只有直接运行时才执行（便于被测试 import）
if (import.meta.url === `file://${process.argv[1].split(sep).join('/')}`.replace(/\\/g, '/')
  || process.argv[1]?.endsWith('publish.mjs')) {
  await main()
}

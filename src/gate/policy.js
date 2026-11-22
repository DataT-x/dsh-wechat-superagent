/**
 * 规则匹配：把一个待执行的工具调用，判定为「哪个审批动作、什么风险、要不要审」。
 *
 * 输入来自 `tools/pre-execute` 的 `ToolExecution`：
 *   { name, args, agent, callId, ... }
 *
 * 匹配顺序（越具体越先）：
 *   1. 强推 / 重置 这类「高危特例」优先于普通的 git push
 *   2. 依赖变更 / 密钥变更 看的是文件路径
 *   3. 命令类动作看的是命令文本
 *   4. 文件类动作看的是工具参数里的路径
 *   5. 都没命中 → tool.exec 动态评估
 *
 * 纯函数，无副作用，可单测。
 */
import { ACTIONS, RISKS, riskRank, mergeRules, actionLabel } from './rules.js'

/** 参与「命令文本」提取的工具。 */
const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'terminal', 'shell', 'run_command', 'exec'])
/** 参数里可能带命令的键。 */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'input', 'line']

/** 参与「文件路径」提取的工具。 */
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'str_replace_editor', 'file_write', 'apply_patch', 'create_file', 'delete_file', 'move_file'])
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target', 'paths', 'files', 'old_path', 'new_path']

/** 从工具参数里收集所有字符串（深度受限），用于路径与命令的宽松检查。 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 4 || value === null || value === undefined) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out }
  if (typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out, depth + 1) }
  return out
}

/** 提取命令文本；非命令工具返回空串。 */
export function extractCommand(toolName, args) {
  if (!args || typeof args !== 'object') return ''
  if (COMMAND_TOOLS.has(toolName)) {
    for (const key of COMMAND_KEYS) {
      const v = args[key]
      if (typeof v === 'string' && v.trim().length > 0) return v
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ')
    }
  }
  return ''
}

/** 提取触及的文件路径列表（规范化成正斜杠）。 */
export function extractPaths(toolName, args) {
  /** @type {string[]} */
  const out = []
  if (!args || typeof args !== 'object') return out
  const push = (v) => {
    if (typeof v !== 'string' || v.length === 0) return
    // 收三类：含分隔符的路径、带扩展名的文件名、以及"看起来像密钥文件名"的裸名
    // （`id_rsa` / `secrets` / `credentials` 这类没有扩展名但极敏感）
    const looksLikePath = /[\\/]/.test(v) || /\.[A-Za-z0-9]{1,8}$/.test(v)
    const looksLikeSecretName = /^(id_(rsa|dsa|ecdsa|ed25519)|secrets?|credentials?|\.env(\..+)?)$/i.test(v.trim())
    if (!looksLikePath && !looksLikeSecretName) return
    out.push(v.replace(/\\/g, '/'))
  }
  for (const key of PATH_KEYS) {
    const v = args[key]
    if (typeof v === 'string') push(v)
    else if (Array.isArray(v)) for (const item of v) push(item)
  }
  // 非文件工具也可通过 patch 内容间接改文件（apply_patch）
  if (out.length === 0 && (FILE_TOOLS.has(toolName) || toolName === 'bash')) {
    for (const s of collectStrings(args)) {
      for (const m of s.matchAll(/(?:^|\s)([\w./\\-]+\.[A-Za-z0-9]{1,8})(?=\s|$|["'])/g)) push(m[1])
    }
  }
  return [...new Set(out)]
}

/** 安全地编译正则（配置里的字符串可能是坏正则）。 */
export function compile(pattern) {
  try { return new RegExp(pattern, 'i') } catch { return null }
}

/** 命令是否命中某动作的模式。 */
function commandMatches(action, command) {
  if (typeof command !== 'string' || command.length === 0) return false
  for (const p of ACTIONS[action]?.patterns ?? []) {
    const re = compile(p)
    if (re && re.test(command)) return true
  }
  return false
}

/** 路径是否命中某动作的文件模式。 */
function pathMatches(action, paths) {
  const patterns = ACTIONS[action]?.files
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const p of paths) {
    const base = p.split('/').pop() ?? p
    for (const pat of patterns) {
      const re = compile(`^(?:.*/)?(?:${pat})$`)
      if (re && (re.test(base) || re.test(p))) return true
    }
  }
  return false
}

/**
 * 判定一次工具调用需要哪个审批动作。
 * @param {object} params
 * @param {string} params.toolName
 * @param {object} params.args
 * @param {object} [params.rules] 已 merge 的规则表
 * @param {string} [params.cwd] 工作目录（用于路径相对化）
 * @returns {{
 *   action: string, label: string, risk: string, approval: string,
 *   needsApproval: boolean, command: string, paths: string[], reason: string
 * }}
 */
export function classifyToolCall({ toolName, args, rules, cwd }) {
  const ruleTable = rules ?? mergeRules(undefined)
  const command = extractCommand(toolName, args)
  const paths = extractPaths(toolName, args)

  // ---- 1. 命令类匹配（按动作优先级：critical 特例先于同类 generic）----
  if (command.length > 0) {
    const order = [
      'git.force-push', 'git.reset', 'git.branch.delete', 'git.push', 'git.commit',
      'db.migrate', 'deploy.run', 'release.publish',
      'deps.install', 'build.run', 'test.run', 'file.delete', 'git.worktree',
    ]
    for (const action of order) {
      if (!commandMatches(action, command)) continue
      return finalize(action, ruleTable, { command, paths, reason: `命令命中 ${actionLabel(action)}` })
    }
  }

  // ---- 2. 文件类匹配 ----
  if (paths.length > 0) {
    if (pathMatches('secrets.change', paths)) {
      return finalize('secrets.change', ruleTable, { command, paths, reason: '触及密钥/凭据文件' })
    }
    if (pathMatches('deps.install', paths)) {
      return finalize('deps.install', ruleTable, { command, paths, reason: '触及依赖清单/锁文件' })
    }
  }

  // ---- 3. 工具名直配（用户可在规则里给某工具指定动作）----
  for (const [action, def] of Object.entries(ACTIONS)) {
    if (Array.isArray(def.tools) && def.tools.includes(toolName) && action === 'tool.exec') continue
  }

  // ---- 4. 兜底：读类工具直接放行，写类与执行类走 tool.exec ----
  // 注意：读类工具如果触及密钥文件，上面的第 2 步已经拦下了。
  const READ_ONLY = new Set(['read_file', 'list_directory', 'glob', 'grep', 'search', 'file_read', 'read', 'ls', 'find', 'todo_write', 'ask_user_question', 'web_search', 'web_fetch'])
  if (READ_ONLY.has(toolName)) {
    return {
      action: 'read', label: '只读操作', risk: 'low', approval: 'none',
      needsApproval: false, command, paths, reason: '只读工具，无需审批',
    }
  }  return finalize('tool.exec', ruleTable, {
    command: command || `${toolName}(${summarizeArgs(args)})`,
    paths,
    reason: `未分类工具 ${toolName}`,
  })
}

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args ?? {})
    return s.length > 120 ? `${s.slice(0, 117)}...` : s
  } catch { return '«unserializable»' }
}

/** 用规则表定稿。 */
function finalize(action, rules, { command, paths, reason }) {
  const def = ACTIONS[action] ?? ACTIONS['tool.exec']
  const rule = rules[action] ?? {}
  const enabled = rule.enabled !== false
  const risk = RISKS.includes(rule.risk) ? rule.risk : def.risk
  const approval = typeof rule.approval === 'string' ? rule.approval : def.approval
  const needsApproval = enabled && approval !== 'none'
  return {
    action,
    label: actionLabel(action),
    risk,
    approval,
    needsApproval,
    command,
    paths,
    reason,
  }
}

/**
 * 判断一条命令的「破坏性等级」，用于 tool.exec 的动态风险。
 * 命中越多高危词，等级越高。
 */
export function dynamicRisk(command) {
  const text = String(command ?? '')
  const high = [/--force\b/i, /\brm\s+-rf\b/i, /\bdrop\s+(table|database)\b/i, /\btruncate\b/i, /\bshutdown\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, />\s*\/dev\/sd/i, /\bchmod\s+777\b/i, /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i, /\biwr\b[^\n]*\|\s*iex\b/i]
  const medium = [/\brm\b/i, /\bmv\b/i, /\bgit\s+checkout\s+--\b/i, /\bnpm\s+install\s+-g\b/i, /\bsudo\b/i, /\bsystemctl\b/i]
  if (high.some((re) => re.test(text))) return 'critical'
  if (medium.some((re) => re.test(text))) return 'high'
  return 'medium'
}

/**
 * 汇总一次审批请求的「证据」：让审批人一眼看懂改了什么。
 * @param {object} params
 * @param {object} params.git 本地 git 快照（由调用方提供，见 gitSnapshot）
 * @param {object} params.classification classifyToolCall 的结果
 * @param {string} [params.summary] 覆盖默认摘要
 */
export function buildEvidence({ git, classification, summary }) {
  const evidence = {
    tool: classification?.action ?? 'unknown',
    risk: classification?.risk ?? 'medium',
    command: classification?.command ?? '',
    files: [],
    commits: [],
    diffStat: '',
    branch: git?.branch ?? '',
    repo: git?.repo ?? '',
    remote: git?.remote ?? '',
  }
  if (git) {
    if (Array.isArray(git.changedFiles)) evidence.files = git.changedFiles.slice(0, 50)
    if (Array.isArray(git.aheadCommits)) evidence.commits = git.aheadCommits.slice(0, 20)
    if (typeof git.diffStat === 'string') evidence.diffStat = git.diffStat
  }
  if (typeof summary === 'string' && summary.trim().length > 0) evidence.summary = summary.trim()
  return evidence
}

/** 风险比较：a 是否比 b 更危险。 */
export function riskierThan(a, b) {
  return riskRank(a) > riskRank(b)
}

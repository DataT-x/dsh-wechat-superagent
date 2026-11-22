/**
 * 审批动作的全集与默认规则。
 *
 * 设计原则：
 * 1. **动作先行**：先定义「哪些事必须审批」，再决定「谁来审、审几级」。
 * 2. **风险分级**：low 可不审（仅记录），medium 一级审，high 一级+负责人，
 *    critical 负责人 + 二次确认短语。
 * 3. **可覆盖**：规则是数据不是代码，用户可在设置里改任意一条。
 * 4. **默认最严**：没匹配到的工具按 `tool.exec` 动态评估，默认 medium。
 */

/** 风险等级，从低到高。 */
export const RISKS = /** @type {const} */ (['low', 'medium', 'high', 'critical'])
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 }

export function riskRank(risk) {
  return RISK_RANK[risk] ?? 1
}

export function isRisk(risk) {
  return typeof risk === 'string' && risk in RISK_RANK
}

/**
 * 动作目录。`match` 是给规则引擎用的识别信息：
 *   - tools: 会触发这个动作的工具名
 *   - patterns: 在命令/参数里命中的正则（字符串形式，便于序列化）
 *
 * `approval` 是默认审批策略：
 *   - 'none'      不审（记审计即可）
 *   - 'primary'   一级审批人
 *   - 'owner'     直接负责人
 *   - 'dual'      一级 + 负责人（两级）
 *   - 'owner2'    负责人 + 第二负责人（两级，用于发布/部署）
 *   - 'phrase'    在 dual 基础上额外要求输入确认短语
 */
export const ACTIONS = {
  'git.commit': {
    label: '提交代码',
    icon: '📝',
    risk: 'medium',
    approval: 'dual',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+(commit|add|stash)\\b'],
    summary: '把改动写入本地仓库',
    detailFields: ['repo', 'branch', 'files', 'diffStat', 'message'],
  },
  'git.push': {
    label: '推送代码',
    icon: '⬆️',
    risk: 'high',
    approval: 'dual',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+push\\b'],
    summary: '把本地提交推到远端',
    detailFields: ['repo', 'remote', 'branch', 'commits', 'files', 'diffStat'],
  },
  'git.force-push': {
    label: '强制推送',
    icon: '⚠️',
    risk: 'critical',
    approval: 'phrase',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+push\\b[^\\n]*\\s(--force|-f|--force-with-lease)\\b'],
    summary: '覆盖远端历史，可能丢弃他人提交',
    detailFields: ['repo', 'remote', 'branch', 'lostCommits'],
  },
  'git.branch.delete': {
    label: '删除分支',
    icon: '🗑️',
    risk: 'high',
    approval: 'owner',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+(branch\\s+-[dD]|push\\s+[^\\n]*--delete)\\b'],
    summary: '删除本地或远端分支',
    detailFields: ['repo', 'branch', 'merged'],
  },
  'git.reset': {
    label: '重置仓库',
    icon: '↩️',
    risk: 'critical',
    approval: 'phrase',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+reset\\s+--hard\\b', '\\bgit\\s+clean\\s+-[a-z]*[fd]'],
    summary: '丢弃工作区改动，操作不可撤销',
    detailFields: ['repo', 'target', 'lostFiles'],
  },
  'git.worktree': {
    label: '隔离区操作',
    icon: '🌿',
    risk: 'low',
    approval: 'none',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bgit\\s+worktree\\b'],
    summary: '在独立副本里改动，不动主工作区',
    detailFields: ['repo', 'path', 'branch'],
  },
  'test.run': {
    label: '运行测试',
    icon: '🧪',
    risk: 'low',
    approval: 'none',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b', '\\bpytest\\b', '\\bgo\\s+test\\b', '\\bcargo\\s+test\\b', '\\bmvn\\s+test\\b', '\\bgradle[w]?\\s+test\\b'],
    summary: '执行项目测试套件',
    detailFields: ['repo', 'command', 'scope'],
  },
  'build.run': {
    label: '构建项目',
    icon: '🔨',
    risk: 'medium',
    approval: 'primary',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?build\\b', '\\bcargo\\s+build\\b', '\\bgo\\s+build\\b', '\\bmvn\\s+(package|install)\\b', '\\bgradle[w]?\\s+build\\b', '\\bmake\\b(\\s|$)'],
    summary: '编译打包产物',
    detailFields: ['repo', 'command', 'target'],
  },
  'release.publish': {
    label: '构建发布',
    icon: '🚀',
    risk: 'critical',
    approval: 'phrase',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bnpm\\s+publish\\b', '\\bcargo\\s+publish\\b', '\\bgh\\s+release\\s+create\\b', '\\bgoreleaser\\b', '\\btwine\\s+upload\\b'],
    summary: '把产物发布到公开渠道',
    detailFields: ['repo', 'version', 'channel', 'artifacts'],
  },
  'deploy.run': {
    label: '部署上线',
    icon: '🌐',
    risk: 'critical',
    approval: 'owner2',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bkubectl\\s+(apply|set|rollout|delete)\\b', '\\bhelm\\s+(install|upgrade|uninstall)\\b', '\\bdocker\\s+(push|compose\\s+up)\\b', '\\bterraform\\s+apply\\b', '\\bansible-playbook\\b', '\\bssh\\b[^\\n]*\\b(deploy|restart)\\b', '\\bpm2\\s+(deploy|restart)\\b'],
    summary: '把服务部署到真实环境',
    detailFields: ['repo', 'environment', 'target', 'replicas'],
  },
  'deps.install': {
    label: '依赖变更',
    icon: '📦',
    risk: 'high',
    approval: 'dual',
    tools: ['bash', 'pwsh', 'terminal', 'write_file', 'edit_file', 'str_replace_editor'],
    patterns: ['\\b(npm|pnpm|yarn|bun)\\s+(i|install|add|remove|update|upgrade)\\b', '\\bpip3?\\s+install\\b', '\\bpoetry\\s+(add|remove|update)\\b', '\\bgo\\s+get\\b', '\\bcargo\\s+(add|remove|update)\\b'],
    files: ['package\\.json', 'package-lock\\.json', 'pnpm-lock\\.yaml', 'yarn\\.lock', 'requirements\\.txt', 'pyproject\\.toml', 'poetry\\.lock', 'go\\.mod', 'go\\.sum', 'Cargo\\.toml', 'Cargo\\.lock'],
    summary: '新增或升级依赖，可能引入供应链风险',
    detailFields: ['repo', 'added', 'removed', 'updated'],
  },
  'db.migrate': {
    label: '数据库迁移',
    icon: '🗄️',
    risk: 'critical',
    approval: 'phrase',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\bmigrate\\b', '\\bprisma\\s+migrate\\b', '\\bsequelize\\s+db:migrate\\b', '\\balembic\\s+upgrade\\b', '\\b(typeorm|knex)\\s+migration\\b', '\\bdb:migrate\\b'],
    summary: '改变数据库结构或数据，通常不可回滚',
    detailFields: ['repo', 'database', 'reversible', 'statements'],
  },
  'file.delete': {
    label: '批量删除',
    icon: '❌',
    risk: 'high',
    approval: 'owner',
    tools: ['bash', 'pwsh', 'terminal'],
    patterns: ['\\brm\\s+-[a-z]*r[a-z]*\\b', '\\bRemove-Item\\b[^\\n]*-Recurse'],
    summary: '删除文件或目录，可能不可恢复',
    detailFields: ['repo', 'paths', 'count'],
  },
  'secrets.change': {
    label: '密钥变更',
    icon: '🔑',
    risk: 'critical',
    approval: 'owner2',
    tools: ['write_file', 'edit_file', 'str_replace_editor', 'bash'],
    // 路径模式同时覆盖：读（read_file 拿到 secrets.json 就等于拿到机器人控制权）
    // 与写（改 .env / PEM）。`.*secret.*` 已包含 secrets.json / .credentials.yaml。
    files: ['\\.env', '\\.env\\..*', '.*credentials.*', '.*secret.*', '.*\\.pem', '.*\\.key', '.*\\.p12', '.*\\.pfx', '.*id_rsa.*', '.*id_ed25519.*'],
    summary: '读写密钥文件，必须留痕',
    detailFields: ['repo', 'paths', 'operation'],
  },
  'tool.exec': {
    label: '高风险命令',
    icon: '⌨️',
    risk: 'medium',
    approval: 'primary',
    tools: [],
    patterns: [],
    summary: '未分类的工具调用',
    detailFields: ['tool', 'command'],
  },
}

/** 动作中文名。 */
export function actionLabel(action) {
  return ACTIONS[action]?.label ?? action
}

/** 所有动作 key。 */
export function actionKeys() {
  return Object.keys(ACTIONS)
}

/**
 * 生成默认规则表：动作 → { enabled, risk, approval, approvers, timeoutMin, phrase }
 * 用户配置里同名字段会覆盖这里的值。
 */
export function defaultRules() {
  /** @type {Record<string, object>} */
  const out = {}
  for (const [key, def] of Object.entries(ACTIONS)) {
    out[key] = {
      enabled: true,
      risk: def.risk,
      approval: def.approval,
      approvers: [], // 空 = 用配置里的默认审批人
      timeoutMin: def.risk === 'critical' ? 60 : 30,
      phrase: def.approval === 'phrase' ? confirmationPhrase(key) : undefined,
    }
  }
  return out
}

/** 二次确认短语：必须原样输入，防止误点。 */
export function confirmationPhrase(action) {
  const map = {
    'git.force-push': '确认强推',
    'git.reset': '确认重置',
    'release.publish': '确认发布',
    'db.migrate': '确认迁移',
    'deploy.run': '确认部署',
  }
  return map[action] ?? `确认${actionLabel(action)}`
}

/** 合并用户配置与默认规则。 */
export function mergeRules(userRules) {
  const rules = defaultRules()
  if (userRules && typeof userRules === 'object') {
    for (const [key, value] of Object.entries(userRules)) {
      if (!(key in rules) || !value || typeof value !== 'object') continue
      rules[key] = { ...rules[key], ...value }
    }
  }
  return rules
}

/**
 * 状态与配置的原子读写。
 *
 * 所有插件数据放在 `~/.dsh/wecom-superagent/`：
 *   config.json      用户可从设置面板改的配置
 *   secrets.json     机器人 secret（0600，永不回传模型）
 *   state.json       会话映射、去重水位、审批索引
 *   audit.ndjson     只追加的审计日志
 *   pending/         每个待审批一份（便于崩溃恢复）
 *
 * 为什么不用 ctx.storage：DSH 的 storage backend 需要 profile 里挂载
 * dsh-storage-json，而插件必须能在「只装了 base」的 profile 里也跑起来。
 * 直接读写文件是最小依赖，也最容易排障。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 根目录：允许 DSH_WECOM_HOME 覆盖（测试用）。 */
export function rootDir() {
  const override = process.env.DSH_WECOM_HOME
  if (override && override.trim().length > 0) return resolve(override.trim())
  return join(homedir(), '.dsh', 'wecom-superagent')
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function pathOf(...parts) {
  return join(ensureDir(rootDir()), ...parts)
}

/** 读取 JSON 文件；不存在或损坏时返回 fallback（不抛）。 */
export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8')
    if (text.trim().length === 0) return fallback
    return JSON.parse(text)
  } catch {
    // 损坏不覆盖：留 .corrupt 副本供排查
    try {
      if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* ignore */ }
    return fallback
  }
}

/**
 * 原子写 JSON：写临时文件 → fsync 语义由 rename 保证 → 替换。
 * @param {string} file
 * @param {unknown} value
 * @param {{ mode?: number }} [opts]
 */
export function writeJson(file, value, opts = {}) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: opts.mode ?? 0o600 })
  try { chmodSync(tmp, opts.mode ?? 0o600) } catch { /* windows 可能不支持，忽略 */ }
  renameSync(tmp, file)
  return file
}

/** 追加一行 NDJSON。失败不抛（审计失败不能阻断主流程），但返回 false。 */
export function appendNdjson(file, record) {
  try {
    ensureDir(dirname(file))
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 读取最近 N 行 NDJSON。 */
export function tailNdjson(file, limit = 200) {
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch { return { _corrupt: l } }
    })
  } catch {
    return []
  }
}

/** 文件是否对当前用户可读。 */
export function fileExists(file) {
  try { return statSync(file).isFile() } catch { return false }
}

export const files = {
  config: () => pathOf('config.json'),
  secrets: () => pathOf('secrets.json'),
  state: () => pathOf('state.json'),
  audit: () => pathOf('audit.ndjson'),
  pendingDir: () => ensureDir(pathOf('pending')),
  pending: (id) => join(pendingDirPath(), `${id}.json`),
  deliveries: () => pathOf('deliveries.ndjson'),
}

/** 只算路径、不建目录：读之前不需要副作用。 */
function pendingDirPath() {
  return join(rootDir(), 'pending')
}

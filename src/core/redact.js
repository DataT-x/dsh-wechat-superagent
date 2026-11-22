/**
 * 全链路脱敏：所有离开插件边界的文本（工具输出、日志、卡片、HTTP 响应）
 * 都必须先经过这里。凭证绝不进入模型上下文。
 *
 * 设计原则：
 * - 宁可多脱一点，也不能漏；每次脱敏返回统计，便于审计。
 * - 不依赖调用方记得脱敏：`redactDeep()` 递归处理对象/数组。
 */

/** 需要整体遮盖的键名（不区分大小写）。 */
const SECRET_KEYS = [
  'secret', 'botscreet', 'botsecret', 'token', 'accesstoken', 'access_token',
  'password', 'passwd', 'pwd', 'apikey', 'api_key', 'privatekey', 'private_key',
  'authorization', 'cookie', 'bearer', 'credential', 'signingkey', 'aeskey',
]

/** 形如密钥的字面量模式。顺序有意义：先长后短。 */
const SECRET_PATTERNS = [
  // PEM 私钥块（含 RSA / EC / OPENSSH / PGP）
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----«REDACTED»-----END PRIVATE KEY-----'],
  // GitHub token
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh?_«REDACTED»'],
  // GitHub fine-grained
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_«REDACTED»'],
  // 常见 LLM key
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-«REDACTED»'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'sk-ant-«REDACTED»'],
  // 企业微信 secret（长十六进制串，只在显式上下文里处理，避免误伤 commit hash）
  // 见 maskWecomSecret()
  // Bearer / Basic 认证头
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 «REDACTED»'],
  // URL 里的密码 user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1«REDACTED»@'],
  // .env 风格赋值（`\b` 在 `_` 前不生效，所以用显式分隔断言）
  [/(^|[^A-Za-z0-9_])([A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)S?)(\s*=\s*)\S+/g, '$1$2$3«REDACTED»'],
  // AWS
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA«REDACTED»'],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox?-«REDACTED»'],
]

/** 本机绝对路径：Windows 盘符、用户目录、UNC。 */
const PATH_PATTERNS = [
  [/\b[A-Za-z]:\\Users\\[^\\\s"']+\\?/g, '%USERPROFILE%\\'],
  [/\b[A-Za-z]:\\[^\s"']*\\/g, '«PATH»\\'],
  [/\/(?:home|Users)\/[^/\s"']+/g, '~'],
]

/** 对单个字符串脱敏。 */
export function redactText(input) {
  if (typeof input !== 'string' || input.length === 0) return input
  let out = input
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  for (const [re, rep] of PATH_PATTERNS) out = out.replace(re, rep)
  return out
}

/** 是否是一个看起来像密钥的键名。 */
export function isSecretKey(key) {
  if (typeof key !== 'string') return false
  const lower = key.toLowerCase().replace(/[-_\s]/g, '')
  return SECRET_KEYS.some((k) => lower === k.replace(/[-_\s]/g, '') || lower.includes(k.replace(/[-_\s]/g, '')))
}

/**
 * 递归脱敏。深度上限 8，循环引用安全。
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (depth > 8) return '«MAX_DEPTH»'
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string') return redactText(value)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value
  if (t === 'function') return '[Function]'
  if (value instanceof Error) {
    return { name: value.name, message: redactText(String(value.message)) }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '«CIRCULAR»'
    seen.add(value)
    return value.map((v) => redactDeep(v, depth + 1, seen))
  }
  if (t === 'object') {
    if (seen.has(value)) return '«CIRCULAR»'
    seen.add(value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? '«REDACTED»' : redactDeep(v, depth + 1, seen)
    }
    return out
  }
  return '«UNKNOWN»'
}

/**
 * 显示一个密钥的安全预览：只露头 3 位与尾 2 位。
 * 长度不足 8 时全遮。
 */
export function previewSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  if (secret.length < 8) return '•'.repeat(secret.length)
  return `${secret.slice(0, 3)}${'•'.repeat(Math.min(secret.length - 5, 8))}${secret.slice(-2)}`
}

/** 生成稳定的指纹（用于状态文件里标记「同一把密钥」，不存明文）。 */
export function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  // 简单的 FNV-1a 32 位，避免引入 crypto 依赖时序问题；不用于安全用途。
  let h = 0x811c9dc5
  for (let i = 0; i < secret.length; i++) {
    h ^= secret.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

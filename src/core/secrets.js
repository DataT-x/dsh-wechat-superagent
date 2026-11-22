/**
 * 凭据管理。
 *
 * 三条硬规则：
 *   1. 机器人 secret 与审批签名密钥只存在 `secrets.json`（0600），
 *      **任何**模型可见的输出都不包含它们（用 previewSecret 给界面看指纹）。
 *   2. 签名密钥首次使用时自动生成（32 字节随机），不要求用户理解它。
 *   3. 读取失败 → 视为「未配置」，而不是用默认值兜底（防止空密钥签名）。
 */
import { randomBytes } from 'node:crypto'
import { fileExists, files, readJson, writeJson } from './state.js'
import { fingerprint, previewSecret } from './redact.js'

/** 读取 secrets.json（不存在返回空对象）。 */
export function readSecrets() {
  const raw = readJson(files.secrets(), {}) ?? {}
  return {
    botSecret: typeof raw.botSecret === 'string' ? raw.botSecret : '',
    signingSecret: typeof raw.signingSecret === 'string' ? raw.signingSecret : '',
    githubToken: typeof raw.githubToken === 'string' ? raw.githubToken : '',
    updatedAt: raw.updatedAt ?? null,
  }
}

/** 写入 secrets.json（原子 + 0600）。 */
export function writeSecrets(patch) {
  const current = readSecrets()
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  writeJson(files.secrets(), next, { mode: 0o600 })
  return redactSecretsForUi(next)
}

/** 确保签名密钥存在；返回它。 */
export function ensureSigningSecret() {
  const s = readSecrets()
  if (typeof s.signingSecret === 'string' && s.signingSecret.length >= 32) return s.signingSecret
  const signingSecret = randomBytes(32).toString('hex')
  writeSecrets({ signingSecret })
  return signingSecret
}

/** 设置机器人 secret。 */
export function setBotSecret(secret) {
  const value = String(secret ?? '').trim()
  if (value.length < 8) throw new Error('机器人 Secret 看起来太短了（至少 8 个字符）')
  writeSecrets({ botSecret: value })
  return { ok: true, preview: previewSecret(value), fingerprint: fingerprint(value) }
}

/** 设置 GitHub token（可选，用于盯 issue/PR）。 */
export function setGithubToken(token) {
  const value = String(token ?? '').trim()
  if (value.length === 0) { writeSecrets({ githubToken: '' }); return { ok: true, preview: '' } }
  if (value.length < 20) throw new Error('GitHub token 看起来太短了')
  writeSecrets({ githubToken: value })
  return { ok: true, preview: previewSecret(value), fingerprint: fingerprint(value) }
}

/** 给 UI 的安全视图：只有预览与指纹。 */
export function redactSecretsForUi(secrets = readSecrets()) {
  return {
    botSecret: secrets.botSecret ? { preview: previewSecret(secrets.botSecret), fingerprint: fingerprint(secrets.botSecret) } : null,
    signingSecret: secrets.signingSecret ? { fingerprint: fingerprint(secrets.signingSecret) } : null,
    githubToken: secrets.githubToken ? { preview: previewSecret(secrets.githubToken), fingerprint: fingerprint(secrets.githubToken) } : null,
    updatedAt: secrets.updatedAt,
    fileExists: fileExists(files.secrets()),
  }
}

/** 是否已配置到「可以尝试连接」的程度。 */
export function isConfigured(config, secrets = readSecrets()) {
  return Boolean(config?.bot?.botId && secrets.botSecret)
}

/** 环境变量兜底（企业部署常用）：WECOM_BOT_ID / WECOM_BOT_SECRET。 */
export function envOverrides() {
  const botId = process.env.WECOM_BOT_ID?.trim() ?? ''
  const botSecret = process.env.WECOM_BOT_SECRET?.trim() ?? ''
  return { botId, botSecret, active: Boolean(botId && botSecret) }
}

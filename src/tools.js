/**
 * 暴露给模型的工具。
 *
 * 设计原则：
 *   - 工具只做「查询」和「请求」；真正的执行由模型调用原有工具（bash 等）完成，
 *     审批闸在那条路径上拦。所以这里不需要、也不应该提供 `git push` 这类直达工具。
 *   - 任何写操作都必须显式 `confirm: true`。
 *   - 所有输出先脱敏。
 */
import { defineTool } from './tool-kit.js'
import { redactDeep, redactText } from './core/redact.js'
import { mergeRules, actionLabel, ACTIONS } from './gate/rules.js'
import { gitSnapshot } from './core/git.js'
import { normalizeRepoSpec, sanitizeGhError, gh } from './core/gitwatch.js'
import { approversFor } from './core/authz.js'
import { files, tailNdjson } from './core/state.js'

/** 工具名统一前缀，避免与其他插件撞名。 */
export const TOOL_PREFIX = 'wecom_'

/** 所有工具名。 */
export const TOOL_NAMES = [
  'wecom_setup', 'wecom_status', 'wecom_send', 'wecom_request_approval',
  'wecom_pending', 'wecom_decide', 'wecom_watch', 'wecom_repo_here', 'wecom_audit_tail',
]

/**
 * 注册全部工具。
 * @param {object} params
 * @param {object} params.ctx 插件上下文（含 tools）
 * @param {object} params.deps 依赖注入：getConfig, setConfig, transport, approval, gate, gitwatch, secrets
 */
export function registerTools({ ctx, deps }) {
  const disposers = []

  // ---------- wecom_setup：配置机器人 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_setup',
    description: 'Configure the WeCom (企业微信) bot for this DSH profile. '
      + 'Without `botId`/`secret` it only reports the current state and what is missing. '
      + 'With both provided it saves them (the secret is stored outside the model context and never echoed back) and connects.',
    parameters: {
      botId: { type: 'string', description: 'The bot ID from 企业微信管理后台 → 应用管理 → 智能机器人.' },
      secret: { type: 'string', description: 'The bot Secret. Write-only: it is stored in a protected file and never returned.' },
      wsUrl: { type: 'string', description: 'Custom WebSocket endpoint, for private deployments only.' },
      ownerUserId: { type: 'string', description: 'The WeCom userid of the person who must give final approval on every request.' },
      connect: { type: 'boolean', description: 'Connect (or reconnect) right away. Defaults to true when credentials were supplied.' },
    },
    output: {
      properties: {
          ok: { type: 'boolean', required: true },
          configured: { type: 'boolean', required: true },
          online: { type: 'boolean', required: true },
          botId: { type: 'string' },
          secretPreview: { type: 'string' },
          ownerUserId: { type: 'string' },
          missing: { type: 'array', items: { type: 'string' } },
          message: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const config = deps.getConfig()
      const secrets = deps.readSecrets()
      const wasConfigured = Boolean(config.bot.botId && secrets.botSecret)

      if (typeof args.botId === 'string' && args.botId.trim().length > 0) {
        deps.setConfig({ bot: { ...config.bot, botId: args.botId.trim() } })
      }
      if (typeof args.wsUrl === 'string') {
        deps.setConfig({ bot: { ...deps.getConfig().bot, wsUrl: args.wsUrl.trim() } })
      }
      if (typeof args.secret === 'string' && args.secret.trim().length > 0) {
        deps.setBotSecret(args.secret.trim())
      }
      if (typeof args.ownerUserId === 'string' && args.ownerUserId.trim().length > 0) {
        deps.setConfig({ ownerUserId: args.ownerUserId.trim() })
      }

      const next = deps.getConfig()
      const nextSecrets = deps.readSecrets()
      const missing = []
      if (!next.bot.botId) missing.push('botId')
      if (!nextSecrets.botSecret) missing.push('secret')
      if (!next.ownerUserId) missing.push('ownerUserId（审批必须有负责人）')
      const configured = missing.length === 0

      let online = false
      const shouldConnect = args.connect === true || (args.connect === undefined && configured && !deps.transport.isOnline)
      if (configured && shouldConnect) {
        try {
          await deps.transport.reconnect(next.bot.botId, nextSecrets.botSecret, next.bot.wsUrl)
          online = deps.transport.isOnline
        } catch (error) {
          deps.setConfig({ enabled: false })
          return {
            ok: false, configured: true, online: false,
            message: `配置已保存，但连接失败：${redactText(String(error?.message ?? error))}\n请检查 botId/secret，或查看设置面板的「连接」页。`,
          }
        }
      } else {
        online = deps.transport.isOnline
      }
      if (configured) deps.setConfig({ enabled: true })

      const lines = []
      if (!configured) {
        lines.push('需要补全：', ...missing.map((m) => `- ${m}`))
        lines.push('', '在企微管理后台 → 应用管理 → 智能机器人，创建机器人后可以拿到 botId 与 Secret。')
      } else if (online) {
        lines.push(`✅ 机器人已上线（${next.bot.botId}）。`, `负责人：${next.ownerUserId || '未设置'}`)
        lines.push('', '现在可以在企微里直接给机器人发消息了。首次使用请在 DSH 里执行 `/wecom bind <chatId>` 绑定会话。')
      } else {
        lines.push(`✅ 配置已保存（${next.bot.botId}），但还没有连上。`)
        lines.push('执行 `wecom_setup({ connect: true })` 可以现在连。')
      }
      if (!wasConfigured && configured) lines.push('', '（Secret 已加密保存，模型与日志中都只保留指纹。）')
      return {
        ok: configured && (online || !shouldConnect),
        configured,
        online,
        botId: next.bot.botId,
        secretPreview: nextSecrets.botSecret ? deps.previewSecret(nextSecrets.botSecret) : '',
        ownerUserId: next.ownerUserId,
        missing,
        message: lines.join('\n'),
      }
    },
  })))

  // ---------- wecom_status：状态总览 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_status',
    description: 'Report the WeCom superagent state: connection, bound chats, watchers, pending approvals, '
      + 'and recent refusals. Never includes the bot secret.',
    parameters: {},
    output: {
      properties: {
          online: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          botId: { type: 'string' },
          boundChats: { type: 'integer', required: true },
          watchers: { type: 'integer', required: true },
          pendingApprovals: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const config = deps.getConfig()
      const secrets = deps.readSecrets()
      const state = deps.getState()
      const pending = deps.approval.list()
      const lines = [
        `**连接**：${deps.transport.isOnline ? '在线' : `离线（${deps.transport.state}）`}`,
        `**机器人**：${config.bot.botId || '未配置'}${secrets.botSecret ? '（Secret 已保存）' : '（缺少 Secret）'}`,
        `**负责人**：${config.ownerUserId || '⚠️ 未设置'}`,
        `**成员**：${(config.people ?? []).length} 人`,
        `**绑定会话**：${Object.keys(state.bindings ?? {}).length} 个`,
        `**守望仓库**：${(state.watchers ?? []).length} 个`,
        `**待审批**：${pending.length} 个`,
      ]
      if (!deps.transport.isOnline && config.enabled) {
        lines.push('', `最后一次错误：${redactText(String(deps.transport.lastError ?? '无详情'))}`)
      }
      const text = lines.join('\n')
      return {
        online: deps.transport.isOnline,
        state: deps.transport.state,
        botId: config.bot.botId,
        boundChats: Object.keys(state.bindings ?? {}).length,
        watchers: (state.watchers ?? []).length,
        pendingApprovals: pending.length,
        text,
      }
    },
  })))

  // ---------- wecom_send：主动发消息 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_send',
    description: 'Send a Markdown message or a card proactively to a WeCom chat (or to the chat that most recently '
      + 'woke this session when `chatId` is omitted). Requires `confirm: true` because it leaves the machine.',
    parameters: {
      text: { type: 'string', required: true, description: 'Markdown body.' },
      chatId: { type: 'string', description: 'Target chat/user id. Omit to reply into the session\'s origin chat.' },
      title: { type: 'string', description: 'Optional card title; makes it a text_notice card instead of Markdown.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    output: {
      properties: {
          ok: { type: 'boolean', required: true },
          chatId: { type: 'string' },
          delivered: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.delivered }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('wecom_send 需要 confirm: true（这是对外发送动作）')
      const origin = deps.gate.originOf(exec.agent?.session?.id ?? exec.agent?.id ?? '')
      const chatId = args.chatId || origin?.chatId
      if (!chatId) throw new Error('没有可发送的目标：请提供 chatId，或先让企微那边发一条消息给机器人。')
      if (!deps.transport.isOnline) throw new Error('机器人未在线，消息没有发出。')
      const body = redactText(String(args.text ?? ''))
      if (args.title) {
        await deps.transport.sendCard(chatId, {
          card_type: 'text_notice',
          main_title: { title: String(args.title).slice(0, 26) },
          sub_title_text: body.slice(0, 112),
        })
      } else {
        await deps.transport.sendMarkdown(chatId, deps.toWecomMarkdown(body))
      }
      return { ok: true, chatId, delivered: `已发送到会话 ${chatId}。` }
    },
  })))

  // ---------- wecom_request_approval：主动请求审批 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_request_approval',
    description: 'Ask humans to approve a planned action BEFORE you do it. Use this when the action is not a shell '
      + 'command (so the automatic gate cannot see it), e.g. publishing a package via an API, deleting a remote '
      + 'resource, or anything irreversible. Returns the outcome; on rejection the outcome says why.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['git.commit', 'git.push', 'git.force-push', 'git.branch.delete', 'git.reset', 'test.run',
          'build.run', 'release.publish', 'deploy.run', 'deps.install', 'db.migrate', 'file.delete',
          'secrets.change', 'tool.exec'],
        description: 'Which action catalogue entry this request is about.',
      },
      summary: { type: 'string', required: true, description: 'One line the approver will read first.' },
      detail: { type: 'string', description: 'Extra evidence (Markdown). Truncated to 1500 chars.' },
      approvers: { type: 'array', items: { type: 'string' }, description: 'Specific approver userids for the first stage.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    output: {
      properties: {
          outcome: { type: 'string', required: true },
          approvalId: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.confirm !== true) throw new Error('wecom_request_approval 需要 confirm: true')
      const config = deps.getConfig()
      const origin = deps.gate.originOf(exec.agent?.session?.id ?? exec.agent?.id ?? '')
      const cwd = exec.agent?.session?.meta?.cwd ?? process.cwd()
      let git = null
      try { git = await gitSnapshot(cwd) } catch { /* 无仓库也不阻断 */ }
      const rules = mergeRules(config.rules)
      const rule = rules[args.action] ?? {}
      const approval = deps.approval.create({
        action: args.action,
        risk: rule.risk ?? ACTIONS[args.action]?.risk ?? 'medium',
        approvalPolicy: rule.approval ?? ACTIONS[args.action]?.approval,
        detail: {
          ...(git ? { repo: git.repo, branch: git.branch, files: git.changedFiles.slice(0, 20), commits: git.aheadCommits.slice(0, 10), diffStat: git.diffStat } : {}),
          extra: String(args.detail ?? '').slice(0, 1500),
          command: '',
        },
        summary: String(args.summary ?? '').slice(0, 200),
        requestedBy: origin
          ? { userId: origin.senderId, name: origin.senderName ?? '', chatId: origin.chatId, chatType: origin.chatType }
          : { userId: 'local-user', name: '本地用户' },
        approvers: Array.isArray(args.approvers) ? args.approvers : [],
        timeoutMin: rule.timeoutMin,
        sessionId: exec.agent?.session?.id ?? null,
        toolName: 'wecom_request_approval',
      })
      try {
        await deps.deliver({ approval, kind: 'approval' })
      } catch (error) {
        deps.approval.cancel(approval.id, '无法送达')
        throw new Error(`审批卡片无法送达：${redactText(String(error?.message ?? error))}`)
      }
      const result = await deps.approval.waitFor(approval.id, exec.signal)
      const notes = {
        approved: '✅ 审批通过，可以继续。',
        rejected: `⛔ 审批被驳回${result.approval?.settleComment ? `：${result.approval.settleComment}` : '。'}不要执行该动作。`,
        expired: '⌛ 审批超时，视为拒绝。不要执行该动作。',
        cancelled: '🚫 审批被取消。不要执行该动作。',
      }
      return {
        outcome: result.outcome,
        approvalId: approval.id,
        note: `${notes[result.outcome] ?? '审批未通过。'}（编号 ${approval.id.slice(-6)}）`,
      }
    },
  })))

  // ---------- wecom_pending：查待办 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_pending',
    description: 'List approvals that are waiting for a decision, optionally filtered to one userid.',
    parameters: {
      userId: { type: 'string', description: 'Only show requests this userid must decide.' },
      sessionId: { type: 'string', description: 'Only show requests raised from this session.' },
    },
    output: {
      properties: {
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const items = deps.approval.list({ userId: args.userId, sessionId: args.sessionId })
      if (items.length === 0) return { count: 0, text: '没有待审批的请求。' }
      const lines = items.map((a) => {
        const remain = Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 60000))
        const who = a.stage === 'pending-owner' ? (a.owner ?? '?') : (a.approvers.join('、') || '—')
        return `- \`${a.id.slice(-6)}\` ${a.icon} **${a.actionLabel}** ${a.summary} — 待 ${who}（剩 ${remain} 分钟）`
      })
      return { count: items.length, text: ['**待审批**', ...lines].join('\n') }
    },
  })))

  // ---------- wecom_decide：以某个身份做决策 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_decide',
    description: 'Record an approval decision on behalf of a WeCom user. The userid must be one the approval names; '
      + 'approvals cannot be self-approved except by the owner. Use only when relaying a decision the human actually gave.',
    parameters: {
      approvalId: { type: 'string', required: true, description: 'Full id or the last 6 characters.' },
      userId: { type: 'string', required: true, description: 'The WeCom userid making the decision.' },
      verdict: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'The decision.' },
      comment: { type: 'string', description: 'Optional comment stored in the audit trail.' },
      phrase: { type: 'string', description: 'Confirmation phrase, required for phrase-gated actions.' },
      confirm: { type: 'boolean', description: 'Must be true.' },
    },
    output: {
      properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.confirm !== true) throw new Error('wecom_decide 需要 confirm: true')
      const target = findApproval(deps.approval, args.approvalId)
      if (!target) return { ok: false, text: `找不到审批 ${args.approvalId}` }
      const result = deps.approval.decide({
        approvalId: target.id,
        userId: args.userId,
        verdict: args.verdict,
        comment: args.comment,
        phrase: args.phrase,
      })
      return { ok: result.ok, text: result.ok ? `已记录：${args.userId} ${args.verdict === 'approve' ? '通过' : '驳回'}（${target.id.slice(-6)}）${result.note ? `，${result.note}` : ''}` : `未记录：${result.reason}` }
    },
  })))

  // ---------- wecom_watch：订阅仓库 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_watch',
    description: 'Watch a git repository and wake this session in WeCom when it changes. Accepts a local absolute path, '
      + '`owner/name`, `gitee:owner/name`, or a repository URL. Without arguments it lists current watches.',
    parameters: {
      repo: { type: 'string', description: 'Repository to watch, or omit to list.' },
      action: { type: 'string', enum: ['add', 'remove', 'list', 'pause', 'resume'], description: 'Defaults to add when repo is present, else list.' },
      intervalSec: { type: 'integer', description: 'Polling interval in seconds (30–3600, default from config).' },
      chatId: { type: 'string', description: 'WeCom chat to wake. Omit for the current session origin.' },
      events: { type: 'array', items: { type: 'string', enum: ['commits', 'tags', 'issues', 'pulls'] }, description: 'What to watch for.' },
      confirm: { type: 'boolean', description: 'Must be true for add/remove.' },
    },
    output: {
      properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = args.action ?? (args.repo ? 'add' : 'list')
      const origin = deps.gate.originOf(exec.agent?.session?.id ?? exec.agent?.id ?? '')
      if (action === 'list') {
        const list = deps.gitwatch.list()
        if (list.length === 0) return { ok: true, count: 0, text: '还没有守望任何仓库。' }
        return {
          ok: true, count: list.length,
          text: ['**守望中**', ...list.map((w) => `- \`${w.repo}\` 每 ${Math.round(w.intervalMs / 1000)}s，事件：${(w.events ?? []).join('/')}${w.lastError ? `（错误：${w.lastError}）` : ''}`)].join('\n'),
        }
      }
      if (args.confirm !== true) throw new Error('wecom_watch 的增删需要 confirm: true')
      const chatId = args.chatId || origin?.chatId
      if (!chatId) throw new Error('没有目标会话：请提供 chatId，或先让企微那边发一条消息给机器人。')
      const config = deps.getConfig()
      if (action === 'add') {
        const existing = deps.gitwatch.list().filter((w) => w.chatId === chatId)
        if (existing.length >= config.watch.maxWatchesPerChat) {
          return { ok: false, count: existing.length, text: `这个会话已经守望了 ${existing.length} 个仓库（上限 ${config.watch.maxWatchesPerChat}）。` }
        }
        const intervalMs = args.intervalSec ? args.intervalSec * 1000 : config.watch.defaultIntervalSec * 1000
        const r = await deps.gitwatch.add({
          repo: args.repo,
          chatId,
          chatType: origin?.chatType ?? 'single',
          addedBy: origin?.senderId ?? 'local-user',
          intervalMs,
          sessionId: exec.agent?.session?.id ?? null,
          events: args.events,
        })
        if (!r.ok) return { ok: false, count: deps.gitwatch.list().length, text: `⛔ ${r.reason}` }
        return { ok: true, count: deps.gitwatch.list().length, text: `👀 开始守望 \`${args.repo}\`（每 ${Math.round(r.intervalMs / 1000)}s）。有动静会在这个会话里叫你。` }
      }
      if (action === 'remove') {
        const r = await deps.gitwatch.remove({ repo: args.repo, chatId })
        return { ok: r.ok, count: deps.gitwatch.list().length, text: r.ok ? `已停止守望 \`${args.repo}\`。` : `⛔ ${r.reason}` }
      }
      return { ok: false, count: deps.gitwatch.list().length, text: '未知操作。' }
    },
  })))

  // ---------- wecom_repo_here：当前仓库快照 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_repo_here',
    description: 'Inspect the git repository in the current working directory (or a given path): branch, remote, '
      + 'dirty files, unpushed commits, and diff stat. Read-only.',
    parameters: {
      path: { type: 'string', description: 'Directory to inspect; defaults to the session working directory.' },
    },
    output: {
      properties: {
          isRepo: { type: 'boolean', required: true },
          repo: { type: 'string' },
          branch: { type: 'string' },
          ahead: { type: 'integer', required: true },
          dirty: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = args.path || exec.agent?.session?.meta?.cwd || process.cwd()
      const snap = await gitSnapshot(cwd)
      if (!snap.root) return { isRepo: false, ahead: 0, dirty: 0, text: `${cwd} 不是 git 仓库。` }
      const lines = [
        `**仓库**：\`${snap.repo || snap.remoteUrl || snap.root}\``,
        `**分支**：\`${snap.branch}\`（领先远端 ${snap.ahead} 个提交）`,
        `**工作区**：${snap.clean ? '干净' : `${snap.changedFiles.length} 个文件有改动`}`,
      ]
      if (snap.diffStat) lines.push(`**统计**：${snap.diffStat}`)
      if (snap.aheadCommits.length > 0) {
        lines.push('**未推送**：', ...snap.aheadCommits.slice(0, 5).map((c) => `- \`${c.sha}\` ${c.subject}`))
      }
      if (snap.changedFiles.length > 0) {
        lines.push('**改动**：', ...snap.changedFiles.slice(0, 10).map((f) => `- \`${f.status}\` ${f.path}`))
      }
      return {
        isRepo: true, repo: snap.repo, branch: snap.branch,
        ahead: snap.ahead, dirty: snap.changedFiles.length, text: lines.join('\n'),
      }
    },
  })))

  // ---------- wecom_audit_tail：审计日志 ----------
  disposers.push(ctx.tools.register(defineTool({
    name: 'wecom_audit_tail',
    description: 'Show the most recent audit records (approvals, refusals, watches). Sensitive values are redacted.',
    parameters: {
      limit: { type: 'integer', description: 'How many records (default 20, max 200).' },
    },
    output: {
      properties: {
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 20))
      const rows = tailNdjson(files.audit(), limit)
      if (rows.length === 0) return { count: 0, text: '审计日志还是空的。' }
      const lines = rows.map((r) => `- ${r.at ?? ''} **${r.type ?? '?'}** ${r.action ?? ''} ${r.id ? `\`${String(r.id).slice(-6)}\`` : ''} ${r.outcome ?? ''}`)
      return { count: rows.length, text: ['**最近审计**', ...lines].join('\n') }
    },
  })))

  return disposers
}

/** 按 id 或后 6 位找审批。 */
function findApproval(engine, input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) return null
  const direct = engine.get(raw)
  if (direct) return direct
  const norm = raw.toUpperCase()
  return engine.list().find((a) => a.id.slice(-6).toUpperCase() === norm) ?? null
}

export { actionLabel, normalizeRepoSpec, sanitizeGhError, gh, approversFor, redactDeep }

# dsh-wechat-superagent — 架构与设计

> 本项目是 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
> 面向企业微信的二开实现：把「盯仓库 + 唤醒会话」升级为「企微机器人 + 仓库守望 + 分级审批」。
> 参考实现：[xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（IM 接入）、
> [MYCF711/dsh-session-superagent](https://github.com/MYCF711/dsh-session-superagent)（会话级 superagent）。

## 一、目标能力

| # | 能力 | 落点 |
|---|---|---|
| 1 | 一键创建企微机器人 | `src/wecom/` + 设置面板「机器人」页 |
| 2 | 盯住 Git 项目，有权限的人在企微下任务 | `src/core/gitwatch.js` + 权限闸 `src/core/authz.js` |
| 3 | 上下文增强（渠道/标题/时间/昵称/会话类型） | `src/core/context.js` |
| 4 | 分级审批（提交/推送/测试/构建/发布…）+ 负责人二次审批 | `src/core/approval.js` + `src/gate/policy.js` |
| 5 | 企微卡片审批（点按钮即走） | `src/wecom/cards.js` |
| 6 | 复用 superagent 能力、无明显漏洞 | 全链路 fail-closed |

## 二、进程与线程模型

```
┌────────────────────────── DSH 宿主进程 ──────────────────────────┐
│                                                                  │
│  WeComTransport (src/wecom/transport.js)                         │
│    ├─ WSClient 长连接 (wss://openws.work.weixin.qq.com)           │
│    ├─ 入站: message.text / event.template_card_event              │
│    └─ 出站: sendMessage / updateTemplateCard / replyStream        │
│              │                                                   │
│              ▼                                                   │
│  Router (src/core/router.js)  —— 会话映射 + 去重 + 串行队列        │
│    ├─ 入站鉴权 authz.js (谁能下命令 / 谁能审批)                    │
│    ├─ 上下文增强 context.js (生成 UserMessage 前缀)               │
│    └─ agent.followup()/steer() 唤醒 DSH 会话                      │
│              │                                                   │
│              ▼                                                   │
│  DSH Agent / Session                                             │
│    ├─ tools/pre-execute  ──▶ ApprovalEngine (src/core/approval.js)│
│    │                          ├─ 规则匹配 gate/policy.js          │
│    │                          ├─ 卡片推送 cards.js                │
│    │                          └─ 等待决策（二级审批）              │
│    └─ 工具用 git/gh 干活                                          │
│              │                                                   │
│  GitWatcher (src/core/gitwatch.js)                               │
│    └─ 本地 git + gh API 轮询 → 有新动静 → 唤醒会话                 │
└──────────────────────────────────────────────────────────────────┘
```

**关键设计判断（都有依据）**

1. **不复刻 dsh-im 的多渠道框架**，只做企业微信一条通道，换取可读性与可验证性。
2. **入站消息走 `agent.followup()` / `steer()`**（`dsh-agent` 的稳定 API），
   而不是自己造会话——复用 DSH 的持久化、压缩、模型选择。
3. **审批挂在 `tools/pre-execute` waterfall 上**（`dsh-tools/src/events.ts:18`），
   这是唯一能在工具**执行前**拦截并让外部决策的位置；同时**串联**
   `ctx.approval` 的 `approval/request` 事件（`dsh-user-approval/src/types.ts:87`），
   这样 DSH 原生 UI 里的审批决定也能被我们接管/镜像。
4. **凭证绝不进模型上下文**：`botSecret` 存在 `~/.dsh/wecom-superagent/secrets.json`（0600），
   工具输出统一过 `redact()`。
5. **fail-closed**：任何无法判断的情况（审批超时、连接断开、规则匹配异常）
   一律视为**拒绝**，而不是放行。

## 三、模块清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/index.js` | 插件入口：`name/inject/apply/Config`，装配所有子模块 | — |
| `src/config.js` | 配置 schema + 持久化（`~/.dsh/wecom-superagent/config.json`） | — |
| `src/core/secrets.js` | 凭据读写、脱敏、0600 权限 | — |
| `src/core/redact.js` | 全量脱敏（token/secret/私钥/绝对路径） | — |
| `src/core/authz.js` | 角色解析：owner / approver / operator / viewer | config |
| `src/core/context.js` | 上下文增强渲染（渠道/标题/时间/昵称/会话类型/指令） | — |
| `src/core/dedupe.js` | 消息去重（msgid LRU）+ 幂等 | — |
| `src/core/router.js` | 企微会话 ↔ DSH 会话映射、入站分发 | authz/context/dedupe |
| `src/core/approval.js` | 审批引擎：规则→卡片→等待→归档 | gate/cards |
| `src/core/gitwatch.js` | 本地 git + gh 轮询、水位、冷却 | — |
| `src/core/tasks.js` | 任务队列（提交/推送/测试/构建/发布）与执行记录 | approval |
| `src/core/state.js` | 状态文件原子读写（JSON） | — |
| `src/gate/rules.js` | 审批规则模型与默认规则集 | — |
| `src/gate/policy.js` | 规则匹配（命令/路径/分支/风险等级） | rules |
| `src/wecom/transport.js` | WSClient 封装、重连、队列、事件转发 | SDK |
| `src/wecom/cards.js` | 卡片构造（简洁美观）与按钮协议编码 | transport |
| `src/wecom/commands.js` | 聊天内指令解析（`/help`、`/approve`…） | — |
| `src/tools.js` | 暴露给模型的 LLM 工具 | 全部 |
| `src/http.js` | 本地设置页 / 健康检查路由 | webServer |
| `src/client.js` | DSH 设置面板（原生 slot） | — |

## 四、审批数据模型

```jsonc
{
  "id": "apr_01H...",
  "createdAt": "2026-11-21T14:00:00.000Z",
  "action": "git.push",            // 动作类型
  "risk": "high",                  // low | medium | high | critical
  "summary": "推送 3 个提交到 origin/main",
  "detail": {                      // 结构化证据，卡片渲染用
    "repo": "owner/name",
    "branch": "main",
    "commits": ["abc123 修复登录", "def456 补充测试"],
    "files": [{ "path": "src/a.js", "additions": 12, "deletions": 3 }],
    "diffStat": "4 files changed, 51 insertions(+), 12 deletions(-)"
  },
  "requestedBy": { "userId": "zhangsan", "name": "张三" },
  "approvers": ["lisi"],           // 一级审批人（发起人可指定）
  "owner": "wangwu",               // 负责人（二级审批，必须）
  "stage": "pending-primary",      // pending-primary | pending-owner | approved | rejected | expired | cancelled
  "decisions": [
    { "stage": "primary", "userId": "lisi", "outcome": "approve", "comment": "OK", "at": "..." }
  ],
  "expiresAt": "2026-11-21T14:30:00.000Z",
  "cardMsgId": "..."               // 用于更新卡片
}
```

**动作类型全集**（`src/gate/rules.js`）：

| action | 说明 | 默认风险 | 默认需要的审批 |
|---|---|---|---|
| `git.commit` | 提交代码 | medium | 一级 + 负责人 |
| `git.push` | 推送代码 | high | 一级 + 负责人 |
| `git.force-push` | 强推 | critical | 负责人 + 二次确认短语 |
| `git.branch.delete` | 删分支 | high | 负责人 |
| `git.worktree` | 隔离区操作 | low | 按配置 |
| `test.run` | 运行测试 | low | 按配置 |
| `build.run` | 构建项目 | medium | 一级 |
| `release.publish` | 构建发布 | critical | 负责人 + 二级确认 |
| `deploy.run` | 部署 | critical | 负责人 + 第二负责人 |
| `deps.install` | 安装/升级依赖 | high | 一级 + 负责人 |
| `db.migrate` | 数据库迁移 | critical | 负责人 + 第二负责人 |
| `file.delete` | 批量删除文件 | high | 负责人 |
| `tool.exec` | 任意高风险命令 | 按匹配 | 动态 |

## 五、安全边界

1. **入站身份**：企微长连接帧自带 `from.userid`，不可伪造（走企微通道）；
   但**群聊里任何人**都能发消息，所以必须过 `authz`。
2. **命令注入**：模型生成的 git 命令一律走 `execFile('git', [...])` 数组参数，
   不拼 shell 字符串；带 `--` 分隔符；分支/路径做白名单校验。
3. **审批绕过**：规则匹配在 `tools/pre-execute`，**先于**工具体；
   审批未通过直接返回 `{kind:'deny'}`，模型无法自批。
4. **卡片密钥**：卡片按钮的 `key` 内含审批 ID + 动作 + HMAC 签名，
   防伪造点击；`task_id` 全局唯一。
5. **时限**：审批默认 30 分钟过期，过期即拒绝；卡片同步更新为「已过期」。
6. **审计**：所有决策写入 `~/.dsh/wecom-superagent/audit.ndjson`，只追加。
7. **限流**：单用户每分钟最多 N 条指令；单会话同时最多 1 个待审批。
8. **敏感信息**：`redact()` 覆盖 `sk-`、`gho_`、`Bearer`、私钥块、`.env` 值。

## 六、与 DSH 原生能力的配合

- **goal**：`watch_start` 可带 `goal`，唤醒消息附上当前 goal。
- **schedule**：定时任务交给 DSH 自带调度，插件只做「有事叫醒」。
- **permission-presets**：`danger-full-access` 下我们的审批闸仍然生效（独立于 sandbox）。
- **action-cards**：审批卡片在 DSH UI 里也镜像一份，点谁都算数。

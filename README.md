<p align="center">
  <img src="assets/icon.svg" width="120" alt="dsh-wechat-superagent">
</p>

<h1 align="center">dsh-wechat-superagent</h1>

<p align="center">
  把 DSH 会话接进企业微信：扫码建机器人，群里下任务，<br />
  提交/推送/测试/构建/发布全部走企微卡片审批。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-green.svg" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-4D6BFE.svg" alt="license">
  <img src="https://img.shields.io/badge/dsh-0.2.2--rc.5-4D6BFE.svg" alt="dsh">
</p>

---

## 这是什么

一个 DSH（DeepSeek Harness）插件。它把官方原型
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的
「盯仓库 + 唤醒会话」能力，扩展成一套**带审批闸的企业微信协作流程**：

| 你要的事 | 这个插件怎么做 |
|---|---|
| 一键创建企微机器人 | 复用腾讯官方扫码授权页，扫完自动写入凭据并连接 |
| 盯住 Git 项目 | 本地 `git fetch` 轮询新提交/新标签；可选盯 GitHub issue/PR |
| 有权限的人下任务 | 企微单聊/群聊消息直接送进绑定好的 DSH 会话 |
| 上下文增强 | 渠道、会话类型、会话标题、发送者昵称、发送时间，字段可逐个开关 |
| 分级审批 | 14 类动作（提交/推送/强推/测试/构建/发布/部署/迁移…）各有默认风险与审批策略 |
| 负责人二次审批 | 一级审批通过后必须再由负责人确认；发布/部署还要第二负责人 |
| 卡片审批 | 企微模板卡片，点「通过/驳回/详情/暂缓」即可，带签名防伪造 |

## 它不做什么

- **不做公网暴露**：全靠企微 WebSocket 长连接，家里/内网的机器也能用。
- **不替模型执行命令**：审批只是「拦一道」，命令仍由模型原来的工具执行。
- **不把密钥交给模型**：机器人 Secret 只在 `secrets.json`（0600），模型只能看到指纹。

## 快速开始

### 1. 安装

```bash
# 从源码目录安装（开发用）
dsh plugin --profile desktop add "link:D:\project\dsh-wechat-superagent"

# 或从 npm（发布后）
dsh plugin --profile desktop add @datat-x/dsh-wechat-superagent
```

装完**重启 DSH**（bundle 层需要重新组装）。

### 2. 创建机器人

在 DSH 里说一句话：

```text
帮我把企业微信机器人接上
```

模型会调用 `wecom_setup()`，它告诉你还缺什么。也可以直接给：

```text
wecom_setup({ botId: "你的botId", secret: "你的secret", ownerUserId: "你的userid" })
```

更省事的办法：打开设置面板 → 企业微信 Superagent → **一键创建机器人** → 手机扫码。
（本地面板地址：`http://127.0.0.1:3080/wecom-superagent/ui?token=<state.json 里的 panelToken>`）

### 3. 绑定会话

在企微里给机器人发一条消息，它会回你一个 chatId。然后：

```text
/bind <会话ID前8位>
```

或者打开设置里的「自动绑定」，新消息会绑定到最近活跃的会话。

### 4. 开始用

在企微里直接说：

```text
把这周的 issue 处理一下，能修的修，修完提 PR
```

模型干活时会自动触发审批：`git commit` 要一级审批 + 负责人，`git push` 再加一道。
审批卡片会发回你说话的那个会话，点「通过」才继续。

## 审批动作全集

| 动作 | 默认风险 | 默认策略 | 说明 |
|---|---|---|---|
| `git.commit` | 中 | 一级 + 负责人 | 提交代码 |
| `git.push` | 高 | 一级 + 负责人 | 推送代码 |
| `git.force-push` | 严重 | 负责人+第二负责人 + 确认短语 | 强推会覆盖他人提交 |
| `git.branch.delete` | 高 | 负责人 | 删分支 |
| `git.reset` | 严重 | 负责人+第二负责人 + 确认短语 | `reset --hard` / `clean -fd` |
| `git.worktree` | 低 | 免审 | 隔离区操作 |
| `test.run` | 低 | 免审 | 跑测试 |
| `build.run` | 中 | 一级审批 | 构建产物 |
| `release.publish` | 严重 | 负责人+第二负责人 + 确认短语 | 发布到公开渠道 |
| `deploy.run` | 严重 | 负责人+第二负责人 | 部署上线 |
| `deps.install` | 高 | 一级 + 负责人 | 依赖变更（含改 package.json） |
| `db.migrate` | 严重 | 负责人+第二负责人 + 确认短语 | 数据库迁移 |
| `file.delete` | 高 | 负责人 | 批量删除 |
| `secrets.change` | 严重 | 负责人+第二负责人 | 改动 `.env` / `*.pem` 等 |

策略说明：

- `none` 不审（仍记审计）
- `primary` 一级审批人
- `owner` 直接负责人
- `dual` 一级 + 负责人
- `owner2` 负责人 + 第二负责人
- `phrase` 在 `dual` 基础上，每级都要输入确认短语（防止误点）

**所有规则都可以在设置面板里逐条改**（风险等级、策略、时限、启停）。

## 企微里的指令

| 指令 | 作用 |
|---|---|
| 直接说话 | 送进绑定的 DSH 会话 |
| `/help` | 帮助 |
| `/status` | 连接、绑定、待审批、守望状态 |
| `/pending` | 我的待审批 |
| `/approve <编号>` | 通过 |
| `/reject <编号> [意见]` | 驳回 |
| `/stop` | 停止当前任务 |
| `/bind <会话ID>` | 绑定 DSH 会话（需审批人权限） |
| `/watch owner/name` | 开始守望仓库 |
| `/unwatch owner/name` | 停止守望 |

## 上下文增强

每条入站消息会带一段前缀，让模型知道「谁、在哪、什么时候」说的：

```text
<wecom-context>
渠道: 企业微信
会话类型: 群聊
会话: 研发一组
发送者: 张三 (zhangsan) ［角色: operator］
时间: 2026-11-21 22:10:00 (Asia/Shanghai)
</wecom-context>

（这条消息来自企业微信群聊。请简明作答，必要时用 Markdown；不要输出只有终端看得懂的字符画。）

修复登录页的样式问题
```

字段可以在设置面板里逐个关闭，控制 token 开销。时间区可配置。

## 权限模型

| 角色 | 能做什么 |
|---|---|
| `owner` 负责人 | 一切审批的最终关卡；改配置、管成员 |
| `approver` 审批人 | 审批一级节点 |
| `operator` 操作员 | 下任务、发起审批 |
| `viewer` 旁观者 | 只能查询状态 |

**没登记的人一律拒绝**（fail-closed）。群聊还可以用 `allowedGroupIds` 限定只响应指定群。

## 安全设计

1. **密钥隔离**：Secret 存 `~/.dsh/wecom-superagent/secrets.json`（0600 原子写），模型侧只见指纹。
2. **卡片防伪**：按钮 key 内含 HMAC 签名，改一个字节就失效。
3. **审批 fail-closed**：超时 = 拒绝；卡片发不出去 = 拒绝；规则匹配异常 = 拒绝。
4. **命令不拼 shell**：所有 git 调用走 `execFile` 数组参数。
5. **全链路脱敏**：`redact()` 覆盖 GitHub token、LLM key、PEM 私钥、Bearer、`.env` 值、绝对路径。
6. **本地面板鉴权**：只接受回环地址 + 面板 token（48 位随机）。
7. **审计留痕**：所有审批与决策写 `audit.ndjson`（只追加）。
8. **不能自批**：发起人不能审批自己的请求（负责人除外）。

## 数据存放

```
~/.dsh/wecom-superagent/
├── config.json        配置（面板可改）
├── secrets.json       机器人 Secret / 签名密钥（0600）
├── state.json         会话绑定、守望列表、面板 token
├── audit.ndjson       审计日志（只追加）
└── pending/           每个待审批一份（崩溃重启不丢）
```

## 工具（给模型的）

| 工具 | 用途 |
|---|---|
| `wecom_setup` | 配置/连接机器人 |
| `wecom_status` | 状态总览 |
| `wecom_send` | 主动发消息（需 `confirm`） |
| `wecom_request_approval` | 主动请求审批（非命令类动作） |
| `wecom_pending` | 查待审批 |
| `wecom_decide` | 代某个企微用户记录决策 |
| `wecom_watch` | 订阅/取消订阅仓库 |
| `wecom_repo_here` | 当前仓库快照 |
| `wecom_audit_tail` | 最近审计 |

## 与 DSH 自带能力的关系

- **审批闸挂在 `tools/pre-execute`**：先于工具执行，模型绕不过去。
- **同时接管 `approval/request`**：DSH 原生审批（沙箱升级等）也会推到企微；
  会话不来自企微时自动交还浏览器 UI。
- **唤醒用 `agent.followup()` / `agent.steer()`**：复用 DSH 的持久化、压缩、模型选择。
- **不抢 schedule**：定时任务仍交给 DSH 自带调度。

## 开发

```bash
npm install
npm test        # 279 项单测
npm run check   # 语法检查 + 单测
```

目录：

```
src/
├── index.js            插件入口与装配
├── config.js           配置 schema / 归一化
├── tool-kit.js         工具定义适配器（自带参数校验）
├── tools.js            9 个 LLM 工具
├── http.js             设置面板 + API
├── core/
│   ├── approval.js     审批引擎（状态机 + 等待 + 重启恢复）
│   ├── authz.js        角色与权限判定
│   ├── context.js      上下文增强渲染
│   ├── dedupe.js       消息去重
│   ├── git.js          git 快照（execFile，无 shell）
│   ├── gitwatch.js     仓库守望（水位 + 冷却）
│   ├── log.js          日志适配
│   ├── redact.js       脱敏
│   ├── router.js       企微消息 → 会话路由
│   ├── secrets.js      凭据读写
│   └── state.js        原子读写
├── gate/
│   ├── policy.js       工具调用 → 动作分类
│   └── rules.js        动作目录与默认策略
├── host/
│   ├── gate.js         tools/pre-execute 闸门
│   └── native-approval.js  approval/request 桥接
└── wecom/
    ├── cards.js        卡片构造与按钮签名
    ├── provision.js    扫码创建机器人
    └── transport.js    长连接封装
```

## 已知限制

- **只支持企微智能机器人（长连接）**，不支持企微自建应用（回调 URL）。
- **群聊里任何人都能发消息**，所以权限必须显式配置，否则一律拒绝。
- **轮询有延迟**：守望间隔最小 30 秒。
- **`gh` 未安装时**，GitHub issue/PR 订阅不可用（本地 git 守望不受影响）。
- **审批卡片 5 分钟内必须更新**：企微限制，我们已按此实现。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 相关项目

- [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) —— 本项目的起点
- [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) —— 多渠道 IM 接入（企微扫码授权的参考）
- [MYCF711/dsh-session-superagent](https://github.com/MYCF711/dsh-session-superagent) —— 会话级 superagent

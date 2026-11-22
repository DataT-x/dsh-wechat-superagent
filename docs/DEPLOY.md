# 部署与验证

## 一、装到本机

```bash
# 1. 装依赖（插件只有 schemastery 是硬依赖）
cd D:\project\dsh-wechat-superagent
npm install

# 2. 跑测试
npm test

# 3. 装进 profile（⚠️ 桌面端要先退出 DSH）
dsh plugin --profile desktop add "link:D:\project\dsh-wechat-superagent"

# 4. 重启 DSH
```

> **桌面端注意**：`dsh plugin` 对 Electron 管理的 profile 会报
> `profile "desktop" is managed exclusively by the Electron application`。
> 这种情况用设置面板的「插件市场 → 从本地目录安装」，或直接改
> `~/.dsh/profiles/desktop/package.json`：
>
> ```json
> {
>   "dependencies": { "@datat-x/dsh-wechat-superagent": "link:D:/project/dsh-wechat-superagent" },
>   "dsh": { "profile": { "bundles": [ "...", "@datat-x/dsh-wechat-superagent" ] } }
> }
> ```
>
> 然后 `pnpm install --offline` 或删掉 `node_modules/.modules.yaml` 重装。

## 二、检查是否加载成功

启动后：

1. **日志**：DSH 日志里出现 `[wecom] 企业微信 superagent 启动中`。
2. **工具**：让模型调 `wecom_status()`，应该返回状态而非「工具不存在」。
3. **设置页**：浏览器访问 `http://127.0.0.1:3080/wecom-superagent/ui?token=<panelToken>`
   （token 在 `~/.dsh/wecom-superagent/state.json` 的 `panelToken` 字段）。

## 三、首次接入

1. 打开设置页 →「接入」→「生成二维码」
2. 手机企业微信扫码 → 在腾讯页面点「创建智能机器人」
3. 回到设置页，看到 `✅ 创建成功，机器人已上线`
4. 「成员与角色」里填负责人 userId（**必填**，否则所有审批都会被拒）
5. 让目标用户在企微里给机器人发一条消息
6. 看「审计」页找到 `inbound` 记录，拿到 chatId
7. 在 DSH 里执行 `/wecom bind <chatId>` 或让用户发 `/bind <会话前8位>`

## 四、端到端验证清单

| # | 操作 | 期望 |
|---|---|---|
| 1 | 企微发「你好」 | 回 `✅ 已收到，正在处理`；DSH 会话收到带 `<wecom-context>` 的消息 |
| 2 | 企微发 `/status` | 显示绑定会话、角色、待审批数 |
| 3 | 让模型改一个文件 | 无审批（写文件不在动作目录的强审范围，走 `tool.exec` 兜底时按风险） |
| 4 | 让模型 `git commit` | 企微收到审批卡片；点「通过」后一级通过，卡片更新为待负责人 |
| 5 | 负责人点「通过」 | 卡片变成「✅ 审批通过」，工具继续执行 |
| 6 | 让模型 `git push` | 同上，且卡片里有待推送的提交列表 |
| 7 | 让模型 `git push --force` | 卡片要求输入确认短语；聊天里发短语才通过 |
| 8 | 超时（把时限调到 1 分钟） | 卡片变成「⌛ 审批已过期」，工具被拒绝 |
| 9 | 未授权的人发消息 | 回 `⛔ 你不在授权名单里` |
| 10 | 设置页关掉机器人 | 工具调用不再弹卡片（但仍记审计 `gate.allow.disabled`） |

## 五、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具不存在 | 插件没挂上 | 检查 profile 的 `bundles` 与 `cordis.patch.yml` 里的包名是否一致 |
| 启动即报 `Cannot find package '@deepseek-ai/dsh-tools'` | 引用了宿主内部包 | 本项目已内置 `tool-kit.js`，不要改成 import |
| 「机器人未在线」 | 没扫码/secret 错 | 设置页「连接」看 state 与 lastError |
| 卡片点了没反应 | 卡片超过 5 分钟 | 重新发起审批 |
| 「审批闸无法判定」 | 分类函数抛错 | 看审计里 `gate.classify.error` 的 error 字段 |
| 群聊里不响应 | `allowedGroupIds` 限制 | 清空该字段或把群 chatId 加进去 |

## 六、卸载

```bash
dsh plugin --profile desktop remove @datat-x/dsh-wechat-superagent
rm -rf ~/.dsh/wecom-superagent
```

---

# 发布到 GitHub / npm

见 `scripts/publish.mjs`。

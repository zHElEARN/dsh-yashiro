# dsh-yashiro

把 QQ 群机器人接到 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 上的通道插件（dsh bundle）。

**QQ 只是感官和发声器官，dsh agent 才是主体。**

## 架构

```
QQ 群消息 ──▶ 归一化 ──▶ 历史库（全部入库）
                            │
                            ├─ 没 @ 机器人 ──▶ 到此为止（不进上下文）
                            │
                            └─ @ 了机器人 ──▶ followup() 唤醒 agent 回合
                                                    │
                    ┌───────────────────────────────┘
                    ▼
              dsh agent 跑一个完整回合（思考、调工具、可以调 bash…）
                    │
                    ├─▶ qqbot_history   自己查群里之前聊了什么
                    └─▶ qqbot_send      唯一的发声通道 ──▶ QQ 群
```

## 设计取舍（都是明确确认过的）

| 决定 | 原因 |
|---|---|
| **插件不接管 agent 的输出** | 回复完全由 agent 调 `qqbot_send` 完成。思考过程、工具调用一律不同步到 QQ |
| **非 @ 消息只入库、不进上下文** | agent 不背整个群的流水账；需要时自己查 |
| **一律主动发送**（不绑 msg_id） | 不受被动回复 5 分钟 / 5 次的时效约束 |
| **一个 QQ 会话 = 一条 dsh 会话** | SessionId 由 `yashiro:${appId}:${scope}:${peerId}` 做 SHA-256 确定性派生，跨重启自动 resume |
| **附件的所有信息都带给 agent，但插件不下载、不持久化** | 既然 agent 已经独立自主，附图怎么看由它自己决定 |
| **不做斜杠命令 / 不做上下文压缩 / 不做多会话切换** | v1 范围；extension 点见下 |
| **`/new` 之类先不做** | agent 忘了调工具就没人管，靠 system prompt 强约束 |

## 实测记录（2026-09-20）

第一轮 @「你好，回我一声」：

```
[7]  system/message   You are an AI agent powered by DeepSeek Harness. … 你是一个 QQ 群里的成员…
[8]  user/message     Zhe_Learn 在群里 @ 了你：你好，回我一声   (source: plugin/dsh-yashiro)
[11] request/header   model=deepseek-official/deepseek-flash effort=max
[13] assistant/message blocks=[reasoning, tool-call]
[14] tool/call        qqbot_send {"text":"在的在的，Zhe_Learn 你好👋 有什么需要帮忙的吗？"}
[15] tool/result      已发出 1 条消息到群里。
```

第二轮 @「我刚才跟你说了啥？」——**它自己去查了历史**：

```
[21] agent/inbox/spliced  …我刚才跟你说了啥？…（自你上次开口以来，群里还有 1 条新消息…）
[27] tool/call        qqbot_history {"limit":20,"since_minutes":30}
[28] tool/result      共 12 条：[2026-09-20 18:35:…]
[32] tool/call        qqbot_send {"text":"你刚刚 18:41 跟我说的是一句「你好，回我一声」…再往前翻的话，18:37 你还发过…"}
```

## 自检

```sh
pnpm selfcheck    # 70 项：附件传递、访问控制、/id 指令、时间格式化、入库检索、@判定、切分
```

## 安装

```sh
# 1) 建 profile（web 模板自带网页；想纯后台就用默认的 base-only）
dsh --profile yashiro --from-default-profile web     # 或 dsh plugin --profile yashiro add <本包>

# 2) 装本 bundle（会自动追加进 profile 的 dsh.profile.bundles）
dsh plugin --profile yashiro add /path/to/dsh-yashiro

# 3) 在 ~/.dsh/profiles/yashiro/cordis.patch.yml 里填凭据（见下）
# 4) 跑
dsh --profile yashiro
```

`~/.dsh/profiles/yashiro/cordis.patch.yml`：

```yaml
- id: yashiro
  config:
    appId: '你的 AppID'
    appSecret: '你的 AppSecret'
    sandbox: true        # 未上线的机器人用沙箱域名
    cwd: '/path/to/agent/workspace'
```

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 必填 | QQ 开放平台凭据 |
| `sandbox` | `false` | 指向 `sandbox.api.sgroup.qq.com` |
| `cwd` | 进程 cwd | agent 工作目录（决定会话落在哪个 workspace 分桶） |
| `allowedGroups` | `[]` | 群 openid 白名单。**空 = 一个群都不放行**，必须显式列 |
| `allowedUsers` | `[]` | 单聊 openid 白名单。**空 = 一个都不放行** |
| `blockedSenders` | `[]` | 发送者 openid 黑名单。只拦 @ 触发，**不影响消息入库** |
| `historyDbPath` | `$DSH_HOME/storages/dsh-yashiro/history.db` | 群历史库 |
| `historyDefaultLimit` / `historyMaxLimit` | `30` / `200` | 单次查询条数 |
| `sendChunkLimit` | `4500` | 单条消息最大字符数，超出自动切分 |
| `announceNewMessageCount` | `true` | @ 时附带「你不在时群里又聊了几条」 |
| `systemPrompt` | 内置 | 覆盖注入的系统提示词 |
| `debug` | `false` | 打开后写 DEBUG 级文件日志 |

## 访问控制

三条规则，都是 **fail closed**（默认什么都不放行）：

| 配置 | 作用范围 | 空数组的含义 |
|---|---|---|
| `allowedGroups` | 群聊（group_openid） | 一个群都不放行 |
| `allowedUsers` | 单聊（user openid） | 一个都不放行 |
| `blockedSenders` | 发送者（openid） | 没有黑名单 |

**不支持通配符。** 想开放就把 id 列全，意图必须写死 —— `'*'` 只是个普通字符串，匹配不到任何真实 id。

**黑名单只拦 @ 触发，不拦入库。** 黑名单里的人发言照样进历史库，只是不会唤醒 agent。
不按昵称匹配：昵称可改、可重名，当安全边界不可靠。

### `/id` 豁免指令

自举问题：不知道 group openid 就没法配白名单。所以有一个**绕过全部访问控制**的指令：

```
你：@机器人 /id
bot：群 ID（group_openid）：
     A22459EFEB65CFF0405CB716510F7C57

     你的 openid：
     04929CA16A512F57CFBCC3AD77A5D640

     昵称：Zhe_Learn
```

- **需要 @ 机器人**（避免群里有人随口打出 `/id` 就触发）
- **精确匹配**整条消息（去掉首尾空白后完全等于 `/id`），带参数不触发
- **群聊和单聊都支持**
- **绕过白名单和黑名单** —— 即使这个群还没加进 `allowedGroups` 也能用
- **不经过 dsh** —— 插件直接回复，不消耗模型调用
- 回复内容也会记入历史库

## 平台侧的坑（实测踩出来的）

1. **全量模式下 @ 消息也叫 `GROUP_MESSAGE_CREATE`**，不是 `GROUP_AT_MESSAGE_CREATE`。
   判断是否 @ 机器人必须看 `mentions[].is_you`，不能看事件名。
2. **`content` 里的 @ 标记不会被剥掉**，形如 `<@OPENID>`，得自己处理。
   本插件在 `stripMentionMarkers()` 里做了。
3. **intents 要带 `1<<24`**：官方文档说 `GROUP_MESSAGE_CREATE` 用 `1<<25` 就够，
   但社区实践和实测都需要额外带上 `GROUP_MESSAGE (1<<24)`。
4. **群主必须在群设置里给机器人开「接收所有消息」**，否则非 @ 消息根本不会推过来。
5. **`ctx.agents.create()` 不会自己查默认模型**。`dsh-agent-default-model` 的定位是
   「回答『新 agent 该用哪个模型』，由创建 agent 的入口来咨询」，必须显式把
   `agentDefaultModel.currentSelection()` 的结果作为 `agentOptions` 传进去，
   否则 agent 没有模型路由，回合压根跑不起来（表现为：会话建了但一句话不回）。

## 调试

```sh
pnpm selfcheck       # 27 项离线自检：入库/检索/去重/@判定/切分/引用
pnpm dump-session    # 打印本 workspace 最新一条会话的完整事件流
```

运行日志写在历史库同目录的 `plugin.log`（headless profile 下 `ctx.logger` 没有可见出口，
所以插件自己还写一份文件日志）。

> ⚠️ `session.v3.jsonl.zstd` 是**多个独立 zstd 帧拼接**的。`zstdDecompressSync`
> 一次性解压只拿得到第一帧，看起来像「只有一条 session 头事件」。必须按魔数
> `28 B5 2F FD` 切帧逐帧解 —— `scripts/dump-session.mjs` 就是这么做的。

## 已知限制 / 后续可做

- **没有斜杠命令**。要做的话，`SessionManager` 的 sessionKey 里再加一维（topic/epoch）
  就能天然支持「多会话切换」，不用改存储结构。
- **黑名单只有 openid 一种维度**，没有白名单模式。被放行的群里，除黑名单外的人都能
  驱动一个**带 bash 权限**的完整 agent。
- **审批无人应答**：headless profile 下 `approval/policy = ask` 但没有应答方，
  需要审批的操作会 fail closed。要放开得自己做 QQ 侧按钮通道。
- **插件不碰附件本体**。图片/语音/文件只把平台给的元信息（URL、类型、尺寸、语音转写）
  交给 agent，插件不下载、不持久化 —— 由 agent 自己决定何时 `curl` 下来再 `read_image`。
  QQ 的附件 URL 带时效，过期即放弃。
- **历史检索用 LIKE 而非 FTS5**：FTS5 默认分词器对中文基本没用。

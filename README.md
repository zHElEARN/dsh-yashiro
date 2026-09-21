# dsh-yashiro

把 QQ 群机器人接到 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 上的通道插件（dsh bundle）。

**QQ 只是感官和发声器官，dsh agent 才是主体。**

## 架构

```
QQ 群消息 ──▶ 归一化 ──▶ 历史库（全部入库）
                            │
                            ├─ 没 @ 机器人 ──▶ 到此为止（不进上下文）
                            │
                            ├─ 会话指令（/current /new /switch /list）──▶ 插件直接回复
                            │
                            └─ @ 了机器人 ──▶ 投递到「当前会话」的 agent 回合
                                                    │
                    ┌───────────────────────────────┘
                    ▼
              dsh agent 跑一个完整回合（思考、调工具、可以调 bash…）
                    │
                    ├─▶ qqbot_history   自己查群里之前聊了什么
                    └─▶ qqbot_send      唯一的发声通道 ──▶ QQ 群
```

## 设计取舍

| 决定 | 原因 |
|---|---|
| **插件不接管 agent 的输出** | 回复完全由 agent 调 `qqbot_send` 完成。思考过程、工具调用一律不同步到 QQ |
| **非 @ 消息只入库、不进上下文** | agent 不背整个群的流水账；需要时自己查 |
| **一律主动发送**（不绑 msg_id） | 不受被动回复 5 分钟 / 5 次的时效约束 |
| **一个 QQ 会话下可以有多条 dsh 会话，其中一条是「当前」** | 群成员要开新话题时不必丢掉旧上下文；当前指针落在历史库里，重启后还在 |
| **无会话时不自动创建，@ 只提示 `/new`** | 免得一个 @ 就悄悄开出一条空会话；建会话必须是一次明确的操作 |
| **会话指令限审批名单（`approvers`）** | 群一旦放行，任何人都能驱动一个带 bash 权限的 agent；再让任何人能换会话，等于谁都能把它变成自己的 |
| **附件的所有信息都带给 agent，但插件不下载、不持久化** | 既然 agent 已经独立自主，附图怎么看由它自己决定 |
| **不做上下文压缩** | 上下文满了怎么办还没想清楚；要清空就 `/new` |
| **新 @ 默认插队（`busyDelivery: steer`）** | 群里连发两条时第二条不该干等；插队在下一个 step 边界注入，回复能带上新消息。想要旧行为配 `queue` |

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
pnpm test    # 135 项：@标记剥离/事件归一化/附件传递/访问控制/时间格式化/入库检索/审批卡片/切分/配置/会话指令/会话绑定/上下文折叠
```

测试按模块拆在 `test/` 下，与 `src/` 同构，用 Node 内置的 `node:test`（无额外依赖）。
`pnpm test` 会先 typecheck、再 build，最后跑 `dist/` 上的用例 —— 所以它同时能抓到
「改了 src 忘了重新构建」这类问题。

## 调试

```sh
pnpm dump-session    # 打印本 workspace 最新一条会话的完整事件流
```

运行日志写在历史库同目录的 `plugin.log`（headless profile 下 `ctx.logger` 没有可见出口，
所以插件自己还写一份文件日志）。

> ⚠️ `session.v3.jsonl.zstd` 是**多个独立 zstd 帧拼接**的。`zstdDecompressSync`
> 一次性解压只拿得到第一帧，看起来像「只有一条 session 头事件」。必须按魔数
> `28 B5 2F FD` 切帧逐帧解 —— `scripts/dump-session.mjs` 就是这么做的。

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
| `historyDbPath` | `$DSH_HOME/storages/dsh-yashiro/history.db` | 群历史库。留空即用默认路径 |
| `announceNewMessageCount` | `true` | @ 时附带「自你上次开口以来群里还有几条新消息」 |
| `busyDelivery` | `'steer'` | 它正在跑回合时新 @ 进来的消息：`steer` 插队（下个 step 就被看到）／`queue` 排队（等下一个回合） |
| `approvers` | `[]` | 谁能点审批卡片的「允许一次」（openid 白名单）。**空 = 群里任何人都能点**（与腾讯官方插件一致） |
| `approvalTimeoutSeconds` | `300` | 审批卡片无人处理多久后按「拒绝」收场 |
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
bot：Group OpenID: A22459EFEB65CFF0405CB716510F7C57
     User OpenID: 04929CA16A512F57CFBCC3AD77A5D640
     Nick Name: Zhe_Learn
```

回复只报这三个值、不带任何说明（说多了干扰复制）：群 ID 填 `allowedGroups`，
单聊里对方的 openid 填 `allowedUsers`。单聊没有群，第一行给的就是这条会话的 id。
昵称拿不到时 `Nick Name` 那行留空。

- **需要 @ 机器人**（避免群里有人随口打出 `/id` 就触发）
- **精确匹配**整条消息（去掉首尾空白后完全等于 `/id`），带参数不触发
- **群聊和单聊都支持**
- **绕过白名单和黑名单** —— 即使这个群还没加进 `allowedGroups` 也能用
- **不经过 dsh** —— 插件直接回复，不消耗模型调用
- 回复内容也会记入历史库

## 会话（多会话切换）

一个群/单聊下可以有多条 dsh 会话，任意时刻只有一条是**当前会话**，@ 消息投递到它上面。
指针落在历史库里（`session_bindings` 表），重启后依然有效。

**默认没有会话**：装完第一次 @ 不会自动建，只会收到一句提示；要先 `/new`。

### 指令

五条指令都要求 **@ 机器人**，且**限 `approvers` 名单**（不在名单里的人会收到一句拒绝；
名单为空则谁都不能用）。它们都由插件直接回复，不进 dsh、不消耗模型调用。

| 指令 | 作用 |
|---|---|
| `/current` | 看当前会话的 ID 和创建时间 |
| `/new` | 新建一条会话并切过去。会话立刻落盘，`/list` 里马上能看到 |
| `/switch <ID>` | 切到已有会话。接受 8 位短 ID 或完整 ID，**前缀唯一才切**，重名会让你多打几位 |
| `/list [页数]` | 列出这个群的会话，每页 10 条，按最近使用排序，当前那条标 `▶` |
| `/context` | 看当前会话的上下文情况：模型、上下文占用、累计用量、历史规模、最后活动 |

```
你：@机器人 /new
bot：已创建并切换：
     Session ID: 3f9a2b7c
     创建：2026-09-20 21:10

你：@机器人 /list
bot：会话列表（第 1/1 页，共 2 条，按最近使用排序）
     ▶ 3f9a2b7c  2026-09-20 21:10  ← 当前
       acf33922  2026-09-20 20:41

你：@机器人 /context
bot：会话上下文
     Session ID: 3f9a2b7c
     创建：2026-09-20 21:10
     模型：deepseek-official/deepseek-flash
     上下文：334.7k / 1m（33%）
     累计用量：335.5k（缓存命中 334.5k，99%）
     历史：11 轮 · 339 步 · 15 条你的消息 · 426 次工具调用
     最后活动：2026-09-21 00:24（正在跑回合）
```

`/context` 的数据全部来自会话日志，不调模型：

- **上下文占用**取**最近一次请求**的 `inputTokens + cacheReadTokens`（含缓存命中部分），
  这才是"上下文现在有多大"。**不要**用 `usage.totalTokens` —— 它是跨请求累计值，
  多轮之后会远大于窗口，看起来像超额了
- 还没跑过回合的会话（`/new` 之后）显示「模型：未知（还没跑过回合）」「上下文：还没跑过回合」，
  不编数字
- 缓存命中率不足 100% 时不会四舍五入成 100%

### 会话与群的对应关系

- **按群/单聊共享**：会话列表和当前指针属于这个群，所有群成员看到同一个 ——
  群成员是同一个 agent 的多个对话者，上下文是共享的
- **会话标题 = 8 位短 ID**：`/new` 和 `/switch` 时都会用短 ID 给会话命名，这样它在
  **web 侧边栏**里认得出是哪条（不设的话标题会退回工作目录名，所有会话长得一样）。
  标题带 `user` 来源标记，这个标记会禁掉「首条消息自动起标题」——否则我们设的名字
  会在 agent 第一次回话时被顶掉
- **SessionId 派生**：`yashiro:${appId}:${scope}:${peerId}:${epoch}` 做 SHA-256。
  `epoch` 是该群内的自增序号（`/new` 一次加一），所以同一个 epoch 永远对应同一条会话，
  重启后能 resume 回来
- **切换不打断正在跑的回合**：切走时旧会话里跑着的回合会跑完，它的回复仍会发到这个群
- **历史检索不按会话隔离**：`qqbot_history` 查的是整个群的消息，与会话无关

## 审批（工作区外的操作）

agent 在会话工作区之外动手时，dsh 的沙箱会先拒绝；模型随后按工具说明用
`sandbox_permissions` + `justification` **重试一次**，这一次会走审批 —— 插件把它渲染成
群里的一张卡片（工具名 + 被拦的命令 + 理由），带两个按钮：

- **✅ 允许一次**：只有这一次放行（dsh 的审批 outcome 是闭合集合，没有 allow-always）
- **❌ 拒绝**：这次调用被拒，模型收到 `the user rejected tool "…"`

规则：

- 按钮点击以 `INTERACTION_CREATE` 从 WebSocket 推回来，**不需要回调服务器**，也不必额外开通 intent。
- `approvers` 为空 = **群里任何人都能点**（和腾讯官方插件一致）；填了就同时把按钮在平台侧
  限给名单内的人（`permission.type=0` + `specify_user_ids`），点击回来还会再校验一次。
- `approvalTimeoutSeconds`（默认 300）内没人点 → 按**拒绝**收场，并给群里补一条提示。
- 卡片发不出去、那一轮被取消、插件卸载 → 一律 fail closed（`unavailable` / `cancelled`）。
- 接法参考腾讯官方插件 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)
  的 `src/features/approval-channel.ts`（同一套 `approval/request` seam、同样的两按钮卡片）。

## 平台侧的坑（实测踩出来的）

1. **全量模式下 @ 消息也叫 `GROUP_MESSAGE_CREATE`**，不是 `GROUP_AT_MESSAGE_CREATE`。
   判断是否 @ 机器人必须看 `mentions[].is_you`，不能看事件名。
2. **`content` 里的 @ 标记不会被剥掉**，形如 `<@OPENID>`，得自己处理。
   本插件在 `stripMentionMarkers()` 里做了。
3. **intents 要带 `1<<24`**：官方文档说 `GROUP_MESSAGE_CREATE` 用 `1<<25` 就够，
   但收非 @ 消息必须额外带上 `GROUP_MESSAGE (1<<24)`。
4. **群主必须在群设置里给机器人开「接收所有消息」**，否则非 @ 消息根本不会推过来。
5. **`ctx.agents.create()` 不会自己查默认模型**。`dsh-agent-default-model` 的定位是
   「回答『新 agent 该用哪个模型』，由创建 agent 的入口来咨询」，必须显式把
   `agentDefaultModel.currentSelection()` 的结果作为 `agentOptions` 传进去，
   否则 agent 没有模型路由，回合压根跑不起来（表现为：会话建了但一句话不回）。

## 已知限制 / 后续可做

- **没有上下文压缩**。上下文满了只能 `/new` 换一条；也没想好压缩后旧历史怎么留。
- **黑名单是纯黑名单**，没有「白名单模式」开关（要限制发送者就填 `blockedSenders`，要放行
  会话就填 `allowedGroups`/`allowedUsers`）。被放行的群里，除黑名单外的人都能
  驱动一个**带 bash 权限**的完整 agent。
- **审批只有「允许一次 / 拒绝」**，没有 allow-always（dsh 的审批 outcome 是闭合集合，
  只有 `allowed-once` 是放行）；卡片超时（默认 5 分钟）按拒绝处理。
- **插件不碰附件本体**。图片/语音/文件只把平台给的元信息（URL、类型、尺寸、语音转写）
  交给 agent，插件不下载、不持久化 —— 由 agent 自己决定何时 `curl` 下来再 `read_image`。
  QQ 的附件 URL 带时效，过期即放弃。
- **历史检索用 LIKE 而非 FTS5**：FTS5 默认分词器对中文基本没用。
- **会话没有名字、也没有上限**：`/list` 只能靠时间和短 ID 区分，`/new` 可以无限建，
  旧会话一直留在磁盘上（要清理得手动删 `~/.dsh/sessions/<分桶>/<sessionId>/`）。
- **切走之后回复不带会话标记**：旧会话里跑着的回合仍会把回复发到这个群，
  看到时无法从消息本身判断它属于哪条会话。
- **会话列表有内存缓存**：`/switch` 过的 agent 会一直留在内存里直到插件卸载，
  没有按最近最少使用淘汰。会话数量正常使用时无感，建上几百条才需要在意。

## 代码约定

### 注释：只留「删掉就会被改错」的那些

判定标准只有一条 —— **把这条注释删掉，一个有经验的读者会不会误改这段代码？**
会，就留；不会，就删。明确要留的只有五类：

1. 非显然的坑：平台行为、外部 API 契约陷阱（如 `GROUP_MESSAGE` 的 intent 位要怎么拼）
2. 设计约束的原因：为什么 fail closed、为什么回复必须走 `qqbot_send`
3. 不明显的行为契约：如附件靠 `from` 区分「当前消息的」和「被引用消息的」
4. 公开 API 的签名说明（一行以内）
5. TODO / FIXME

**一律不留**：把代码翻译一遍的注释（`// 按条件检索`、`// 6) 去重`）、步骤编号、
「我这里做了什么」的旁白、写完即失效的历史事故经过（事故留在 commit message 里，
代码里只留面向未来的约束）。

### 文件头

一到三行：一句话说这个文件负责什么 + 只有这个文件知道的坑。
**架构图、设计取舍表只写在 README**，代码里不再复述 —— 两处都写必然会漂移。

### 目录职责

| 目录 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：接线、消息主流程、生命周期 |
| `src/qq/` | QQ 平台侧：网关、审批通道、访问控制、会话指令、正文拼装 |
| `src/agent/` | dsh agent 侧：会话管理、日志折叠（`/context`）、工具、系统提示词 |
| `src/core/` | 基础件：配置、时间、错误格式化 |
| `src/store.ts` | 历史库（唯一的持久化模块） |
| `test/` | 与 `src/` 同构，`*.test.mjs` 直接跑 `dist/` |
| `scripts/` | 排查工具，不是测试 |

**不要重复同一份知识。** sessionKey 的格式、出站消息怎么落库这类事实，全仓库只能有
一处定义（现在分别是 `sessionKeyOf()` 和 `store.appendOutbound()`）；第二处出现就该抽出来。

改动之后跑 `pnpm test` —— 它会 typecheck + build + 跑全部用例。

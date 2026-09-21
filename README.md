# dsh-yashiro

把 QQ 群机器人接到 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 上的通道插件（dsh bundle）。

**QQ 只是感官和发声器官，dsh agent 才是主体。**

群消息全部入库；只有 @ 了机器人的消息会唤醒 agent 跑一个完整回合——它可以自己思考、调工具、执行 bash，回复由它调 `qqbot_send` 发出，思考过程不同步到群里。没 @ 的消息不进上下文，agent 需要时用 `qqbot_history` 自己查。一个群可以有多条会话，@ 只投递到其中的「当前会话」。

## 安装

```sh
pnpm install
pnpm build

dsh plugin --profile yashiro add /path/to/dsh-yashiro
dsh --profile yashiro
```

`~/.dsh/profiles/yashiro/cordis.patch.yml`：

```yaml
- id: yashiro
  config:
    appId: "你的 AppID"
    appSecret: "你的 AppSecret"
    sandbox: true # 未上线的机器人用沙箱域名
    cwd: "/path/to/agent/workspace"
```

## 配置项

| 配置                      | 默认                                        | 说明                                                                                            |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `appId` / `appSecret`     | 必填                                        | QQ 开放平台凭据                                                                                 |
| `sandbox`                 | `false`                                     | 指向 `sandbox.api.sgroup.qq.com`                                                                |
| `cwd`                     | 进程 cwd                                    | agent 工作目录（决定会话落在哪个 workspace 分桶）                                               |
| `allowedGroups`           | `[]`                                        | 群 openid 白名单。**空 = 一个群都不放行**，必须显式列                                           |
| `allowedUsers`            | `[]`                                        | 单聊 openid 白名单。**空 = 一个都不放行**                                                       |
| `blockedSenders`          | `[]`                                        | 发送者 openid 黑名单。只拦 @ 触发，**不影响消息入库**                                           |
| `historyDbPath`           | `$DSH_HOME/storages/dsh-yashiro/history.db` | 群历史库。留空即用默认路径                                                                      |
| `announceNewMessageCount` | `true`                                      | @ 时附带「自你上次开口以来群里还有几条新消息」                                                  |
| `busyDelivery`            | `'steer'`                                   | 它正在跑回合时新 @ 进来的消息：`steer` 插队（下个 step 就被看到）／`queue` 排队（等下一个回合） |
| `approvers`               | `[]`                                        | 谁能点审批卡片的「允许一次」（openid 白名单）。**空 = 群里任何人都能点**（与腾讯官方插件一致）  |
| `approvalTimeoutSeconds`  | `300`                                       | 审批卡片无人处理多久后按「拒绝」收场                                                            |
| `debug`                   | `false`                                     | 打开后写 DEBUG 级文件日志                                                                       |

## 会话与指令

一个群/单聊下可以有多条 dsh 会话，任意时刻只有一条是**当前会话**，@ 消息投递到它上面；指针落在历史库里，重启后依然有效。

**默认没有会话**：装完第一次 @ 不会自动建，只会收到一句提示；要先 `/new`。

### 指令

指令都要求 **@ 机器人**，都由插件直接回复 —— 不进 dsh、不消耗模型调用；其中会话相关的五条限 `approvers` 名单（不在名单里的人会收到一句拒绝，名单为空则谁都不能用），`/id` 不受任何限制。

| 指令           | 作用                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `/current`     | 看当前会话的 ID 和创建时间                                                   |
| `/new`         | 新建一条会话并切过去。会话立刻落盘，`/list` 里马上能看到                     |
| `/switch <ID>` | 切到已有会话。接受 8 位短 ID 或完整 ID，**前缀唯一才切**，重名会让你多打几位 |
| `/list [页数]` | 列出这个群的会话，每页 10 条，按最近使用排序，当前那条标 `▶`                 |
| `/context`     | 看当前会话的上下文情况：模型、上下文占用、累计用量、历史规模、最后活动       |
| `/id`          | 查这条会话的 Group OpenID / User OpenID / 昵称，用来配白名单                 |

### 群里的会话行为

- **按群/单聊共享**：会话列表和当前指针属于这个群，所有群成员看到同一个 —— 群成员是同一个 agent 的多个对话者，上下文是共享的
- **切换不打断正在跑的回合**：切走时旧会话里跑着的回合会跑完，它的回复仍会发到这个群
- **历史检索不按会话隔离**：`qqbot_history` 查的是整个群的消息，与会话无关

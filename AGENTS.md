# AGENTS.md

本仓库：dsh-yashiro（Node/TypeScript 编写的 dsh bundle 插件，把 QQ 群机器人接到 DeepSeek Harness 上）。

QQ 只是感官和发声器官，dsh agent 才是主体。

## 修改前需求确认

- 对本仓库中的任何文件进行修改前，必须读取并遵循 `grilling` skill。
- 执行 `grilling` skill 时必须使用提问工具；如果提问工具不可用，则改用普通文本。
- 在 `grilling` skill 要求的最终确认环节，必须先完整汇总共识，再单独询问用户是否确认。
- 仅当用户在当次请求中明确要求“立即执行并忽略 grilling”时，才可以跳过上述流程。该豁免仅对当次请求有效。

## 验收

- 改动源码或测试后必须跑验收，编译是验收的一部分，不是可选项。
- 验收只跑 `pnpm test`。它一条命令跑完 lint、typecheck、编译和全部用例。
- 不得用 `pnpm test:only`、单独 `tsc` 或手写 `node --test` 替代 `pnpm test`。
- lint 是硬门禁：报 error 即验收失败，必须修；warning 只提示，不拦验收。
- 确需例外时在那一行用带理由的 `// biome-ignore lint/<规则名>: 理由` 豁免，不降级整条规则。

# Agent Runtime Lite

[![跨平台测试](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml/badge.svg)](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml)

[5 分钟入门](docs/QUICKSTART.md) · [真实接入示例](docs/INTEGRATION.md) · [排障与诊断](docs/TROUBLESHOOTING.md) · [英文说明](README.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [维护计划](docs/MAINTENANCE.md) · [外部试用与反馈](docs/LAUNCH.md) · [npm 预览版发布流程](docs/NPM_PUBLISHING.md) · [更新记录](CHANGELOG.md)

**Agent 的 CLI 会话结束了，任务真的完成了吗？**

Agent Runtime Lite 让任务状态能被后续独立 CLI 进程接手：启动真实后台子进程、保留任务记录，命令退出成功后先进入待验收状态，从 v0.2 起，新任务默认必须提交调用方验收证据才能完成：没有自定义 gate 时自动加入 `caller_attestation`；已经指定实际验收 gate 时直接使用该 gate，不要求重复确认。它是零第三方 npm 依赖的**单机任务运行框架**，不是模型服务或分布式任务队列，也不会自动证明第三方业务结果。

**注意能力边界：** `caller_attestation` 的证据是调用方声明，并不代表本库能自行核实第三方系统。仅按退出码判断的任务必须显式选择 `completionMode: 'exit_only'`（CLI：`--completion-mode exit_only`），完成时标记为 `process_exit_only`。已经落盘的 v0.1.x 任务保留旧验收规则。请看 [v0.2 升级指南](docs/MIGRATION_V02.md)。

## 不克隆源码，直接安装体验

新建一个空文件夹，使用 Node.js 20+ 与 npm：

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.2.0-beta.2/agent-runtime-lite-0.2.0-beta.2.tgz
npm exec -- arl --version
npm exec -- arl demo
```

这是已验证的 **GitHub Release 安装包**，不是 npm 官方包仓库中的安装。 `arl demo` 会启动真实后台子进程，另一个 CLI 进程读取并核对生成的文件；没有验收证据时会拒绝完成，通过检查后才完成任务。演示成功后会清理自己的临时目录。

### 一分钟看懂完整接力（需要克隆源码）

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm run demo:handoff
```

示例会启动真实后台子进程，让第一次 CLI 调用先退出，由后续独立进程读取状态；未验收不能完成，检查真实日志后才能通过验收。它展示的是**调用方跨进程接力**，不代表任意异常退出的 Worker 都能自动恢复。

预期末尾输出：

```text
Final task state: completed
Worker attempts: 1
The original CLI process did not need to remain open.
```

**真实文件示例：** 执行 `node examples/report-file-handoff.mjs`，后台进程会生成 `report.json`，后续独立 CLI 进程读回文件并校验汇总值，通过后才允许完成任务。只需要 Node.js 20+，不依赖 npm Registry 服务。

**已发布的最新版：v0.2.0-beta.2；源码开发候选版：v0.2.0-beta.3（尚未发布）。MIT 许可证，面向单机任务运行场景。**

欢迎在 [第一批试用者反馈帖](https://github.com/Sharky0209/agent-runtime-lite/issues/3) 反馈真实体验，无需给仓库刷 Star。

## 核心功能

- **持久任务**：按业务键接收任务，重复请求只返回原任务。
- **后台 Job**：可从 CLI 启动独立 Node worker，真实执行外部子进程并记录结果。
- **跨进程恢复**：新的 CLI 进程可以重新读取任务、Job、执行尝试与进度。
- **完成验收**：进程退出码为 0 只能进入待验收状态；声明的检查项有明确证据后才能完成。
- **外部副作用登记**：先记录操作，再执行外部动作；超时或结果不明确时必须核对真实目标，不能自动重复。操作一经确认或中止，重复提交相同结算结果会保留首次证据及时间，不允许悄悄覆盖。
- **资源互斥**：两个 Job 不会并发使用同一声明的资源。
- **任务依赖（未发布功能）**：后续 Job 可通过 `dependsOn: ['前置Job的key']` 等待同一 Task 中已登记的前置 Job 完成；`plan` 查看等待原因，`run-ready` 显式启动当前可运行的 Job。
- **可控重试**：默认人工核对后续跑，明确只读的任务可以选择安全自动恢复。

## 一条命令运行多步骤工作流（源码新功能）

用户不必逐条复制 Task/Job ID。仓库提供 [示例工作流](examples/verified-workflow.json)。正式运行前可先完整预检，**不会登记任务、写入状态或启动子进程**：

```sh
node bin/arl.mjs flow-check --root ./trial-workspace --flow-file ./examples/verified-workflow.json
```

预检使用与实际提交一致的校验规则，包括每一步的参数与已有 Job 的不可变配置冲突；输出哪些任务将新建、哪些会复用。正式运行：

```sh
node bin/arl.mjs flow --root ./trial-workspace --flow-file ./examples/verified-workflow.json --wait-ms 10000
```

该命令按 JSON 清单登记两步任务，实际启动进程、验收本地 JSON 内容，前一步确认完成后启动下一步。重复执行相同清单时，会复用原有任务和 Job，不重复执行已经完成的步骤。也可运行 `arl drive --root ./trial-workspace --task TASK_ID` 接着推进已有任务。程序会返回启动、验收、待人工处理及最终状态；一次调用最多等待 30 秒，超时不意味着子进程被停止，可后续再次运行。

**自动推进仅适用于没有额外人工 gate 的本地文件验收任务。** 人工审核、外部操作未确认、文件内容不符、以及仅按退出码判定的步骤都不能被自动视为已验收。不提供常驻守护进程，不自动重试失败任务；`--root` 中的任务记录和产物会保留。该功能尚未包含于已发布的 beta.2 安装包。

## 子进程上下文与本轮产物校验（源码新增，未发布）

Runtime 启动的子进程现在自动获得 `ARL_ROOT`、`ARL_TASK_ID`、`ARL_JOB_ID`、`ARL_ATTEMPT_ID` 四个环境变量。业务脚本无需手动拷贝 Job ID，即可在执行外部操作前登记 `beginOperation()`，核对真实接收端后再调用 `settleOperation()`。

`fileCheck` 可以增加 `fresh: true`，拒绝仅仅内容吻合、却没有在当前 attempt 开始后更新的旧报告，错误为 `FILE_CHECK_STALE`。该选项默认关闭以兼容已有任务。文件修改时间不能证明是哪一个进程写入，也不能替代微信或远程系统的接收端核验。

```sh
npm run demo:integration
```

该可运行示例启动真实子进程，用**本地模拟接收端**完成操作登记、回执读回和本轮报告校验，不发送真实网络消息，也不需要账号凭据。实现方式及边界见[接入指南](docs/INTEGRATION.md)。以上均未包含于 beta.2 已发布安装包。

## 多步骤工作流（开发中，尚未包含在 beta.2 安装包）

先提交上游 Job，再提交下游 Job，例如 `runtime.submit({taskId, key: 'review', command, dependsOn: ['produce']})`。必须是**同一 Task 内已经登记的 Job key**，不能前向引用，不允许循环依赖。随后调用 `runtime.runReady({taskId})`，仅启动依赖已经 `completed` 且资源空闲的排队 Job。上游成功退出但仍处于 `completion_candidate` 时，下游不能启动；真实结果读回后由调用方通过 gate 并 `complete()`，再次调用 `runReady` 才进入下一步。

CLI：`arl plan --root ./state --task TASK_ID` 只读查看可运行与等待项，并返回 `nextAction` 指示下一步（如 `verify-file`、`reconcile-operation`、`review-and-gate` 或 `run-ready`）；`arl run-ready --root ./state --task TASK_ID` 执行一次调度，**都必须指定 Task ID**。这不是常驻调度器或自动结果验证；前置任务若使用 `exit_only`，其 `completed` 仍只表示退出码成功。详细说明见[英文 README](README.md)。

## 运行时实际读取本地文件（开发中，未包含在 beta.2 安装包）

对于会生成 JSON 报告的任务，可以在 `submit` 中设置 `fileCheck: {path: 'report.json', jsonFields: {status: 'ready', count: 3}, fresh: true}`。运行时会在指定工作区目录中实际打开文件、解析 JSON、逐项检查字段，而不是接受“我已经检查过”的文字声明。

进程退出后必须处于 `completion_candidate`，再运行 `runtime.verifyFile({jobId})` 或 CLI `arl verify-file --root ./state --job JOB_ID`。验收成功才通过 `local_file_check` 门禁，`complete()` 还会在写入完成状态前重新检查文件，避免中途改坏仍被当作成功。缺文件、JSON 无效、字段值不符都会拒绝；其他未列举的 JSON 字段允许存在。该路径以运行时的 `--root` 为基准。

只用文件检查时，`completionBasis=local_file_checked`，无需重复要求 `caller_attestation`；如还配置了其他人工 gate，则必须全部通过，结果标记为 `local_file_checked_plus_caller_attested`。不能把文件门禁改用人工文字通过，也不能搭配 `exit_only`。`fresh: true` 还能要求文件修改时间不早于当前执行轮次开始，减少历史报告误用；不传此选项则仍只检查内容。**即使通过本轮修改时间校验，也不能独立证明文件由本次任务实际写入，更不能据此声称微信、云端或业务系统已收到结果。** 该功能目前只在源码主线开发中，不属于已公开的 beta.2 安装包。

## 默认验收与可选退出码模式

- **默认 `attested`**：需要内置进程退出检查和至少一项调用方证据。没有自定义 gate 时要求 `caller_attestation`；指定了自定义 gate 时需全部通过，不重复增加确认。
- **显式 `exit_only`**：只依赖退出码；不能声明其他自定义 gate，结果仅表示进程成功退出。
- **迁移注意**：旧任务不自动添加新 gate；相同幂等 Key 如果与新模式冲突，会拒绝新提交，而不是悄悄复用旧语义。

## 安全诊断

`arl doctor --root ./my-workspace`（或在源码目录执行 `node bin/arl.mjs doctor --root ./my-workspace`）只读取工作区状态，汇总任务、资源占用、待核对操作与疑似异常 Worker 数量，不会启动任务或修改记录；输出不包含任务标题、命令参数、绝对路径、客户数据或验收证据。完整的 `arl status` 可能包含敏感参数和证据，不建议直接贴到公开 Issue。参见[排障指南](docs/TROUBLESHOOTING.md)。

## 运行

需要 Node.js 20 及以上。进入项目目录：

```sh
npm test
npm run example
npm run demo:handoff
npm run test:package
```

`demo:handoff` 展示原 CLI 会话结束、后续 CLI 读取状态以及核对真实输出后才允许完成任务；它不宣称能自动恢复任意崩溃的 Worker。`test:package` 会将本地 npm 压缩包安装到独立临时目录，验证安装后 CLI 与真实执行链路。**尚未发布到 npm 公共仓库。**

运行示例后应输出两行：

```text
Final task state: completed
Final job state: completed
```

新用户建议先看 [5 分钟入门指南](docs/QUICKSTART.md)，其中 PowerShell 和 Bash 版本会在 CI 实际执行。CLI 入口为 `node bin/arl.mjs`，支持 `accept`、`submit`、`start`、`status`、`checkpoint`、`op-begin`、`op-confirm`、`op-abort`、`gate`、`complete`、`retry`、`recover` 等命令。详细参数及 JavaScript API 见 [英文 README](README.md)。

运行状态默认写入指定工作目录的 `.arl/`，自动化测试只使用独立临时目录。

## Chat 模式停滞检测与安全续接（源码新增，尚未发布）

新增 `ChatContinuationGuard`，可给**已确认会话与轮次**记录实际输出进展、检测长时间无进展、在独立读回确认原轮次已失败／超时／中断后，按预设文本接续一次。**长时间思考但仍处于 active 状态不会触发发送**；轮询本身也不算进展。

通过 `arl chat-watch --task TASK_ID --conversation CID --turn TURN --message-file continue.txt` 建立监测，`chat-observe --sequence 1 --state active --progress-key STREAM_ID` 记录实际进展，`chat-plan` 查看只读判定。所有命令须指定 `--root`。实际发送只能由开发者在自有程序中导入 `ChatContinuationGuard`，并提供已授权的 `readTurn`／`sendContinuation`／`readDelivery` 适配器；普通 CLI **不会自行发送 ChatGPT 消息**。

发送必须同时满足：精确的 conversation/turn/head 身份已核验；服务端明确显示该轮为终止失败；适配器确实支持**发送时原子核对当前 head**与**跨重启持久幂等**。不支持这些保证时，默认拒绝自动发送。先持久化操作预留再发送，超时或断线时不盲目重发，回执仍需独立查证；默认每任务至多两次接续，单个中断轮次仅一次。**目前只完成模拟适配器的自动续接测试；尚未对真实 ChatGPT Chat 模式完成端到端自动发送验收。** 详细约束见 [英文 README](README.md#safe-chat-mode-continuation-guard-new-unreleased)。

## 适用范围

当前是**单机本地框架**，适合给自建 Agent、任务型 CLI、个人自动化工具增加可续接任务状态。它不是分布式消息队列，不包含浏览器自动化、模型服务，也不能自动判断第三方业务是否真的完成。

项目仅包含通用的本地任务运行、执行恢复与验收机制。架构和能力边界参见 [架构说明](docs/ARCHITECTURE.md)。

# Agent Runtime Lite

[![跨平台测试](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml/badge.svg)](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml)

[5 分钟入门](docs/QUICKSTART.md) · [排障与诊断](docs/TROUBLESHOOTING.md) · [英文说明](README.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [维护计划](docs/MAINTENANCE.md) · [更新记录](CHANGELOG.md)

**Agent 的 CLI 会话结束了，任务真的完成了吗？**

Agent Runtime Lite 让任务状态能被后续独立 CLI 进程接手：启动真实后台子进程、保留任务记录，命令退出成功后先进入待验收状态，核实输出并提交验收证据后才完成任务。它是零第三方 npm 依赖的**单机任务运行框架**，不是模型服务或分布式任务队列，也不会自动证明第三方业务结果。

### 一分钟看懂实际效果

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

**版本：v0.1.4，MIT 许可证，面向单机任务运行场景。**

## 不克隆源码，直接安装体验

新建一个空文件夹，使用 Node.js 20+ 与 npm：

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.1.4/agent-runtime-lite-0.1.4.tgz
npm exec -- arl --version
npm exec -- arl --help
```

这是已验证的 **GitHub Release 安装包**，并非已经发布到 npm 官方包仓库。想查看完整运行、独立进程接力和验收证明，请看 [5 分钟入门](docs/QUICKSTART.md)。欢迎在 [第一批试用者反馈帖](https://github.com/Sharky0209/agent-runtime-lite/issues/3) 反馈真实体验，无需给仓库刷 Star。

## 核心功能

- **持久任务**：按业务键接收任务，重复请求只返回原任务。
- **后台 Job**：可从 CLI 启动独立 Node worker，真实执行外部子进程并记录结果。
- **跨进程恢复**：新的 CLI 进程可以重新读取任务、Job、执行尝试与进度。
- **完成验收**：进程退出码为 0 只能进入待验收状态；声明的检查项有明确证据后才能完成。
- **外部副作用登记**：先记录操作，再执行外部动作；超时或结果不明确时必须核对真实目标，不能自动重复。
- **资源互斥**：两个 Job 不会并发使用同一声明的资源。
- **可控重试**：默认人工核对后续跑，明确只读的任务可以选择安全自动恢复。

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

## 适用范围

当前是**单机本地框架**，适合给自建 Agent、任务型 CLI、个人自动化工具增加可续接任务状态。它不是分布式消息队列，不包含浏览器自动化、模型服务，也不能自动判断第三方业务是否真的完成。

项目仅包含通用的本地任务运行、执行恢复与验收机制。架构和能力边界参见 [架构说明](docs/ARCHITECTURE.md)。

# Agent Runtime Lite

一个可本地运行、零第三方 npm 依赖的 **Agent 持久任务运行框架**。目标是让 AI Agent 的工作不会随着一次对话或 CLI 调用结束而失去状态，并把“命令执行成功”和“业务真正完成”分开。

**版本：v0.1.0，MIT 许可证，面向单机任务运行场景。**

## 核心功能

- **持久任务**：按业务键接收任务，重复请求只返回原任务。
- **后台 Job**：可从 CLI 启动独立 Node worker，真实执行外部子进程并记录结果。
- **跨进程恢复**：新的 CLI 进程可以重新读取任务、Job、执行尝试与进度。
- **完成验收**：进程退出码为 0 只能进入待验收状态；声明的检查项有明确证据后才能完成。
- **外部副作用登记**：先记录操作，再执行外部动作；超时或结果不明确时必须核对真实目标，不能自动重复。
- **资源互斥**：两个 Job 不会并发使用同一声明的资源。
- **可控重试**：默认人工核对后续跑，明确只读的任务可以选择安全自动恢复。

## 运行

需要 Node.js 20 及以上。进入项目目录：

```sh
npm test
npm run example
```

运行示例后应输出两行：

```text
Final task state: completed
Final job state: completed
```

CLI 入口为 `node bin/arl.mjs`，支持 `accept`、`submit`、`start`、`status`、`checkpoint`、`op-begin`、`op-confirm`、`op-abort`、`gate`、`complete`、`retry`、`recover` 等命令。详细参数及 JavaScript API 见 [英文 README](README.md)。

运行状态默认写入指定工作目录的 `.arl/`，自动化测试只使用独立临时目录。

## 适用范围

当前是**单机本地框架**，适合给自建 Agent、任务型 CLI、个人自动化工具增加可续接任务状态。它不是分布式消息队列，不包含浏览器自动化、模型服务，也不能自动判断第三方业务是否真的完成。

项目仅包含通用的本地任务运行、执行恢复与验收机制。架构和能力边界参见 [架构说明](docs/ARCHITECTURE.md)。

# First-user launch kit (v0.1.4)

This is copy for outreach, not evidence that any third-party adoption or community posting happened. Update the install line to `npm install agent-runtime-lite` only after a live registry readback and a clean consumer installation confirm the npm publication.

## Single sentence

**Agent conversations and CLI calls can end before the work is finished. Agent Runtime Lite keeps single-host task state across independent CLI invocations and requires evidence before a successful job can be marked complete.**

## 60-second terminal walkthrough

Run with Node.js 20+:

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm run demo:handoff
```

Record the terminal showing these truthful milestones:

1. First CLI invocation returns and prints the detached worker PID.
2. A fresh CLI invocation sees `completion_candidate` after the real child finishes.
3. Completion without the declared gate is rejected.
4. The demo reads the real child log and passes the gate.
5. Task state becomes `completed`; only one worker attempt is recorded.

A caller/session handoff is **not** a demonstration of automatic worker-crash or machine-reboot recovery.

For a tangible deliverable beyond the terminal-output demo, run `node examples/report-file-handoff.mjs`. It generates a real JSON report, rejects completion before file readback, then validates the file before passing its completion gate.

## Hacker News — Show HN

Title: `Show HN: Agent Runtime Lite – local durable jobs with completion gates`

Body:

I built a small MIT-licensed Node.js runner for a problem I kept running into with task-oriented agents: the CLI invocation ends, but work still needs a durable record, and an exit code of 0 does not prove the intended result was verified.

It starts detached local subprocesses, persists task/job/attempt state, and lets another CLI invocation inspect and finish the work. You explicitly pass a completion gate after checking evidence. Uncertain external effects have to be reconciled rather than blindly retried.

This is a single-host preview, not a distributed queue or an LLM framework. It cannot automatically verify arbitrary external systems.

A minimal demo (`npm run demo:handoff`) launches a real child, hands off to fresh CLI processes, rejects premature completion, reads the output log, and then completes the task.

Code and 5-minute quickstart: https://github.com/Sharky0209/agent-runtime-lite

I'd especially appreciate criticism from developers maintaining long-running local agent tasks. What would prevent you from integrating a small runtime like this?

## V2EX — 分享创造

标题：`开源一个轻量 Node.js Agent 任务运行器：跨 CLI 会话续接、完成前验收（MIT）`

正文：

最近把自己在 Agent 自动化里遇到的一个小问题独立成了开源项目：CLI 返回了，不代表任务真正完成；子进程退出码为 0，也不代表结果已经核验。

Agent Runtime Lite 是一个单机运行、没有第三方 npm 依赖的小框架，核心是：
- 任务 / Job / Attempt 状态落盘，换一个 CLI 进程还能读回；
- 后台子进程执行完成，先进入待验收状态；
- 提供明确的完成门槛，核实输出后再标记完成；
- 外部效果不明确时保留待核对状态，不自动重复执行。

一分钟本地体验（Node.js 20+）：

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm run demo:handoff
```

演示的是真实子进程和跨 CLI 调用接力，不是 Worker 崩溃后的任意自动恢复，也不是分布式调度服务。

仓库：https://github.com/Sharky0209/agent-runtime-lite
使用说明：https://github.com/Sharky0209/agent-runtime-lite/blob/main/docs/QUICKSTART.md

现在想请做过 Agent / CLI / 自动化任务系统的开发者直接挑毛病：你们实际使用中最看重哪些保证？如果按 README 跑不通，也欢迎给复现步骤。

## First feedback checkpoint

Record independently verified facts, not vanity targets: public link to the post; direct demo feedback; number of external attempts with permission to cite; failures reproducible from an empty directory; and any real integration confirmed by its author. Don't infer adoption from Stars or views.

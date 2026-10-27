# Agent Runtime Lite

[![Cross-platform tests](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml/badge.svg)](https://github.com/Sharky0209/agent-runtime-lite/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[5-minute quickstart](docs/QUICKSTART.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [中文说明](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Maintenance roadmap](docs/MAINTENANCE.md) · [Independent trial kit](docs/LAUNCH.md) · [npm beta publishing](docs/NPM_PUBLISHING.md) · [Changelog](CHANGELOG.md)

**Your agent's CLI session ended. Did its task actually finish?**

Agent Runtime Lite keeps a local task record across separate CLI invocations, launches a detached child process, and distinguishes successful command exit from **caller-attested completion**. In v0.2, every new job requires caller-supplied completion evidence by default. If no custom gates were configured, the runtime adds a mandatory `caller_attestation` gate; existing custom evidence gates fulfill the requirement without an extra duplicate step.

It is a dependency-free Node.js runner for single-host workflows—not an AI model host, a distributed queue, or automatic proof of external business outcomes.

**Important distinction:** `caller_attestation` is a statement supplied by the caller; the library does **not** independently verify external file contents or business outcomes. New jobs can explicitly use `completionMode: 'exit_only'` when OS exit code is sufficient; their completion is labeled `process_exit_only`, not attested. Previously saved v0.1.x jobs retain their original gates. See the [v0.2 migration guide](docs/MIGRATION_V02.md).

## Try the public preview (no source checkout)

From a new, empty directory with Node.js 20+ and npm:

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.2.0-beta.2/agent-runtime-lite-0.2.0-beta.2.tgz
npm exec -- arl --version
npm exec -- arl demo
```

This installs the **GitHub Release tarball**, not a package from the npm registry. `arl demo` starts a real detached child, reads its generated report in a separate CLI process, rejects completion without evidence, verifies the file and then completes the job. It removes its disposable workspace after success.

### See the full handoff flow (source checkout)

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm run demo:handoff
```

The demo starts a real detached child, ends the first CLI invocation, retrieves its state through fresh CLI processes, rejects premature completion, checks the actual log, and only then completes. It demonstrates **caller handoff**, not automatic recovery from an arbitrary worker crash.

Expected final lines:

```text
Final task state: completed
Worker attempts: 1
The original CLI process did not need to remain open.
```

**Want a file-based example?** Run `node examples/report-file-handoff.mjs` to generate a real `report.json` in a detached subprocess, read the file from a fresh CLI caller, reject completion until its contents are checked, and then complete the task. These demos need only Node.js 20+.

**A portable, dependency-free Node.js task runner with durable state, explicit recovery, and evidence-based completion.**

Version 0.2.0-beta.2 · MIT licensed · Built for single-host, recoverable agent workflows.

**First independent users:** share honest installation/use-case feedback in [the public tester thread](https://github.com/Sharky0209/agent-runtime-lite/issues/3). You do not need to star the repository.

## Why this exists

Agent conversations can end before the work does. A child process exiting successfully also does not prove that a report reached its destination. Agent Runtime Lite separates these concerns:

- **Control task:** a durable user goal, which can contain multiple jobs.
- **Runtime job:** a named OS command with its own execution lifecycle.
- **Attempt:** an append-only record of one worker/child execution.
- **Operation:** a potentially external effect, marked uncertain before dispatch and confirmed only after readback.
- **Completion gate:** a named piece of evidence required before completion.
- **Resource reservation:** prevents two jobs from using the same declared write target concurrently.
- **Evidence-gated dependencies:** a job may declare previously submitted job keys in `dependsOn`; it cannot launch until all of them reach `completed`. Use `plan` and explicit `run-ready` to move a workflow forward.

This release is intentionally a **single-host local runtime**, not a distributed orchestration service.

## Requirements

Node.js 20 or later. No database server, browser, external service, or npm dependency.

From this directory:

```sh
npm test
npm run example
npm run demo:handoff
npm run test:package
```

**New users:** start with the tested [five-minute quickstart](docs/QUICKSTART.md). It includes clean tarball installs in PowerShell and Bash. The package is **not** on the public npm registry yet.

The CLI is `node bin/arl.mjs` (or `arl` after registering the package's bin). Runtime data is created beneath `.arl/` in the chosen `--root` directory.

## CLI walkthrough

PowerShell example (the CLI prints JSON containing the generated IDs):

```powershell
node bin/arl.mjs accept --root . --key demo-1 --title "Generate a report"
node bin/arl.mjs submit --root . --task TASK_ID --key report --command '{"exe":"node","args":["-e","console.log(\"ready\")"]}' --gates '["report_readback"]'
node bin/arl.mjs start --root . --job JOB_ID
node bin/arl.mjs status --root . --job JOB_ID
node bin/arl.mjs gate --root . --job JOB_ID --name report_readback --evidence "Reviewed report output"
node bin/arl.mjs complete --root . --job JOB_ID
node bin/arl.mjs status --root . --task TASK_ID
```

For portable JSON arguments without shell escaping issues, supply a JSON file via `--command-file ./command.json` and a single gate with `--gate report_readback`. See the **tested PowerShell and Bash scripts** in the [quickstart](docs/QUICKSTART.md). A running job creates a detached worker and records a log in `.arl/logs/`. Successful OS exit moves the job into `completion_candidate`; it does **not** complete automatically.

## One-command verified workflows (new, unreleased)

Instead of manually copying task/job IDs between commands, describe ordered steps once in a JSON file and drive the flow with a **single CLI invocation**:

```sh
node bin/arl.mjs flow --root ./trial-workspace --flow-file ./examples/verified-workflow.json --wait-ms 10000
```

The [example manifest](examples/verified-workflow.json) creates two real Node.js jobs. The first writes `report.json`, the second reads it and writes `summary.json`; each stage requires runtime-checked JSON fields before it can complete. The command returns the task ID, per-job IDs, started/auto-completed steps, remaining reviews and final state. A second run with the same manifest and root reuses the same stable task/job keys, rather than rerunning completed work. Import is durable: an interrupted multi-step setup can be resumed by providing the same manifest again.

Use `arl drive --root ./trial-workspace --task TASK_ID --wait-ms 10000` to continue an already registered task without supplying the manifest. For integrations, import `{runFlow, Runtime}` and call `await runFlow(runtime, manifest)`. Each drive call is bounded to 30 seconds; if a child is still executing, call it again later. Jobs needing caller-supplied gates, exit-only confirmation, or reconciliation of external effects remain pending for explicit review; a failed or mismatched output is never silently accepted. The command does not run a background service, replay failed jobs or verify external destinations. Unlike `arl demo`, this uses your selected persistent `--root` and does **not** delete it.

The feature is currently on the repository source branch; it is **not** in the immutable `v0.2.0-beta.2` Release archive.

## Multi-step workflows (new, unreleased)

Submit jobs in dependency order using keys within the **same task**. `dependsOn` is persisted and immutable for idempotent submissions; forward references and circular graphs are rejected by requiring each predecessor to exist first. Existing jobs without dependencies continue to work.

```js
const taskId = r.accept({key: 'report-flow', title: 'Produce then review'}).task.id;
const report = r.submit({taskId, key: 'produce', command: producerCommand}).job;
const review = r.submit({taskId, key: 'review', dependsOn: ['produce'], command: reviewerCommand}).job;
r.runReady({taskId}); // starts produce, not review
// After produce exits zero: independently inspect the report output.
r.passGate({jobId: report.id, name: 'caller_attestation', evidence: 'Report read back and checked'});
r.complete({jobId: report.id});
r.runReady({taskId}); // now starts review, exactly once
```

The commands above assume `r` is a `Runtime` instance and `producerCommand` / `reviewerCommand` are your real `{exe, args}` commands. Wait for `completion_candidate` before passing evidence. `runReady` is **one-shot**, not a background daemon: invoke it again after each completed stage. `r.plan({taskId})` is read-only and shows ready, waiting-for-dependency and resource-busy jobs. From the CLI: `arl plan --root ./state --task TASK_ID` and `arl run-ready --root ./state --task TASK_ID`. Always specify the task ID. `plan` can include task/job keys, so unlike `doctor` it is not share-safe.

A dependency requires its predecessor to be marked `completed`. If that predecessor was deliberately configured as `exit_only`, this is **not independent evidence** of its external outcome. Failed predecessors never unlock downstream work. The one-shot `runReady` feature does not automatically verify output, retry external effects or run an always-on scheduler. For file-only jobs, the separate `drive` feature can now perform the readback and advance the dependency chain.

## Runtime-checked local output (new, unreleased)

For tasks producing local JSON, `fileCheck` gives the runtime a **concrete readback contract**, instead of relying on a caller to claim the file was inspected. This is narrower than arbitrary external-outcome verification: the runtime checks specified top-level JSON fields at the configured workspace-relative path, and rechecks them immediately before completion.

```js
const taskId = r.accept({key: 'checked-report', title: 'Build a checked report'}).task.id;
const {job} = r.submit({
  taskId, key: 'report', command: reportCommand,
  fileCheck: {path: 'report.json', jsonFields: {status: 'ready', count: 3}}
});
r.start({jobId: job.id});
// Wait for completion_candidate; the worker must actually write report.json.
r.verifyFile({jobId: job.id}); // independently opens/parses/checks the file
r.complete({jobId: job.id});   // rechecks the file before storing completion
// completionBasis is local_file_checked, not caller_attested.
```

From the CLI, pass `--file-check '{"path":"report.json","jsonFields":{"status":"ready","count":3}}'` when submitting, then use `arl verify-file --root ./state --job JOB_ID` after successful process exit. The CLI option is a JSON argument; PowerShell and Bash quoting differ. The path resolves relative to the runtime `--root` directory; the command must write there (or use an explicit matching location). Matching fields must have identical JSON values, though other fields may exist. A missing, invalid, or mismatched file never passes the gate. Unlike a manually passed gate, `local_file_check` cannot be satisfied with a caller-provided string.

When both `fileCheck` and custom caller gates are configured, all must pass and the completion basis is `local_file_checked_plus_caller_attested`. With `fileCheck` alone, no separate `caller_attestation` gate is needed. `exit_only` cannot be combined with file checking. A matching pre-existing local file can satisfy the condition: this demonstrates **observed file contents at check time**, not that the most recent command created them, and it is not proof of a third-party delivery. The already published `v0.2.0-beta.2` archive does **not** contain this unreleased feature.

## JavaScript API

```js
import {Runtime} from './src/runtime.mjs';
const r = new Runtime('./my-workspace');
const {task} = r.accept({key: 'weekly-report', title: 'Weekly report'});
const {job} = r.submit({
  taskId: task.id,
  key: 'generate',
  command: {exe: process.execPath, args: ['-e', 'console.log("ok")']},
  resources: ['report:weekly'],
  gates: ['reviewed_report'],
});
r.start({jobId: job.id});
// Later, even in a different process:
// r.status({jobId: job.id});
// r.passGate({jobId: job.id, name: 'reviewed_report', evidence: 'Report inspected'});
// r.complete({jobId: job.id});
```

Run `npm run example` to see the full flow with polling and a verified completion.

## Dealing with external writes

Before attempting an external action during an active job, call `beginOperation({jobId,key})` with a stable business-operation key. If the call times out, the operation stays **uncertain**: never treat the absence of a success response as proof that the action did not happen.

After checking the external destination, use:

```js
r.settleOperation({jobId, key: 'publish-1', outcome: 'confirmed', evidence: 'Target readback shows the change'});
// or outcome: 'aborted', if you established that dispatch never occurred
```

The library does not send external requests itself and cannot certify evidence automatically. You provide the external implementation and truthful readback. An uncertain operation prevents final completion and prevents an unsafe retry. Once an operation is settled, repeating the same outcome returns its original record without replacing the first evidence; attempting the opposite outcome is rejected.

## Diagnosing a workspace

Use `arl doctor --root ./my-workspace` (or `node bin/arl.mjs doctor --root ./my-workspace` from a source checkout) to inspect a **read-only, share-safe aggregate** of job states, resources, uncertain operations, and potential stale workers. The output excludes command arguments, task titles, job IDs, local paths and private verification evidence. It does not repair state or start a process; see [troubleshooting](docs/TROUBLESHOOTING.md) for safe next steps. Use `status` only locally because full status includes command details and evidence.

## Recovery and retry

- `recover()` checks jobs marked launching/running and their actual processes.
- Dead workers are **blocked by default**, leaving their attempt history intact.
- `resume: 'auto_safe'` is permitted only with `readOnly: true` and a finite `maxRestarts`. This policy is **opt-in** for commands safe to rerun.
- Jobs with a still-live child do not restart.
- `retry({jobId})` is an explicit operator decision after verifying that retrying will not duplicate an effect.
- Resource reservations remain held while a job is awaiting gate confirmation. They are released when completion is confirmed or a failed job has no uncertain effects.

## Scope and limits

Designed for a **single Windows/macOS/Linux host using a local filesystem**. It stores a single atomic JSON snapshot protected by a short-lived process lock, so it suits small and medium personal agent workloads rather than a large distributed job queue.

Currently not included: automatic verification of arbitrary external side effects, distributed leases, a scheduler, GUI/browser automation, remote worker management, production SaaS adapters, or an npm registry release. This project does not bundle or reuse any third-party proprietary runtime.

## Development and publication

See [architecture and design boundaries](docs/ARCHITECTURE.md). The runtime is in `src/`, the CLI in `bin/`, and the offline/integration tests in `test/`. Contributions, bug reports, and reproducible use cases are welcome.

Distributed coordination, persistent service management, and automated verification of remote side effects are outside the current preview scope. The [adoption and feedback page](docs/ADOPTION.md) invites independent users to report real experiences.

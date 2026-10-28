# Five-minute quickstart (Windows, Linux, macOS)

**Who it is for:** Node.js developers who want a single-host task runner that survives the end of a CLI invocation and does not mark work complete until caller-provided evidence has been checked.

**What it is not:** an AI conversation service, a sandbox for untrusted commands, or distributed failover. This demonstration shows **caller/session handoff**, not that a crashed worker or an OS reboot can be resumed automatically.

## Fastest install: GitHub Release tarball

For a new empty local project (Node.js 20+):

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.2.0-beta.2/agent-runtime-lite-0.2.0-beta.2.tgz
npm exec -- arl --version
npm exec -- arl demo
npm exec -- arl --help
```

The `arl demo` command runs a real report-writing child and separate CLI readback processes inside a disposable temporary directory. It rejects completion without caller evidence, then checks the report and completes only after the evidence gate passes; no clone, credentials or external systems are required. This uses a publicly downloadable release asset, **not an npm registry publication**. Downloading/installing the release archive was verified from a separate temporary consumer. Provide your real trial feedback in [the first testers thread](https://github.com/Sharky0209/agent-runtime-lite/issues/3).

## Clone and test

Prerequisite: Node.js 20+, npm, and Git.

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm test
npm run demo:handoff
```

Expected end of the demo:

```text
CLI invocation #1 returned. Worker PID: ...
New CLI invocations recovered state: completion_candidate
Unreviewed completion was rejected.
Final task state: completed
Worker attempts: 1
The original CLI process did not need to remain open.
```

This demo runs real Node.js child processes locally. It creates its state only under a generated temporary directory and needs no cloud account, API key, database or external server.

## Test the package as an independent consumer

```sh
npm run test:package
```

This command creates a temporary npm tarball, installs it into a separate temporary project **offline** (without registry traffic), verifies the npm CLI shim and public package export, invokes the installed CLI, waits for a real worker, reads its output log, rejects premature completion, passes its evidence gate, and verifies the completed task. All temporary installation files are deleted afterward.

The smoke test verifies the local packaging path. **The package is not yet published to npm**; this is not an instruction to run `npm install agent-runtime-lite` from the public registry.

## Shell-specific guided installation

On **Windows PowerShell** (Windows PowerShell 5.1+ or PowerShell 7):

```powershell
./examples/quickstart.ps1
```

If execution policy blocks local scripts, run from a trusted project checkout with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File examples/quickstart.ps1` for that one process. Inspect the script before running it.

On **Linux or macOS Bash**:

```bash
bash ./examples/quickstart.sh
```

Both scripts work from the source checkout; they build a local tarball, install it into a separate temporary consumer directory, and run a real subprocess using the **installed** CLI, not the checked-out source. They demonstrate passing a JSON command through `--command-file` rather than relying on fragile shell quoting. The scripts intentionally avoid collecting user credentials or reading unrelated files.

## Use the CLI yourself

The installed `arl` CLI supports:

```text
arl --help
arl --version
arl accept --root ./my-agent-state --key demo --title Demo
arl submit --root ./my-agent-state --task TASK_ID --key hello --command-file command.json --gate reviewed_output
arl start --root ./my-agent-state --job JOB_ID
arl status --root ./my-agent-state --job JOB_ID
arl gate --root ./my-agent-state --job JOB_ID --name reviewed_output --evidence "Checked actual output"
arl complete --root ./my-agent-state --job JOB_ID
```

In `command.json`, put the command you actually intend to run:

```json
{"exe":"node","args":["-e","console.log('hello')"]}
```

Use the returned `task.id` and `job.id` as `TASK_ID` and `JOB_ID`. Wait for `completion_candidate` and inspect the real result **before** calling `gate`. A successful process exit is not proof an arbitrary external business action happened.

A new job defaults to mandatory caller evidence: if you omit `--gate`, the required gate is named `caller_attestation`; if you use `--gate`, that custom evidence gate is sufficient and there is no duplicate attestation step. To intentionally use exit-code-only semantics, supply `--completion-mode exit_only` and no custom gates; results are **unverified**. Old stored jobs preserve old gates; see [v0.2 migration](MIGRATION_V02.md).

## One-command two-stage workflow (unreleased source checkout)

Use the included [workflow manifest](../examples/verified-workflow.json) and run from the repository directory:

```sh
node bin/arl.mjs flow --root ./trial-workspace --flow-file ./examples/verified-workflow.json --wait-ms 10000
```

The two processes really write `report.json` and `summary.json` inside `trial-workspace`. Each stage is independently read back by the runtime before it can unlock its successor. Rerunning the exact same command retains previous completion records; it does not execute completed jobs a second time. To continue a pre-registered task, call `node bin/arl.mjs drive --root ./trial-workspace --task TASK_ID`. A bounded call can end while a child is still running: rerun the driver. Human evidence gates and uncertain external operations require explicit review; there is no background scheduler. Do not mistake the current source feature for the already-published beta.2 archive.

## Real worker integration example (unreleased source checkout)

Run `npm run demo:integration` from the checkout. This launches a detached child, injects `ARL_ROOT` and task/job/attempt IDs, registers a delivery operation, writes and reads back a **local stand-in recipient receipt**, settles the operation and verifies a fresh JSON report. It cleans up its temporary workspace. There is no actual network delivery; use your own destination read API for that. See [integration guide](INTEGRATION.md).

Set `fileCheck.fresh: true` if a matching report must have been modified since the current attempt started. A stale file reports `FILE_CHECK_STALE` and cannot auto-complete through `flow` or `drive`. The default check remains content-only for backward compatibility; modification time is not independent proof of file authorship.

## Multi-step jobs from the checkout (unreleased)

The source checkout now offers same-task dependent jobs. Submit a first Job with `--key produce`, then a second using `--key inspect --depends-on '["produce"]'` (also supplying `--task` and `--command-file`). The predecessor must be registered before the dependent. Inspect with `node bin/arl.mjs plan --root ./my-agent-state --task TASK_ID`, then dispatch once using `node bin/arl.mjs run-ready --root ./my-agent-state --task TASK_ID`. Check actual results, pass the first Job's gate and complete it before running `run-ready` again to launch `inspect`. These commands do not auto-verify output, and `run-ready` does not run continuously. See the [README workflow guide](../README.md#multi-step-workflows-new-unreleased).

## Runtime-checked JSON results (unreleased source checkout)

For a report-writing job, add `--file-check '{"path":"report.json","jsonFields":{"status":"ready"}}'` to `submit` (adapt JSON quoting for your shell). Make the job's child write `report.json` under the chosen `--root`. Once `status` shows `completion_candidate`, call `node bin/arl.mjs verify-file --root ./my-agent-state --job JOB_ID` and then `complete`. The runtime reads the real JSON, checks `status`, and checks again at completion. Missing/invalid/mismatched files fail. Unlike `gate --evidence`, this check cannot be satisfied by a caller statement; it also does not verify remote business systems or prove that a pre-existing matching file came from this attempt. See [README](../README.md#runtime-checked-local-output-new-unreleased) for the API and limits.

See [architecture](ARCHITECTURE.md), [maintenance](MAINTENANCE.md), and [contributing](../CONTRIBUTING.md).

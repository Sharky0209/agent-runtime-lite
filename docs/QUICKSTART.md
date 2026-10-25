# Five-minute quickstart (Windows, Linux, macOS)

**Who it is for:** Node.js developers who want a single-host task runner that survives the end of a CLI invocation and does not mark work complete until caller-provided evidence has been checked.

**What it is not:** an AI conversation service, a sandbox for untrusted commands, or distributed failover. This demonstration shows **caller/session handoff**, not that a crashed worker or an OS reboot can be resumed automatically.

## Fastest install: GitHub Release tarball

For a new empty local project (Node.js 20+):

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.1.4/agent-runtime-lite-0.1.4.tgz
npm exec -- arl --version
npm exec -- arl --help
```

This uses a publicly downloadable release asset, **not an npm registry publication**. Downloading/installing the release archive was verified from a separate temporary consumer. Provide your real trial feedback in [the first testers thread](https://github.com/Sharky0209/agent-runtime-lite/issues/3).

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

See [architecture](ARCHITECTURE.md), [maintenance](MAINTENANCE.md), and [contributing](../CONTRIBUTING.md).

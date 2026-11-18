# A concrete framework for resumable local agent work

Agent Runtime Lite provides **the execution and evidence layer**, not a model, prompt library, remote queue or hosted agent platform. You write a normal command (Python, Node.js, a CLI, etc.); ARL runs it as a durable job and decides what can move forward based on declared completion contracts.

## The five layers

| Layer | Your code | ARL provides |
| --- | --- | --- |
| Definition | Tasks, commands, dependencies and expected artifacts | Stable task/job keys and workflow preflight |
| Execution | Ordinary CLI programs | Detached worker, attempt history and resource reservations |
| Evidence | Output schema, local file checks or application-specific readback | Gates, runtime-owned local verification and completion basis |
| Recovery | Decide whether failed work is safe to repeat | Durable state, explicit recovery and review blockers |
| Integration | Your external API adapter, credentials and actual destination checks | Operation intent and reconciliation records; **not** an external verifier |

The public API is `Runtime`, `previewFlow` and `runFlow` from `agent-runtime-lite`; the `arl` CLI exposes the same core workflow. No new plugin interface or server is required. This is a deliberately small, composable framework.

## Working example: audit invoices and produce a report

**Problem:** an agent or scheduled CLI imports payment records, produces totals, and should not declare success merely because a script exited 0.

From the current source checkout (Node.js 20+):

```sh
npm run demo:orders
# Or keep each dataset in its own durable state directory:
node examples/order-audit/run.mjs ./my-audit-run
```

Input: `./my-audit-run/invoices.jsonl`. On first run only, the example copies four synthetic invoices there. To use your own data, create that directory and place your `invoices.jsonl` **before** first execution. Each line is JSON with `id`, non-negative integer `amountCents`, and `status` (`paid` or `pending`). No customer information or API keys are needed. This example uses JSONL rather than full CSV so quoting rules do not become an unrelated parser dependency.

The pipeline consists of three actual subprocesses:

1. **build** reads and validates input, rejects duplicate IDs, and writes `audit.json` (fresh JSON check: `status=ready`).
2. **verify** rereads the original dataset in a separate process, compares all totals with `audit.json`, and writes `verification.json` (fresh JSON check: `status=verified`).
3. **render** rereads the verified totals, writes a human-readable `summary.md`, reads the output back, and produces `rendered.json` for a fresh runtime-owned JSON check (`status=rendered`).

For the provided sample, `audit.json` contains `invoiceCount=4`, `paidCount=3`, `totalCents=20575` and `paidCents=16025`. The summary reports paid amount **160.25**. The result includes `taskId`, final state, per-job attempt counts and output path. `arl status --root ./my-audit-run --task TASK_ID` and `arl plan --root ./my-audit-run --task TASK_ID` can inspect the persisted workflow later.

Running with the **same root** again reuses the stored job keys and records, including completed attempts. For another input batch, use **another root**. Do not rewrite the input behind an already-completed task and expect ARL to notice it: this is a keyed workflow, not a file watcher.

### What failure looks like

Duplicate IDs, invalid amounts or invalid statuses make the build process fail; no later job starts. If someone tampers with `audit.json`, the verifier rejects it instead of writing a successful verification. The driver prints a non-completed task state and exits nonzero. Inspect the task, correct the source and explicitly decide on retry semantics. The driver does not automatically rerun failed effects.

The tests exercise successful completion, no relaunch on repeat execution, corrupt input and tampered intermediate output:

```sh
node --test test/order-audit.test.mjs
npm test
```

### Where the boundaries are

The verifier and Markdown readback are application code written as part of this example. ARL verifies the declared local JSON receipts; it does **not** itself parse or verify `summary.md`, independently audit financial correctness, prove who authored a file, or verify delivery to a remote party. For simpler size-based checking of non-JSON output, current source also supports `fileCheck.minBytes`. If a job sends an email, updates an API, or uploads a report, record that effect using `beginOperation`, read back from the real destination, and settle it only after confirming the actual result. See [Integration](INTEGRATION.md).

The sample is in the **unreleased source branch** and is not included in the `v0.2.0-beta.2` GitHub Release tarball.

## Where to use the framework next

| Practical workflow | Work that ARL can manage | Completion must be checked by |
| --- | --- | --- |
| Agent-generated daily report | Collect local data → generate report → validate output | JSON fields and a readable report, plus reviewer gate if correctness is subjective |
| CI/local build packaging | Run build → produce ZIP/PDF → continue to handoff | Fresh artifact size check, plus real downstream install/open test |
| Data import and reconciliation | Import batch → compare aggregates → write summary | Original-input reread and typed local verification receipt |
| External notification or API call | Prepare payload → submit once → reconcile recipient state | Actual recipient readback and settled operation, not just an HTTP 200 |

For model calls, credentials and network transports, **your application** supplies those adapters. ARL owns local run state and completion transitions, not the external system. For a new use case, start from `examples/order-audit/run.mjs`, replace the three worker commands and gates, and preserve the one-root-per-batch rule.

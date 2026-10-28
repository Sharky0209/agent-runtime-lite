# Embed real jobs and confirm outputs

This guide describes **unreleased source-branch** features. The immutable
`v0.2.0-beta.2` GitHub Release tarball does not include them.

## Try the executable example

Run from the checkout:

```sh
npm run demo:integration
```

Expected output (IDs and timing are intentionally omitted):

```json
{"taskState":"completed","completionBasis":"local_file_checked","receiverConfirmed":true,"attempts":1}
```

The example uses an isolated temporary directory and a **local receiving file**
to model a receiver acknowledgment. It records a potentially external operation,
writes a receipt, reads it back, confirms the operation and verifies a fresh
JSON output. It does not access your accounts, send a network message, or prove
delivery to an actual remote service.

## Use the runtime context in your command

Every runtime-launched child receives four environment variables:

| Variable | Purpose |
| --- | --- |
| `ARL_ROOT` | Absolute runtime state/workspace root |
| `ARL_TASK_ID` | Control task ID |
| `ARL_JOB_ID` | Runtime job ID |
| `ARL_ATTEMPT_ID` | Execution attempt ID (changes on retry) |

These values are scoped to the child. They override inherited variables with
the same names; they are **identifiers, not credentials**. A command can use
them without hardcoding an ID from an earlier CLI invocation.

Inside a Node.js worker program installed alongside the package:

```js
import {Runtime} from 'agent-runtime-lite';

const rt = new Runtime(process.env.ARL_ROOT);
const jobId = process.env.ARL_JOB_ID;
const result = rt.beginOperation({jobId, key: 'upload-report'});

if (!result.deduplicated) {
  // Perform your application-specific upload, then query the actual recipient.
  // Only settle after your code confirms the intended destination and result.
  // rt.settleOperation({jobId, key: 'upload-report',
  //   outcome: 'confirmed', evidence: 'Recipient readback matched report'});
}
```

If an operation already exists as `uncertain`, reconcile it first. Do not
blindly repeat an external effect. The local example implements a basic check.

## Reject matching reports left from an earlier attempt

Without the optional `fresh` field, a file check verifies **content only**.
When the job must update or create its output during this attempt, use:

```json
{
  "fileCheck": {
    "path": "report.json",
    "jsonFields": {"status": "ready"},
    "fresh": true
  }
}
```

The runtime compares the file's modification time with the most recent
attempt's recorded start time and reports `FILE_CHECK_STALE` if the file
predates it. This applies to both `verify-file` and final `complete`,
including automatic `flow`/`drive` completion. It remains opt-in, so
existing manifests and stored jobs keep their previous behavior.

**Limit:** File modification time is evidence of a recent write, not proof that
the worker itself performed it, nor proof of a remote receiver's state.
For remote effects, use an explicit operation with a real recipient readback.
The command should write under the runtime root (or set `command.cwd`
explicitly and configure the matching file path).

## See the next action without changing state

`arl plan --root ./state --task TASK_ID` now returns `nextAction` for each job,
in addition to readiness and blockers. Examples include `run-ready`,
`wait-dependencies`, `verify-file`, `review-and-gate`, `reconcile-operation`,
`complete`, and `inspect-before-retry`. Planning is read-only: suggested
retry actions always require a real-world review, never an automatic replay.

## Embed and resume

```js
import {Runtime} from 'agent-runtime-lite';

const rt = new Runtime('./state');
const task = rt.accept({key: 'daily-report-2026-10-28', title: 'Daily report'}).task;
const job = rt.submit({
  taskId: task.id,
  key: 'generate',
  command: {exe: 'node', args: ['produce-report.mjs']},
  fileCheck: {path: 'report.json', jsonFields: {status: 'ready'}, fresh: true}
}).job;

// One bounded call: can return before a long-running child finishes.
const progress = await rt.drive({taskId: task.id, waitMs: 10000});
// Resume later with the same task ID: rt.drive({taskId: task.id}).
```

Completion is intentionally narrow: a local file check can automatically
finish the job only when **all** required gates pass and operations are settled.
An OS exit code alone never proves external business delivery. See
[Architecture](ARCHITECTURE.md) and [Troubleshooting](TROUBLESHOOTING.md).

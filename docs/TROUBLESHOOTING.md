# Diagnosing a local workspace

Agent Runtime Lite is a single-host command runner. It stores JSON state beneath `.arl/` in the root selected by the caller. It is not a sandbox, distributed queue or recovery watchdog.

## Safe first check

With Node.js 20+ and the installed CLI:

```sh
arl doctor --root ./my-workspace
```

Or from a source checkout:

```sh
node bin/arl.mjs doctor --root ./my-workspace
```

`doctor` **only reads** local state. It does not start, kill, retry, reconcile or recover any task. It works on an uninitialized directory without creating files. Output includes aggregate task and job counts, saved-state size, reserved-resource count, unresolved-operation count, possible stale or missing workers, and standardized block-reason counts. It intentionally excludes raw commands, task names and keys, IDs, absolute paths, external evidence and log contents, so its normal output is appropriate for a public issue. Review any report before sharing it.

**Do not paste `arl status` into a public issue without redaction:** full status can include executable arguments, paths, external-operation evidence and user-provided content.

## Interpreting the summary

| Field | What it means | Next action |
| --- | --- | --- |
| `initialized: false` | No saved state file in this root | Confirm the `--root` value and whether any task was accepted |
| `DOCTOR_STATE_UNREADABLE` | Saved state could not be parsed or read | Back up the workspace; do not overwrite or delete the source state |
| `unresolvedOperations > 0` | Some declared external effects lack a confirmed outcome | Inspect the real destination privately, then reconcile with evidence |
| `uncertainDispatches > 0` | The worker may have launched a child before its PID was persisted | **Do not automatically rerun**; inspect the child and its actual output |
| `reservedResources > 0` | Some jobs still own declared resources | Determine which task owns the reservation with local `status`; never delete state to release locks |
| `staleWorkerHeartbeats > 0` | A PID is visible but its last stored heartbeat is old | The worker may be paused or the PID reused; inspect it locally |
| `missingWorkers > 0` | A job is marked running/launching but no recorded worker PID is visible | Check process and side-effect status before considering `recover` |
| `blockedReasons` | Aggregated standardized failure categories, not raw exception messages | Use local `status --job <id>` to investigate the specific job |

`doctor` is a snapshot, not proof of process identity or external outcome. OS process IDs can be reused. An inaccessible process might still be alive and therefore must not be mistaken for safe-to-replay work.

## Safe recovery sequence

1. Run `arl doctor --root ...` to identify aggregate risks.
2. Inspect the affected job privately using `arl status --root ... --job JOB_ID`. Check the actual command output and the target system; the library cannot inspect your external destination.
3. If a worker really died, and a recovery check is appropriate, run `arl recover --root ...`. **Unlike doctor, recover writes state and may automatically relaunch opt-in read-only jobs** that pass its conservative policy. Do not call it blindly.
4. Reconcile any external operation with real evidence before an explicit `retry`. Never assume a network timeout means no effect occurred.
5. If you suspect a persistence problem, back up the entire `.arl/` directory before taking repair actions. Do not manually edit or delete state or locks while jobs might be alive.

## Reporting a problem

Include the version (`arl --version`), OS, Node.js version, the aggregate `doctor` output, and a minimal reproduction that uses only test data. Exclude credentials, executable paths containing user information, customer details, private logs and full `status` output. Open a [bug report](https://github.com/Sharky0209/agent-runtime-lite/issues/new/choose) or leave independent tester feedback in [issue #3](https://github.com/Sharky0209/agent-runtime-lite/issues/3).

Privacy note: `doctor` does not send telemetry and requires no network connection.

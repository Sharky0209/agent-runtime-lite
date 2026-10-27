# Architecture and execution boundaries

Agent Runtime Lite is a local, single-host task runner that stores durable state in a workspace-specific directory. No server or external database is necessary.

## State entities

| Entity | Purpose |
| --- | --- |
| `control_task` | Captures a user goal, groups the required jobs, and derives overall status. |
| `runtime_job` | Defines the executable, arguments, resource reservations, recovery policy, and completion criteria. |
| `attempt` | Append-only history of each actual worker/child launch. |
| `operation` | Caller-declared potentially external effect with an explicit reconciliation outcome. |
| `completion gate` | Caller-supplied evidence required before marking the job completed. |

## Typical lifecycle

1. The caller accepts a task using a stable key.
2. The caller submits a named job with a command, optional resource reservations, and optional extra completion gates. **New jobs default to `attested` mode** with at least one mandatory caller-evidence gate (`caller_attestation` is inserted only if no custom gates were supplied); opt-out to `exit_only` must be explicit.
3. `start()` reserves named resources and starts a detached Node.js worker.
4. The worker records attempt process details, runs the configured command, and stores the exit result.
5. Exit code zero establishes only a completion **candidate**. In default `attested` mode, the caller inspects business output and passes the required custom evidence gates, or the automatically inserted `caller_attestation` if no custom gates exist. The runtime does not validate that the caller's evidence is truthful.
6. `complete()` verifies all gates, enforces the mandatory attestation gate even if it is missing from a modified state, and refuses unresolved external operations. Results record `completionBasis`: `caller_attested` or explicit `process_exit_only`. Previously persisted v0.1.x jobs keep their stored requirements and are labeled with a `legacy_*` completion basis. The task's derived status then reflects its required jobs.

## Explicit dependent-job workflows (unreleased)

Jobs may declare `dependsOn: ['earlier-job-key']` within the same control task. Predecessors must already have been submitted; this prevents cycles by construction and keeps dependencies stable across CLI sessions. The dependency list participates in the idempotency contract and cannot silently change on repeated submission. A direct `start()` or one-shot `runReady({taskId})` refuses to dispatch a child until **all** predecessor states are `completed`, not merely `completion_candidate`. The check happens inside the same state lock as resource reservations and attempt creation. It therefore applies even if callers bypass the planner or race on separate CLI sessions.

Read-only `plan({taskId})` reports readiness and dependencies/resources holding queued jobs. `runReady` tries eligible queued jobs in submission order and reports resource conflicts/dependency waits; it never retries failed jobs or attests their completion. A prior `exit_only` job can satisfy a dependency, but this preserves its declared **process-only, unverified** semantics. Callers drive further stages after explicit outcome review. This is not an autonomous scheduler, distributed execution engine or guarantee that external effects were verified.

The state is persisted as an atomic JSON snapshot and synchronized with a local lock. The approach is deliberately simple and works best with small to medium local agent workloads.

## Runtime-owned local file evidence (unreleased)

An optional `fileCheck: {path, jsonFields}` is an immutable job contract for expected JSON fields in a local file under the runtime root. It requires `attested` mode and installs a reserved `local_file_check` gate, which `passGate()` cannot set. `verifyFile({jobId})` actually opens, parses and compares the named top-level fields while the state transition is locked. `complete()` repeats this readback immediately before committing the final state, so evidence cannot remain valid after an ordinary intervening file mutation. Retrying an execution resets the gate.

When only this check is configured, the completion basis is `local_file_checked`; it can coexist with caller gates, resulting in `local_file_checked_plus_caller_attested`. Without `fileCheck`, all existing completion behavior is unchanged. File checks are local condition checks, **not** independent remote-business verification or proof of which process created a matching file. Files may be modified after completion; the record establishes the observation at validation/completion time, not permanent artifact integrity.

## Recovery behavior

Running jobs are only considered lost when the recorded worker is gone. If a child is still alive, recovery reports a blocker rather than launching a second command. Before spawning a child, the worker records a durable `spawnIntentAt` marker. If it crashes before persisting the child's PID, recovery blocks as `CHILD_DISPATCH_UNCERTAIN` rather than guessing that the child never started. The resource reservation remains held even if an uncertain external operation is later reconciled. An operator must inspect the outcome and make an explicit `retry()` decision after verifying it is safe to rerun; that transition releases the old reservations. Automatic recovery is opt-in and limited to declared read-only jobs with no outstanding dispatch uncertainty. Other jobs require explicit review and `retry()`.

This marker closes the known spawn-before-PID-persist recovery gap conservatively; it cannot prove whether the child actually launched. Workers persist an initial heartbeat when they enter `running` and refresh it periodically. If a recorded worker or launcher PID still exists but its heartbeat is older than 30 seconds, recovery blocks as `WORKER_HEARTBEAT_STALE` instead of accepting that PID as proof the original worker is running or automatically restarting it. It retains the resource reservation for operator review. This is a safety heuristic, not a portable process-identity guarantee: a paused but legitimate worker can also be blocked; PID reuse with a recent heartbeat is not distinguishable from the original process without OS-specific process identity evidence.

For a blocked job, inspect the actual child, its output and external effects, then reconcile outstanding operations. Use explicit retry only after confirming no relevant process remains and rerunning is safe. Never interpret an old PID alone as proof that the original worker is healthy.

A command that reaches its configured `timeoutMs` fails even if the child subsequently exits with code zero. On POSIX hosts, the worker first signals termination and then forcibly terminates an unresponsive child after a short grace period. Timeouts do not satisfy completion gates.

## External effects

The library cannot know what an application actually wrote. The caller records the intended operation and must validate its externally observable result before settling it. Unconfirmed operations are not treated as absent. This model avoids equating transport failures with proof of nonexecution.

## Design limits

- Single local host only. The lock is not a distributed lock.
- No timer-based or autonomous scheduling or long-lived service watchdog. `runReady` is an explicit one-shot dispatcher.
- No built-in remote application integrations.
- External-business evidence is supplied by a caller; the optional built-in local JSON check verifies only explicitly named fields in one local file, not arbitrary systems.
- No guarantee that an arbitrary command is safe to rerun, even if a user marks it read-only.
- Child-process supervision is per direct child, not a portable process-tree termination service; applications launching descendants must manage their own cleanup.

## Tests

The test suite uses isolated temporary directories and launches real child processes. It covers distinct callers, state reloads, duplicate submissions, concurrency, resource reservations, process exit, failed jobs, uncertain operations, and recoverable interrupted jobs. Recovery coverage includes a simulated reused PID with an expired heartbeat and termination of a real worker with an unresolved external operation. A separate fault-injection test runs the real worker and child, waits for observable child execution, then terminates the worker **after OS spawn but before writing the child PID**; recovery must preserve the reservation and avoid automatic replay. The injection uses a callback supplied only by this isolated test harness. These tests do not force operating systems to recycle the same numeric PID.

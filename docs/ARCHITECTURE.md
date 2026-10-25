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
2. The caller submits a named job with a command, optional resource reservations, and any additional completion gates.
3. `start()` reserves named resources and starts a detached Node.js worker.
4. The worker records attempt process details, runs the configured command, and stores the exit result.
5. Exit code zero establishes only a completion **candidate**. If additional gates are configured, the caller must check business output and pass those gates; without extra gates, the caller can complete after exit code zero without external readback (v0.1.4 limitation; see issue #13).
6. `complete()` verifies that all gates are passed and there are no uncertain external operations. The task's derived status then reflects its required jobs.

The state is persisted as an atomic JSON snapshot and synchronized with a local lock. The approach is deliberately simple and works best with small to medium local agent workloads.

## Recovery behavior

Running jobs are only considered lost when the recorded worker is gone. If a child is still alive, recovery reports a blocker rather than launching a second command. Before spawning a child, the worker records a durable `spawnIntentAt` marker. If it crashes before persisting the child's PID, recovery blocks as `CHILD_DISPATCH_UNCERTAIN` rather than guessing that the child never started. The resource reservation remains held even if an uncertain external operation is later reconciled. An operator must inspect the outcome and make an explicit `retry()` decision after verifying it is safe to rerun; that transition releases the old reservations. Automatic recovery is opt-in and limited to declared read-only jobs with no outstanding dispatch uncertainty. Other jobs require explicit review and `retry()`.

This marker closes the known spawn-before-PID-persist recovery gap conservatively; it cannot prove whether the child actually launched. Workers persist an initial heartbeat when they enter `running` and refresh it periodically. If a recorded worker or launcher PID still exists but its heartbeat is older than 30 seconds, recovery blocks as `WORKER_HEARTBEAT_STALE` instead of accepting that PID as proof the original worker is running or automatically restarting it. It retains the resource reservation for operator review. This is a safety heuristic, not a portable process-identity guarantee: a paused but legitimate worker can also be blocked; PID reuse with a recent heartbeat is not distinguishable from the original process without OS-specific process identity evidence.

For a blocked job, inspect the actual child, its output and external effects, then reconcile outstanding operations. Use explicit retry only after confirming no relevant process remains and rerunning is safe. Never interpret an old PID alone as proof that the original worker is healthy.

A command that reaches its configured `timeoutMs` fails even if the child subsequently exits with code zero. On POSIX hosts, the worker first signals termination and then forcibly terminates an unresponsive child after a short grace period. Timeouts do not satisfy completion gates.

## External effects

The library cannot know what an application actually wrote. The caller records the intended operation and must validate its externally observable result before settling it. Unconfirmed operations are not treated as absent. This model avoids equating transport failures with proof of nonexecution.

## Design limits

- Single local host only. The lock is not a distributed lock.
- No built-in scheduling or long-lived service watchdog.
- No built-in remote application integrations.
- Evidence is supplied by a caller; the library does not inspect arbitrary systems to prove claims.
- No guarantee that an arbitrary command is safe to rerun, even if a user marks it read-only.
- Child-process supervision is per direct child, not a portable process-tree termination service; applications launching descendants must manage their own cleanup.

## Tests

The test suite uses isolated temporary directories and launches real child processes. It covers distinct callers, state reloads, duplicate submissions, concurrency, resource reservations, process exit, failed jobs, uncertain operations, and recoverable interrupted jobs. Recovery coverage includes a simulated reused PID with an expired heartbeat and termination of a real worker with an unresolved external operation. A separate fault-injection test runs the real worker and child, waits for observable child execution, then terminates the worker **after OS spawn but before writing the child PID**; recovery must preserve the reservation and avoid automatic replay. The injection uses a callback supplied only by this isolated test harness. These tests do not force operating systems to recycle the same numeric PID.

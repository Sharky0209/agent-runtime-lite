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
5. Exit code zero establishes only a completion **candidate**. The caller checks business output and passes any additional gates.
6. `complete()` verifies that all gates are passed and there are no uncertain external operations. The task's derived status then reflects its required jobs.

The state is persisted as an atomic JSON snapshot and synchronized with a local lock. The approach is deliberately simple and works best with small to medium local agent workloads.

## Recovery behavior

Running jobs are only considered lost when the recorded worker is gone. If a child is still alive, recovery reports a blocker rather than launching a second command. Its declared resource reservations remain held, including after settling a previously uncertain operation. Once the child has actually stopped, the operator can inspect the outcome and explicitly call `retry()`; this releases the old reservations for a new attempt. Automatic recovery is opt-in and limited to declared read-only jobs. Other jobs require explicit review and `retry()`.

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

The test suite uses isolated temporary directories and launches real child processes. It covers distinct callers, state reloads, duplicate submissions, concurrency, resource reservations, process exit, failed jobs, uncertain operations, and recoverable interrupted jobs.

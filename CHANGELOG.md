# Changelog

This changelog records meaningful user-facing project updates, not synthetic activity.

## [Unreleased]

## [0.2.0-beta.2] - 2026-10-26

- Add a real `arl demo` to the installed CLI: an isolated, no-clone first-run experience with a detached report-writing child, separate CLI readback, rejected premature completion, caller evidence, and cleanup after success.
- Include a packaged-consumer regression that executes the demo and verify it in Windows, Linux and macOS CI. No change to completion policy or existing workspace state.

## [0.2.0-beta.1] - 2026-10-26

- **Breaking (new jobs only):** default completion mode is now `attested`; a caller must supply evidence for custom gates, or the mandatory `caller_attestation` when none were configured.
- Add explicit `completionMode: 'exit_only'` / `--completion-mode exit_only` for intentional, clearly labeled exit-code-only jobs; this mode cannot take additional gates.
- Record completion basis (`caller_attested`, `process_exit_only` or explicit legacy basis), prevent bypass when a mandatory gate is missing, and reject idempotency reuse across incompatible contracts.
- Preserve the exact completion requirements of already-persisted v0.1.x jobs without silently rewriting their gates. Add a migration guide and real CLI/file readback, failure, retry and legacy tests.

- Clarify that v0.1.4 does not require an external readback gate by default; caller-submitted evidence is not independently verified.

- Replace generated community-post drafts with a fact-checked, human-authored outreach checklist and a seven-day evidence-based independent trial plan.

## [0.1.4] - 2026-10-26

- Add a read-only, privacy-preserving `arl doctor` for aggregate workspace diagnostics and safe public bug reporting.
- Treat permission-denied process probes as potentially live, preventing unsafe duplicate execution.
- Verify minimum-supported Node.js 20 on Linux in CI alongside the existing Node.js 22 platform matrix.

## [0.1.3] - 2026-10-26

- Stabilize the explicit-retry regression by waiting for worker and child exit before retry; production safety checks remain unchanged.

- Add a real child-spawn/worker-crash fault-injection regression at the exact spawn-before-PID-write boundary, validating no automatic replay and retained resource ownership.

- Block stale worker/launcher PID sightings when persisted heartbeats have expired, retaining resource ownership and requiring operator review.
- Add recovery regression tests using a simulated reused PID and a real terminated worker with an unresolved operation.

- Persist child dispatch intent before process spawn and block uncertain crash-window recovery instead of potentially starting a duplicate child.
- Retain resource ownership until an operator reconciles the unknown dispatch and explicitly retries; add focused regression coverage.

- Treat a reached command deadline as a failure even if the child handles the termination signal and exits successfully; escalate termination if a POSIX child ignores the signal.
- Retain reserved resources when a recovered orphan child remains alive, even after an external operation is reconciled.
- Add focused regressions for deadline handling, resource ownership, and termination behavior.
- Restrict the one-time npm publish workflow to the v0.1.2 release tag, test the checked-out package, and stop on registry errors other than a missing version.

## [0.1.2] - 2026-10-21

- Add tested offline tarball installation and separate consumer CLI smoke test.
- Introduce `--command-file`, `--gate`, `--help`, and `--version` CLI conveniences.
- Add a real CLI caller/session handoff demo that enforces a readback gate.
- Add PowerShell and Bash package-install quickstarts verified by cross-platform CI.
- Publish an adoption/feedback guide with no invented user or integration claims.

## [0.1.1] - 2026-10-21

- Establish public contribution, security, issue triage, and maintenance guidelines.
- Add a preview release and adoption-evidence roadmap.
- Add cross-platform regression cases for missing executables and process timeouts (15 tests).
- Restrict CI workflow permissions to read-only repository contents.

## [0.1.0] - 2026-10-21

- Initial public preview with durable control tasks, runtime jobs, and attempt history.
- Detached Node.js command execution with persistent local state.
- Idempotent task/job acceptance and named resource reservations.
- External operation reconciliation and evidence-based completion gates.
- CLI, isolated integration tests, examples, and MIT license.
- GitHub Actions matrix validated on Windows, Linux, and macOS.

[0.1.0]: https://github.com/Sharky0209/agent-runtime-lite/releases/tag/v0.1.0

# Migrating from v0.1.x to v0.2 beta

**This beta deliberately changes the default completion contract for newly submitted jobs.** It does not migrate, reset or silently rewrite jobs already stored under a workspace's `.arl/state.json`.

The package is still a single-host, local Node.js task runner. It is not an external-verification service, process-tree watchdog or distributed queue.

## New behavior: attested by default

Old code:

```js
const {job} = runtime.submit({
  taskId, key: 'report', command: {exe: 'node', args: ['report.mjs']}
});
```

With v0.1.x, `complete({jobId})` could succeed after a zero process exit without extra evidence. The **same new submission** in v0.2 now persists:

```json
{
  "completionMode": "attested",
  "gates": [
    {"name": "process_exit_zero", "passed": false, "evidence": null},
    {"name": "caller_attestation", "passed": false, "evidence": null}
  ]
}
```

When the job becomes a `completion_candidate`, read and check the actual output first, then explicitly attest:

```js
// Read the real output or external destination in your caller. Abort if invalid.
runtime.passGate({
  jobId: job.id,
  name: 'caller_attestation',
  evidence: 'Checked report.json on disk and verified the totals'
});
runtime.complete({jobId: job.id});
```

The caller must **actually do the check**; the library stores the supplied evidence but cannot verify that it is truthful. If a new job declares custom evidence gates such as `report_file_checked`, these gates **replace** the default `caller_attestation`; all custom gates must pass, without forcing a duplicate confirmation. The built-in process gate remains automatic.

Equivalent CLI after independent readback:

```sh
arl gate --root ./workspace --job JOB_ID --name caller_attestation --evidence "Read actual report and checked totals"
arl complete --root ./workspace --job JOB_ID
```

A successful attested completion stores `completionBasis: "caller_attested"`, which means **caller assertion**, not independently proven external effect.

## Explicit exit-only opt-out

For a command whose *only* desired outcome is a successful exit code:

```js
runtime.submit({
  taskId, key:'syntax-check',
  command:{exe:'node',args:['--check','script.mjs']},
  completionMode:'exit_only'
});
```

or

```sh
arl submit --root ./workspace --task TASK_ID --key syntax-check --command-file command.json --completion-mode exit_only
```

This produces **only** the `process_exit_zero` gate and stores `completionBasis: "process_exit_only"` after completion. That basis must not be described as a checked artifact. Mixing `exit_only` with additional `gates` is rejected.

## Existing persisted workspaces

- v0.1.x jobs that already exist have no `completionMode`; their persisted gates remain unchanged. There is **no automatic gate injection** into in-progress or queued older jobs.
- Old jobs with no extra gate retain the prior exit-code-only behavior. A completion on v0.2 records `completionBasis: "legacy_process_exit_only"`.
- Old jobs with configured custom gates retain them and record `completionBasis: "legacy_configured_gates"` after all persisted gates pass.
- A **new** submission reusing an old job's `taskId + key` with v0.2 defaults will produce `JOB_KEY_PAYLOAD_CONFLICT` instead of silently reusing a different completion contract. Read the previous job by ID, or submit a **new unique job key** if you intend the new contract. Do not hand-edit the old state to make the keys match.
- A v0.2 attested job deduplicates identical submissions with the same key, mode and configuration. Switching its mode with the same key produces a conflict, as intended.
- After a retry, the attestation and any extra gates reset; previous attempt evidence cannot fulfill the new attempt.
- Uncertain external operations must still be reconciled with real evidence regardless of the chosen completion mode.

## Upgrade procedure

1. Back up the existing workspace `.arl/` directory and make sure no long-running job is interrupted by a package swap.
2. Read the current jobs with `arl status --root ./workspace` locally (the full output can contain private commands/evidence; **do not paste it into a public issue**).
3. Install v0.2 beta in an **isolated test project**; run `npm test`, `npm run demo:handoff`, and `node examples/report-file-handoff.mjs` against a test-only workspace.
4. For each submitter, either implement honest output readback plus `caller_attestation`, or deliberately opt out with `exit_only`.
5. Do not assume that calling `gate` without independently checking results makes external effects safe. Consider external operation reconciliation separately.
6. Migrate live callers gradually by using unique keys for new contract jobs, and review existing v0.1 jobs under their old requirements.
7. To roll back, restore the **backed-up state** and the old package together. Do not use an older binary on a workspace containing newly submitted v0.2 attested jobs: that older binary does not know the new contract.

The state-file schema number stays `1` because the new completion fields are additive; **this is API-contract compatibility, not a declaration that old v0.1 binaries understand v0.2 jobs**. The beta makes no promise of full backward binary interoperability.

## Evidence checklist

The CI suite contains process-isolated tests for: default rejection without attestation; custom evidence gates without duplicate attestation; real report creation and independent CLI readback; absence of an output file not automatically passing a gate; explicit exit-only; deduplication conflicts; preserving pre-v0.2 persisted gates; and retry requiring fresh evidence. Tests do not prove that a malicious or buggy caller supplied truthful attestation.

# Public maintenance plan

Maintainer: [Sharky0209](https://github.com/Sharky0209). The project entered public maintenance on **2026-10-21**. It is an early preview, not a production-backed service.

## Regular work

- **Weekly:** inspect new issues, pull requests, CI failures, and dependency/platform notices; respond as capacity allows.
- **For each accepted bug:** reproduce it in an isolated local workspace, add a failing regression test, fix, run cross-platform CI, and summarize the outcome in an issue or release.
- **For each release:** document significant changes, confirm CI on main and the release revision, verify package contents, and update supported version notes.
- **For security reports:** use the private reporting guidance in SECURITY.md.

There is no guaranteed response SLA. Maintenance records should reflect real changes rather than a schedule of meaningless commits.

## Roadmap

**Phase 1 — Stability (2026-10-21 to 2026-11-04)**

1. Improve worker crash and timeout test coverage across all three operating systems.
2. Verify recovery safety and resource ownership under concurrent separate processes.
3. Make CLI error messages and documentation easy for an external user to follow.

**Phase 2 — Usability (2026-11-05 to 2026-11-18)**

1. Add a self-contained external integration example using only public/test data.
2. Resolve incoming bug reports and clarify supported API behavior.
3. Explore a package distribution channel only after installation and example verification.

**Phase 3 — Evidence and review (from 2026-11-19)**

1. Review genuine usage signals (external issues/PRs, reproductions, forks, downloads if a package exists).
2. Collect independent feedback and record any real integration or maintainer activity.
3. Review the project's ecosystem relevance and readiness for open-source maintainer support applications.

**First application-readiness review:** **2026-11-25**. This date is a checkpoint, *not* a claim that eligibility or support is guaranteed. OpenAI evaluates usage, importance, and real active maintenance on a rolling basis. Applying earlier is reasonable if independent evidence becomes strong.

## Indicators worth tracking

- Real external adopters and reproducible user feedback.
- Bugs fixed with regression tests and green CI.
- Maintainer response and release follow-through.
- Reproducible public integrations or other ecosystem value.

Do **not** buy or fabricate stars, downloads, issues, PRs, or endorsements.

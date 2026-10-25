# Independent developer trial kit (v0.2.0-beta.1)

This file is a **fact sheet and operational checklist**, not copy ready to paste into a community. It does not establish that a post, review or independent adoption happened.

## Community rules first

- [Hacker News submission guidelines](https://news.ycombinator.com/newsguidelines.html) say not to automate posting or submit generated text. A human member must decide whether to post and write their own title and description, respond to questions, and observe the community rules.
- [Show HN guidelines](https://news.ycombinator.com/showhn.html) require something other developers can actually try. See also [temporary Show HN restrictions](https://news.ycombinator.com/showlim); a first-time account may not be eligible yet. An ordinary update announcing only a version bump is not a strong Show HN submission.
- [V2EX community guidelines](https://www.v2ex.com/about) also prohibit AI-generated text. The [分享创造 node](https://www.v2ex.com/help/node) welcomes individually built projects, whereas promotion has a different node. The account owner should compose and submit their own original description after reviewing the site's rules.
- No AI-authored or automatically posted copy, fake accounts, bought views/stars or solicited upvotes. Do not share credentials with this project or its maintainer.

## Verifiable facts a human author may choose to cover

- Problem: a command returning successfully is not the same as the intended output having been inspected and accepted.
- Implementation: MIT-licensed, dependency-free Node.js single-host command runner, not an LLM model host, scheduler, durable distributed queue or sandbox.
- Capabilities: keyed task/job de-duplication, durable local JSON state, separate detached worker, explicit output evidence gates, named resource reservations and conservative handling of uncertain external operations.
- Crash limits: a Worker can die during child launch; a persisted dispatch intent prevents blind auto-replay but cannot prove remote side effects or protect against all PID reuse.
- Versions: GitHub preview **v0.2.0-beta.1**, Node.js **20+**, source and packaged CLI verified on Windows, Ubuntu and macOS; a minimum Node.js 20 runner is also checked on Ubuntu.
- Privacy: `arl doctor` only reads state and returns aggregate counts. The full `arl status` can contain private commands and verification evidence.
- Honesty: no independent production users, outside integrations or performance benchmarks have been established by the maintainer.
- Interesting discussion questions: what completion evidence would a real task need, what environment or command would be tried, and which recovery decisions require a person?

## Trial entry points

- Source: https://github.com/Sharky0209/agent-runtime-lite
- Release: https://github.com/Sharky0209/agent-runtime-lite/releases/tag/v0.2.0-beta.1
- Quickstart: https://github.com/Sharky0209/agent-runtime-lite/blob/main/docs/QUICKSTART.md
- Architecture/limits: https://github.com/Sharky0209/agent-runtime-lite/blob/main/docs/ARCHITECTURE.md
- Read-only diagnosis: https://github.com/Sharky0209/agent-runtime-lite/blob/main/docs/TROUBLESHOOTING.md
- Feedback: https://github.com/Sharky0209/agent-runtime-lite/issues/3

Clean-directory install (Node.js 20+ required; **GitHub Release tarball**, not the npm registry):

```sh
npm init -y
npm install --save-dev https://github.com/Sharky0209/agent-runtime-lite/releases/download/v0.2.0-beta.1/agent-runtime-lite-0.2.0-beta.1.tgz
npm exec -- arl --version
npm exec -- arl doctor --root ./trial-state
```

Run the real detached-process and readback example from a clone:

```sh
git clone https://github.com/Sharky0209/agent-runtime-lite.git
cd agent-runtime-lite
npm run demo:handoff
node examples/report-file-handoff.mjs
```

The demo illustrates **CLI caller handoff**; it does not guarantee automatic recovery from every crash or a machine restart.

## Seven-day independent-trial procedure

| Day | Maintainer action | Evidence to record |
| --- | --- | --- |
| 1 | Check tagged archive, install instructions, CI and feedback issue | Release URL, green CI URL and independent packaged-install readback |
| 2 | If an eligible member is available, let them personally write an original V2EX or HN introduction following the site's rules | Actual public post URL; if not posted, record `not published` |
| 3–4 | Read incoming public comments, questions and reproduction details | Links to real external reports, OS/Node version, whether the report reproduces |
| 5 | Prioritize blockers that keep developers from trying the tool | Issue IDs, narrow reproduction, test results and fix link when one exists |
| 6 | Recheck documented steps in a new temporary directory | Exact version, installed CLI, absence of secret data in diagnostics |
| 7 | Summarize what was actually learned; decide continue/pivot | External trials confirmed with consent, real reports fixed, unresolved blockers and next decision |

The goal of three independent feedback reports is an **aspiration**, not an announced result. A clone, download, page view or maintainer-run CI is not evidence of a real outside user. Only a voluntary, attributable report from an unrelated developer or permissioned project integration counts as verified adoption.

## Reporting and conduct

Ask for the smallest anonymized reproduction. Never request a token, password, customer record or unredacted `arl status`. Respond to critique with concrete data; do not argue with feedback or create promotional reply chains. If a platform or account is not eligible, **do not bypass it**. Use the project's own GitHub feedback issue and wait for genuine interest.

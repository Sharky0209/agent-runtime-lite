# Contributing

Thank you for helping improve Agent Runtime Lite. Contributions from real-world users and maintainers are welcome.

## Before opening a change

1. Search existing [issues](https://github.com/Sharky0209/agent-runtime-lite/issues) and pull requests.
2. For a bug, include Node.js version, OS, a minimal reproducible command, observed result, and expected result. Remove access tokens, private paths, and business data from logs.
3. For larger changes, discuss scope in an issue first. The project intentionally remains a small single-host runtime.

## Local setup

- Node.js >=20; CI exercises the minimum supported Node.js 20 on Ubuntu and Node.js 22 on Windows, macOS and Ubuntu.
- No npm install step is required for development: there are no third-party runtime dependencies.
- Run `npm test` and `npm run example`.
- Every bug fix should include a regression test. Keep tests deterministic, offline, and isolated in temporary directories.

## Pull requests

Use a focused title, link the relevant issue, describe behavioral changes, and include test evidence. Changes involving job recovery, external effects, process ownership, or persistence must explain how they avoid duplicate execution and unverified completion.

Maintainers review contributions for correctness, portability, privacy, and backward compatibility. A passing CI result is necessary but not sufficient for merging.

## Scope

The public repository contains only general-purpose runtime code. Do not submit proprietary code, credentials, customer information, internal automation rules, or logs containing sensitive data.

Please report suspected security vulnerabilities privately; see [SECURITY.md](SECURITY.md).

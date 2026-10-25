# npm beta publication: safety gates and required account authorization

Current status: **no public npm Registry package has been confirmed**, and this repository is distributed via its tested GitHub Release archive. Version `0.2.0-beta.2` is a **prerelease**. Never describe it as stable or claim a successful npm publication until a separate registry readback confirms it.

## Repository release contract

- Package: `agent-runtime-lite`
- Approved GitHub source tag: `v0.2.0-beta.2` (the source for this exact npm version)
- Repository: `Sharky0209/agent-runtime-lite`
- Manual GitHub Actions workflow: `.github/workflows/publish.yml`
- Default workflow mode: **`validate`** — executes read-only registry checks, source tests, independently installed package tests, and package file inspection; **never invokes `npm publish`**.
- Opt-in workflow mode: **`publish`** — first repeats all checks, then invokes `npm publish --access public --tag beta --provenance --ignore-scripts`, and finally reads back the exact version. The workflow always checks out `v0.2.0-beta.2`; it does not publish unreviewed main branch changes.
- A published npm version is immutable. If the exact version already exists, the workflow stops rather than overwriting it.
- The `beta` dist-tag is required so `npm install agent-runtime-lite` does **not** unexpectedly track a preview. Only `npm install agent-runtime-lite@beta` or an exact beta version should select it.
- Source and package testing use GitHub-hosted runners. The release workflow uses Node.js 24 and recent npm; the normal cross-platform CI independently exercises Node.js 20 and 22.
- We do **not** store npm credentials or sensitive publish logs in the repository, documentation, or issue comments.

## First publication requires the owner's npm authorization

GitHub ownership alone does **not** authorize npm registry publication. As of the initial audit, `npm whoami` returned `E401`, public `npm view agent-runtime-lite` returned `E404`, and there was no `NPM_PUBLISH_TOKEN` repository secret. An `E404` does not permanently reserve the name: the registry must be checked again immediately before publishing.

**Option A — One-time local bootstrap, then trusted publishing (recommended):**

1. The actual package owner signs in to their own npmjs.com account, enables 2FA, and uses `npm login` locally (complete all browser/authenticator steps themselves; **never paste OTPs, passwords or npm tokens into ChatGPT**).
2. Confirm `npm whoami` prints the intended npm account. Verify the package name is available. If another party owns the name, **stop** — do not attempt to overwrite it.
3. Make a clean temporary checkout of the reviewed `v0.2.0-beta.2` tag; verify `package.json` lists the exact version, run `npm test`, `npm run test:package`, and inspect `npm pack --dry-run --json`. Do not publish whatever happens to be in a modified local worktree.
4. After inspecting the package contents, perform the authorized initial public **beta-only** publish from the exact tagged source using `npm publish --access public --tag beta --ignore-scripts`. Do not include `--provenance` unless the local environment actually supports a provenance provider.
5. Independently read `npm view agent-runtime-lite@0.2.0-beta.2 version` and `npm view agent-runtime-lite dist-tags --json`; confirm that `beta` points to `0.2.0-beta.2` and no unintentional `latest` was introduced.
6. Now that a package exists, its owner can configure npm **Trusted Publisher** in the npmjs.com package settings: GitHub owner `Sharky0209`, repository `agent-runtime-lite`, workflow filename `publish.yml`; enable direct publish only if wanted. Configuration must be used successfully within npm's validation window. Future reviewed versions can use GitHub Actions' OIDC without storing a long-lived token.

**Option B — Manually authorized GitHub Actions bootstrap:**

- A maintainer creates an appropriate, time-limited npm **granular access token** (with publish permission and any required 2FA/bypass setting) inside npmjs.com and saves it as the GitHub repository Actions secret named `NPM_PUBLISH_TOKEN`. The secret value must never be displayed in logs or this chat.
- In Actions, select **Verify npm release (manual, publish opt-in)** and first dispatch with `mode=validate`. Check that it prints `VALIDATE_ONLY_PASS` and **no version appears in npm**.
- Only once the correct npm account and package permissions have been confirmed, explicitly dispatch `mode=publish`. It publishes with `--tag beta` and attempts provenance generation.
- Revoke the bootstrap token after successful publication and migration to npm trusted publishing.

**Either path needs the owner's real npm account authorization. Do not trigger `mode=publish` to guess credentials.**

## For all later releases

Release with a new reviewed version and tag (never recycle `v0.2.0-beta.2`). Update the hardcoded `ref`, package-name/version guard, and registry checks together in the manual publish workflow; open a PR and wait for all required CI before merging. Keep `validate` as the default, and keep the beta dist-tag for all prerelease versions.

After verifying a trusted publisher, prefer disabling token-based publishing on npm. Trusted publishing requires an npm CLI that supports OIDC, a supported GitHub-hosted runner and `id-token: write`. See the [official npm trusted publishers guide](https://docs.npmjs.com/trusted-publishers/).

## Evidence standard

Record three separate things, and do not conflate them:

1. **CI package passes** — only indicates build/CLI tests passed.
2. **Registry version & dist-tag readback** — establishes that a package version is publicly available at npm.
3. **Independent external user report** — only a real unrelated developer reporting a successful use/integration, not a download, star, clone, maintainer-run demo or CI.

If authentication fails, do not post secret values or retry in a loop. Stop at the first explicit account action and keep distributing the verified GitHub release tarball.

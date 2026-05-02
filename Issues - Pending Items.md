# Issues - Pending Items

## Pending

### `package.json#exports` is not alphabetized

Acceptance criterion §7 #6 ("`package.json#exports` keys are alphabetically sorted; both new entries present") is not literally satisfied — the existing keys (`docker`, `vercel`, `podman`, `daytona`) are not alphabetical to begin with, and the new entries (`apple-containers`, `github-codespaces`) were inserted between `daytona` and `no-sandbox` rather than alphabetically. Pre-existing ordering inconsistency, not a regression. Recommendation: alphabetize all keys in a follow-up.

### Pre-existing test failures unrelated to apple-containers / github-codespaces rollout

The following test failures were observed during the integration verification of the apple-containers and github-codespaces providers but were confirmed to be pre-existing on `main` (reproduced after stashing all integration changes). They should be triaged separately.

- `src/sandboxes/podman.test.ts` — 17 failures around `podman()` mount formatting, `--userns`, `--user`, `--network`, and `copyFileIn` / `copyFileOut` argv. These appear to be assertions about exact argv strings that do not match the current implementation.
- `src/sandboxes/test-bind-mount.test.ts`, `src/sandboxes/test-isolated.test.ts`, `src/sandboxes/no-sandbox.test.ts > exec respects cwd option` — macOS `/tmp` vs `/private/tmp` symlink resolution causing `expected '/private/tmp' to be '/tmp'` assertion mismatches.
- `src/PromptPreprocessor.test.ts > runs commands with the provided cwd`, `src/SandboxLifecycle.test.ts > runHostHooks > uses the provided cwd`, `src/interactive.test.ts > without cwd behaves identically to process.cwd()` — same `/private/tmp` macOS issue.
- `src/WorktreeManager.test.ts`, `src/createSandbox.test.ts`, `src/createWorktree.test.ts` — 7 failures around worktree reuse semantics (clean / dirty / unpushed / mid-rebase). Cause not investigated; pre-existing.

### Build dependency: `@daytona/sdk` not installed automatically

`@daytona/sdk` is declared as an optional peer dependency in `package.json`. With the project's current `package-lock.json`, `npm install` does not install it, which causes `tsgo --project tsconfig.build.json` to fail with `TS2307: Cannot find module '@daytona/sdk'` (because `tsconfig.json` sets `noEmitOnError: true`). To produce `dist/`, the SDK must be installed manually (e.g. `npm install --no-save @daytona/sdk@0.164.0` in a clean directory and copying into `node_modules/@daytona`). Investigate whether `@daytona/sdk` should be moved to `devDependencies` or whether the `daytona.ts` provider should `// @ts-expect-error` the missing import for the optional-peer case.

### 7 moderate `uuid` CVEs (transitive via Effect.ts ecosystem)

`npm audit` reports seven moderate-severity advisories chained from `uuid <14.0.0` (GHSA-w5hq-g745-h8pq) through `@effect/sql` → `@effect/experimental` → `@effect/cluster` → `@effect/workflow` → `@effect/platform-node` → `@effect/platform-node-shared`. The only npm-proposed fix is a major downgrade of `@effect/platform-node` from `0.105.0` to `0.75.4`, which is a breaking change against the project's declared `^0.105.0` requirement. Practical exploitability is low because the advisory only affects `uuid.v3/v5/v6` with an explicit `buf` arg, while Effect.ts uses `v4`/`v7`. See `docs/reference/dependency-validation-apple-containers-codespaces.md` §4.1. Recommendation: monitor `@effect/sql` releases for a `uuid ^14` peer-range update, or evaluate an `npm overrides` shim.

## Completed

### CLI namespaces for apple-containers and github-codespaces — design amended to match owner decision

Originally flagged as a deviation from ADR §6.10. Resolved 2026-05-02: project owner directed during design review that CLI namespaces should mirror docker/podman for parity. `docs/design/project-design.md` ADRs §6.10 and §6.11 amended to record the inclusion of `apple-containers build-image` / `remove-image`, `github-codespaces verify`, and `init`-registry rows for both providers. No code revert needed.

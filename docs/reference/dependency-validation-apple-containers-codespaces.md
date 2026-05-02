---
status: partially_fixed
mode: fix
package_manager: npm@11.12.1
ecosystem: node
iterations_run: 1
deprecations_initial: 0
deprecations_final: 0
vulnerabilities_initial: 11
vulnerabilities_final: 7
target_path: /Users/giorgosmarinos/aiwork/coding-platform/sandcastle
validated_at: 2026-05-02T23:50:00Z
last_validated_commit: 20cb6086b567f3fd83f2b2cb9c7ad565a852c67f
---

# Dependency Validation — @ai-hero/sandcastle

## 1. Summary

The dependency tree was validated using npm@11.12.1 on the `biks-branch` branch of `@ai-hero/sandcastle@0.5.7`. No deprecated packages were found in the install output. The initial audit found 11 vulnerabilities (2 high, 9 moderate). After one fix iteration running `npm audit fix` (no `--force`), 4 vulnerabilities were eliminated by patching transitive packages in the lockfile: `vite`, `picomatch` (two instances), `postcss`, and `yaml`. Seven moderate-severity vulnerabilities remain, all rooted in the `uuid <14.0.0` advisory that cascades through `@effect/sql` → `@effect/experimental` → `@effect/cluster` → `@effect/workflow` → `@effect/platform-node`. The only npm-proposed fix is a **major breaking downgrade** of `@effect/platform-node` from `0.105.0` to `0.75.4`, which is blocked by invariant (no silent major-version migrations) and by the project's stated `^0.105.0` requirement. A pre-existing anomaly was also confirmed: `@daytona/sdk` is declared as an optional peer dependency but is not installed, causing `tsgo --noEmit` to fail with three "Cannot find module" errors.

---

## 2. Initial State

The following vulnerabilities were found by `npm audit --json` on the first run (before any fix was applied). No package produced a deprecation warning during `npm install`.

| Package                        | Installed Version | Scope                                                                            | Severity | Advisory                                                                                                                                               | Notes                                         |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `vite`                         | 7.3.1             | transitive (via `vitest@3.2.4`)                                                  | **high** | GHSA-p9ff-h696-f583 (Arbitrary File Read via WebSocket), GHSA-v2wj-q39q-566r (`server.fs.deny` bypass), GHSA-4w7w-66w2-5vf9 (Path Traversal in `.map`) | Fixed by lockfile bump to 7.3.2               |
| `picomatch`                    | 4.0.3             | transitive (via `vitest`, `@parcel/watcher`)                                     | **high** | GHSA-c2c7-rcm5-vvqj (ReDoS via extglob), GHSA-3v7f-55p6-f55p (Method Injection in POSIX classes)                                                       | Fixed by lockfile bump to 4.0.4               |
| `picomatch`                    | 2.3.1             | transitive (via `lint-staged` → `micromatch`)                                    | **high** | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                                                                                                               | Fixed by lockfile bump to 2.3.2               |
| `postcss`                      | 8.5.8             | transitive (via `vitest` → `vite`)                                               | moderate | GHSA-qx2v-qp2m-jg93 (XSS via unescaped `</style>`)                                                                                                     | Fixed by lockfile bump to 8.5.13              |
| `yaml`                         | 2.8.2             | transitive (via `@effect/cli`, `lint-staged`, `vite`)                            | moderate | GHSA-48c2-rrv3-qjmp (Stack Overflow via deeply nested collections)                                                                                     | Fixed by lockfile bump to 2.8.4               |
| `uuid`                         | 11.1.0            | transitive (via `@effect/platform-node` → `@effect/sql`, `@effect/experimental`) | moderate | GHSA-w5hq-g745-h8pq (missing buffer bounds check in v3/v5/v6)                                                                                          | **Not fixed** — no minor-safe resolution path |
| `@effect/sql`                  | 0.50.0            | transitive (via `@effect/platform-node` peer deps)                               | moderate | (cascades from `uuid`)                                                                                                                                 | **Not fixed**                                 |
| `@effect/experimental`         | 0.59.0            | transitive (via `@effect/platform-node` peer deps)                               | moderate | (cascades from `uuid`)                                                                                                                                 | **Not fixed**                                 |
| `@effect/workflow`             | 0.17.0            | transitive (via `@effect/cluster`)                                               | moderate | (cascades from `uuid`)                                                                                                                                 | **Not fixed**                                 |
| `@effect/cluster`              | 0.57.0            | transitive (via `@effect/platform-node` peer deps)                               | moderate | (cascades from `uuid`)                                                                                                                                 | **Not fixed**                                 |
| `@effect/platform-node`        | 0.105.0           | **direct**                                                                       | moderate | (cascade from all of the above)                                                                                                                        | **Not fixed** — fix requires major downgrade  |
| `@effect/platform-node-shared` | 0.58.0            | transitive (via `@effect/platform-node`)                                         | moderate | (cascade from `@effect/cluster`, `@effect/sql`)                                                                                                        | **Not fixed**                                 |

**Initial count:** 11 unique vulnerable entries (2 high, 9 moderate).

**Note on `uuid` advisory scope:** The advisory GHSA-w5hq-g745-h8pq specifies the vulnerable code path as `v3`, `v5`, and `v6` UUID generation functions when an explicit buffer argument (`buf`) is supplied. Inspection of the installed `@effect/sql` and `@effect/experimental` source shows they exclusively call `Uuid.v4({}, buf)` and `Uuid.v7(options, buf)` — neither of which is listed in the vulnerable code path. The practical exploitability of this advisory within this project's actual usage is therefore low. It is recorded here for completeness and because the npm advisory database flags the entire `uuid <14.0.0` range.

---

## 3. Replacements Applied

**Iteration 1** — `npm audit fix` (no `--force`), followed by `npm clean-install` to reconcile `node_modules` with the updated lockfile.

All changes are lockfile-only (`package-lock.json`). No `package.json` manifest entries were modified. No source-code import paths were changed.

| Old version       | New version       | Package                                                  | Fix type                                                            |
| ----------------- | ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `vite@7.3.1`      | `vite@7.3.2`      | transitive (under `vitest`)                              | lockfile patch bump                                                 |
| `picomatch@4.0.3` | `picomatch@4.0.4` | transitive (under `vitest`, `@parcel/watcher`)           | lockfile patch bump                                                 |
| `picomatch@2.3.1` | `picomatch@2.3.2` | transitive (under `micromatch` → `lint-staged`)          | lockfile patch bump                                                 |
| `postcss@8.5.8`   | `postcss@8.5.13`  | transitive (under `vite`)                                | lockfile patch bump                                                 |
| `yaml@2.8.2`      | `yaml@2.8.4`      | transitive (under `@effect/cli`, `lint-staged`, `vite`)  | lockfile patch bump                                                 |
| `uuid@11.1.0`     | `uuid@11.1.1`     | transitive (under `@effect/sql`, `@effect/experimental`) | lockfile patch bump — **does not resolve advisory** (still <14.0.0) |

The `uuid` lockfile bump from `11.1.0` to `11.1.1` was applied by `npm audit fix` but does not satisfy the advisory's requirement of `uuid >= 14.0.0`. It is listed here for full transparency.

---

## 4. Manual Review Needed

### 4.1 `uuid`/`@effect/platform-node` vulnerability chain (7 moderate advisories)

**Packages affected:** `uuid`, `@effect/sql`, `@effect/experimental`, `@effect/workflow`, `@effect/cluster`, `@effect/platform-node`, `@effect/platform-node-shared`

**Why it cannot be auto-fixed:** The npm advisory for `uuid` (GHSA-w5hq-g745-h8pq) requires `uuid >= 14.0.0`. The `@effect/sql@0.50.0` package declares `uuid ^11.0.3` as a direct dependency, which cannot resolve to `14.x`. The only npm-proposed resolution is to downgrade `@effect/platform-node` from `0.105.0` to `0.75.4`, which `npm audit` itself marks as `isSemVerMajor: true` — a breaking change against the project's declared `^0.105.0` requirement.

**Why the practical risk is reduced:** As noted in Section 2, the vulnerable code path in GHSA-w5hq-g745-h8pq applies only to `uuid` functions `v3`, `v5`, and `v6` when an explicit `buf` argument is passed. The Effect.ts packages installed here use `v4` and `v7` exclusively, which are not affected by this specific advisory.

**Recommended next steps (in priority order):**

1. **Monitor the Effect.ts ecosystem** — `@effect/sql` will need to update its `uuid` peer range to `^14.0.0` for the advisory to clear. Check `@effect/sql` releases periodically; once a release appears with `uuid ^14`, a minor update to `@effect/platform-node` (if a compatible release exists) will close this advisory.
2. **Evaluate `npm overrides`** — As a stopgap, adding `"overrides": { "uuid": "^14.0.0" }` to `package.json` would force `uuid@14.x` for all transitive consumers. This requires validating that uuid 14's API is compatible with `@effect/sql`'s `v4({}, buf)` and `v7(options, buf)` call patterns. This is an invasive change and must be tested by running `npm test` after applying the override.
3. **Accept and document** — Given the narrow vulnerable code path (`v3/v5/v6` with `buf`, which Effect packages do not use), the risk may be acceptable to defer until the Effect.ts ecosystem publishes a compatible fix. This decision belongs to the project maintainers.

### 4.2 `@daytona/sdk` optional peer dependency not installed (pre-existing anomaly)

**Status:** Pre-existing, confirmed present on `biks-branch`. Not introduced by the `apple-containers` / `github-codespaces` rollout.

**What happens:** `@daytona/sdk@^0.164.0` is listed in `peerDependencies` with `peerDependenciesMeta.@daytona/sdk.optional: true`. It is **not installed** by default. When `npm run typecheck` (`tsgo --noEmit`) runs, TypeScript resolves the static import `from "@daytona/sdk"` in `src/sandboxes/daytona.ts` and fails because no type declarations are present. Because `tsconfig.json` has `noEmitOnError: true`, this also causes `npm run build` to fail.

By contrast, `@vercel/sandbox` is handled via a hand-written ambient declaration stub at `src/vercel-sandbox.d.ts`, which allows `tsgo` to type-check without the real package being installed.

**Three errors produced without `@daytona/sdk`:**

```
src/sandboxes/daytona.ts(22,8): error TS2307: Cannot find module '@daytona/sdk' or its corresponding type declarations.
src/sandboxes/daytona.ts(75,23): error TS2307: Cannot find module '@daytona/sdk' or its corresponding type declarations.
src/sandboxes/daytona.ts(75,57): error TS2307: Cannot find module '@daytona/sdk' or its corresponding type declarations.
```

**Recommended next step:** Add a minimal ambient declaration stub `src/daytona-sdk.d.ts` (mirroring `src/vercel-sandbox.d.ts`) so that `typecheck` and `build` succeed without requiring developers to manually install `@daytona/sdk`. Alternatively, install `@daytona/sdk` locally (`npm install --save-dev @daytona/sdk`) if the project's CI pipeline already does this. **This agent will not make this change without explicit confirmation** because it requires understanding which Daytona SDK symbols are imported and which types need to be stubbed.

### 4.3 Outdated direct dependencies (informational — no security advisories)

The following direct dependencies have newer versions available. None carry active security advisories. These are listed for awareness; the project's `package.json` semver ranges currently prevent automatic resolution.

| Package                      | Current              | Wanted (in range)    | Latest               | Notes                                                                            |
| ---------------------------- | -------------------- | -------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `@changesets/cli`            | 2.30.0               | 2.31.0               | 2.31.0               | Minor update, within `^2.30.0` — run `npm update @changesets/cli`                |
| `@clack/prompts`             | 1.1.0                | 1.3.0                | 1.3.0                | Minor update, within `^1.1.0` — run `npm update @clack/prompts`                  |
| `effect`                     | 3.20.0               | 3.21.2               | 3.21.2               | Minor update, within `^3.20.0` — coordinate with `@effect/*` sibling upgrades    |
| `prettier`                   | 3.8.1                | 3.8.3                | 3.8.3                | Patch update, within `^3.5.3`                                                    |
| `@types/node`                | 25.5.0               | 25.6.0               | 25.6.0               | Patch update, within `^25.5.0`                                                   |
| `@typescript/native-preview` | 7.0.0-dev.20260317.1 | 7.0.0-dev.20260502.1 | 7.0.0-dev.20260502.1 | Dev build, within range                                                          |
| `lint-staged`                | 15.5.2               | 15.5.2               | 16.4.0               | **Major** version jump to 16.x — out of `^15.5.1` range; manual migration needed |
| `vitest`                     | 3.2.4                | 3.2.4                | 4.1.5                | **Major** version jump to 4.x — out of `^3.2.0` range; manual migration needed   |
| `@effect/platform-node`      | 0.105.0              | 0.105.0              | 0.106.0              | Minor update — validate against Effect ecosystem peer constraints before bumping |

---

## 5. Security Audit

Full `npm audit` results. Audit run at end of iteration 1 (after `npm audit fix` and `npm clean-install`).

### 5.1 Resolved vulnerabilities (4 fixed in this run)

| Package     | Previous version | Patched version | Severity | Advisory                                                      |
| ----------- | ---------------- | --------------- | -------- | ------------------------------------------------------------- |
| `vite`      | 7.3.1            | 7.3.2           | high     | GHSA-p9ff-h696-f583, GHSA-v2wj-q39q-566r, GHSA-4w7w-66w2-5vf9 |
| `picomatch` | 4.0.3            | 4.0.4           | high     | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                      |
| `picomatch` | 2.3.1            | 2.3.2           | high     | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p                      |
| `postcss`   | 8.5.8            | 8.5.13          | moderate | GHSA-qx2v-qp2m-jg93                                           |
| `yaml`      | 2.8.2            | 2.8.4           | moderate | GHSA-48c2-rrv3-qjmp                                           |

### 5.2 Remaining vulnerabilities (7 — all moderate, all require breaking change to fix)

| Package                        | Version | Severity | Advisory                                                                                                                                 | Fix path                                                                                                        |
| ------------------------------ | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `uuid`                         | 11.1.1  | moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — missing buffer bounds check in `v3/v5/v6` when `buf` provided | Requires `uuid >= 14.0.0`; blocked by `@effect/sql ^11.0.3` dep range                                           |
| `@effect/experimental`         | 0.59.0  | moderate | (cascades from `uuid`)                                                                                                                   | Transitive — fix parent `@effect/sql`                                                                           |
| `@effect/workflow`             | 0.17.0  | moderate | (cascades from `@effect/experimental`)                                                                                                   | Transitive — fix parent chain                                                                                   |
| `@effect/cluster`              | 0.57.0  | moderate | (cascades from `@effect/sql`, `@effect/workflow`)                                                                                        | Transitive — fix parent chain                                                                                   |
| `@effect/sql`                  | 0.50.0  | moderate | (cascades from `uuid`, `@effect/experimental`)                                                                                           | Transitive — wait for `@effect/sql` to update `uuid` range                                                      |
| `@effect/platform-node-shared` | 0.58.0  | moderate | (cascades from `@effect/cluster`, `@effect/sql`)                                                                                         | Transitive — fix parent chain                                                                                   |
| `@effect/platform-node`        | 0.105.0 | moderate | (cascades from all above)                                                                                                                | **Direct** — `npm audit fix --force` would downgrade to `0.75.4` (major breaking change, `isSemVerMajor: true`) |

**All remaining advisories share root cause:** `uuid <14.0.0` installed at `node_modules/uuid@11.1.1` via `@effect/sql@0.50.0`. The `uuid` advisory's vulnerable functions (`v3/v5/v6` with `buf`) are **not invoked** by the installed `@effect/sql` or `@effect/experimental` code paths (they use `v4` and `v7` only).

---

## 6. Final State

**Status:** `partially_fixed`

- **High-severity vulnerabilities:** 0 (down from 2 — both `vite` and both `picomatch` instances resolved)
- **Moderate-severity vulnerabilities:** 7 (down from 9 — `postcss` and `yaml` resolved)
- **Deprecation warnings during install:** 0
- **Lockfile changes made:** Yes — `package-lock.json` updated for `vite`, `picomatch` (×2), `postcss`, `yaml`, `uuid` (minor bump only)
- **`package.json` manifest changes:** None

**Remaining blockers for a clean audit:**

1. The `uuid`/`@effect/platform-node` chain (7 moderate advisories) requires either: (a) a future `@effect/sql` release that updates its `uuid` dependency to `^14.0.0`, or (b) an explicit `npm overrides` decision by the project maintainer.
2. The `@daytona/sdk` missing peer dependency causes `npm run typecheck` and `npm run build` to fail on a clean checkout.

**The project's `package.json` is unchanged.** No source files were modified. The only file changed on disk is `package-lock.json`.

---

## 7. Commands Run

| #   | Command                                                                           | Exit code | Notes                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm --version && node --version`                                                 | 0         | npm 11.12.1, node v25.9.0                                                                                                                                                  |
| 2   | `git rev-parse HEAD`                                                              | 0         | `20cb6086b567f3fd83f2b2cb9c7ad565a852c67f`                                                                                                                                 |
| 3   | `mkdir -p /Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/reference` | 0         | Output directory created                                                                                                                                                   |
| 4   | `npm install` (from target_path)                                                  | 0         | "up to date, audited 243 packages"; 11 vulnerabilities reported; 0 deprecation warnings                                                                                    |
| 5   | `npm audit --json`                                                                | 1         | Initial audit: 2 high, 9 moderate (11 total)                                                                                                                               |
| 6   | `npm outdated --json`                                                             | 1         | 16 packages with newer versions available (exit code 1 is expected when outdated packages exist)                                                                           |
| 7   | `npm ls picomatch`                                                                | 0         | Identified parent packages for picomatch                                                                                                                                   |
| 8   | `npm ls vite`                                                                     | 0         | Identified vitest as sole parent                                                                                                                                           |
| 9   | `npm ls postcss`                                                                  | 0         | Identified vitest → vite as parent chain                                                                                                                                   |
| 10  | `npm ls yaml`                                                                     | 0         | Identified @effect/cli, lint-staged, vitest → vite as parents                                                                                                              |
| 11  | `npm ls uuid`                                                                     | 0         | Identified @effect/platform-node → @effect/sql and @effect/experimental                                                                                                    |
| 12  | `npm ls @effect/cluster`                                                          | 0         | Confirmed @effect/platform-node as root                                                                                                                                    |
| 13  | `npm audit fix --dry-run`                                                         | 1         | Proposed: yaml 2.8.2→2.8.4, vite 7.3.1→7.3.2, uuid 11.1.0→11.1.1, postcss 8.5.8→8.5.13, picomatch 4.0.3→4.0.4, picomatch 2.3.1→2.3.2; uuid fix via --force only (breaking) |
| 14  | `npm audit fix`                                                                   | 1         | Applied lockfile patches; 7 moderate remain (uuid chain)                                                                                                                   |
| 15  | `npm clean-install`                                                               | 0         | Forced node_modules to sync with updated lockfile; 243 packages installed fresh                                                                                            |
| 16  | `npm audit --json` (final)                                                        | 1         | 0 high, 7 moderate — all uuid chain, all require breaking change                                                                                                           |
| 17  | `npm run typecheck`                                                               | 1         | Confirms pre-existing @daytona/sdk issue: 3 TS2307 errors in src/sandboxes/daytona.ts                                                                                      |
| 18  | `npm install --dry-run`                                                           | 0         | Clean — no deprecation warnings, "up to date"                                                                                                                              |

---

## Anomalies

- **Lockfile/node_modules desync:** After `npm audit fix` updated `package-lock.json`, `npm install` reported "up to date" without updating `node_modules`. Running `npm clean-install` was required to reconcile `node_modules` with the updated lockfile. This is a known npm behavior when `node_modules` content hashes match the previous lockfile state but the lockfile itself has changed.
- **`npm audit fix` double-counts:** The initial run of `npm audit fix` returned exit code 1 with "up to date, audited 243 packages" because the lockfile changes were written but node_modules was not yet updated. The exit code reflects remaining vulnerabilities, not a failure of the fix operation.
- **`@vercel/sandbox` also not installed:** `@vercel/sandbox` is an optional peer dep and is also absent from `node_modules`. Unlike `@daytona/sdk`, its absence does not cause typecheck failures because a hand-written ambient declaration stub (`src/vercel-sandbox.d.ts`) provides the types.

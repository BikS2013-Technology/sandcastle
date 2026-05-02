# Plan 001 — Add `apple-containers` and `github-codespaces` Sandbox Providers

**Status**: Ready for execution (Phase 6 parallel implementation)
**Source request**: `docs/design/requirements-001-apple-containers-and-codespaces-providers.md`
**Investigation**: `docs/reference/investigation-apple-containers-codespaces.md`
**Codebase scan**: `docs/reference/codebase-scan-apple-containers-codespaces.md`
**Research**: `docs/research/effect-shell-out-patterns.md`, `docs/research/codespaces-lifecycle.md`
**Target package**: `@ai-hero/sandcastle@0.5.7` (pre-1.0, ESM, TypeScript, Effect.ts 3.20)

---

## 0. Open Issues / Decisions Already Locked-In by the Orchestrator

The orchestrator pre-decided the following — **do not re-ask the user**:

- Full implementation (no design-only).
- Both `existing` and `managed` modes for `github-codespaces`.
- `apple-containers` mirrors the `docker.ts` / `podman.ts` shape (bind-mount).
- Use the **podman pattern** (inline pre-flight helpers; no separate `*Lifecycle.ts` module) for both new providers.
- Signal handlers (`process.on("exit"/"SIGINT"/"SIGTERM")`) are **mandatory** for managed-mode codespaces and required for apple-containers.

### Open issues flagged for the user (non-blocking — decisions noted inline)

| #   | Issue                                                                                                                       | Decision applied in this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Re-decide?                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | `gh codespace exec` does **not** exist (refutes requirements doc A3).                                                       | Use `gh codespace ssh -c <name> -- <cmd>` exclusively. No fallback / version detection.                                                                                                                                                                                                                                                                                                                                                                                                                       | No — investigation is conclusive.                                                                                                                                                            |
| O2  | `IsolatedSandboxHandle.exec` already accepts `stdin?: string` (codebase scan was wrong).                                    | No interface change to `SandboxProvider.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No — verified by investigation against `src/SandboxProvider.ts:101–124`.                                                                                                                     |
| O3  | Apple `container` has no `cp` subcommand.                                                                                   | Bind-mount makes the boundary transparent: `copyFileIn`/`copyFileOut` use `node:fs/promises` (`copyFile` + `mkdir`) directly against the host worktree.                                                                                                                                                                                                                                                                                                                                                       | No.                                                                                                                                                                                          |
| O4  | `gh codespace start` is not in current `gh` manual; `gh api POST /user/codespaces/<name>/start` is the canonical REST path. | For `mode: "existing"`, use `gh api --method POST /user/codespaces/<name>/start` to start a stopped Codespace, then poll `gh codespace view`.                                                                                                                                                                                                                                                                                                                                                                 | No — research §"Start a stopped Codespace" is conclusive.                                                                                                                                    |
| O5  | `package.json#exports` is a **shared file** between Unit A and Unit B.                                                      | **Unit C owns all `package.json` edits.** Units A and B do **not** touch `package.json`. Unit C adds both export entries together in one alphabetised block.                                                                                                                                                                                                                                                                                                                                                  | No.                                                                                                                                                                                          |
| O6  | `errors.ts` is a shared file.                                                                                               | Each provider declares its `Data.TaggedError` class **inside its own provider file** (e.g. `src/sandboxes/apple-containers.ts`) and re-exports it. **No edits to `src/errors.ts`** by either provider unit.                                                                                                                                                                                                                                                                                                   | No.                                                                                                                                                                                          |
| O7  | `gh codespace ssh` emits SSH banner noise on stderr.                                                                        | Tests must not assert exact stderr content — only exit code.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No.                                                                                                                                                                                          |
| O8  | `keepOnFailure` requires the provider to know whether the run failed.                                                       | The `IsolatedSandboxHandle.close()` does not currently receive a "failure" flag from the orchestrator. The provider treats `keepOnFailure: true` as **"keep across signal-driven cleanup only"**: the signal handlers (SIGINT / SIGTERM) skip deletion when `keepOnFailure: true`. Normal `close()` always deletes. Document this clearly in JSDoc and in `Issues - Pending Items.md` as a known limitation; a fuller wiring of `runFailed → close()` is out of scope (would require an orchestrator change). | **User input desirable but not blocking** — current behaviour is documented and safe (it never leaves an orphan on a clean shutdown; only "process killed mid-run" preserves the Codespace). |
| O9  | Codespaces `copyIn` does not preserve symlinks (scp behaviour).                                                             | Document as known limitation in JSDoc and in `Issues - Pending Items.md`. No workaround in v1.                                                                                                                                                                                                                                                                                                                                                                                                                | No.                                                                                                                                                                                          |
| O10 | `mode: "existing"` `worktreePath` derivation.                                                                               | Default `/workspaces/<repo-basename>`; `repo-basename` is derived from `gh codespace view -c <name> --json repository -q .repository.full_name` (split on `/`, take last). User may override via `repoCwdInCodespace`.                                                                                                                                                                                                                                                                                        | No.                                                                                                                                                                                          |
| O11 | Optional `token?: string` provider option for `github-codespaces` (Q6 in requirements).                                     | **Include in v1.** When set, spawn `gh` children with `env: { ...process.env, GH_TOKEN: options.token }`. Mirrors `vercel.token`. ~5 LOC.                                                                                                                                                                                                                                                                                                                                                                     | No — investigation strongly recommends.                                                                                                                                                      |

If the user disagrees with any decision above, raise it before Phase 6 launches.

---

## 1. Objective

Add two first-class sandbox providers to `@ai-hero/sandcastle`:

1. **`apple-containers`** — bind-mount provider driving Apple's native `container` CLI on Apple Silicon macOS. Same shape as `docker()` / `podman()`. Supports all three branch strategies (`head`, `merge-to-head`, `branch`).
2. **`github-codespaces`** — isolated provider driving `gh codespace` CLI. Discriminated union over `mode: "existing" | "managed"`. Supports `merge-to-head` (default) and `branch`; `head` is a compile-time error via the existing `IsolatedSandboxProvider` type constraint.

Both are released as a single `patch`-level changeset against pre-1.0.

## 2. Acceptance Criteria (whole-plan level)

The plan is complete when **all** hold:

1. `npm run build` passes (no new errors).
2. `npm run typecheck` passes (no new errors).
3. `npm test` passes; the test cases listed in §6 are all green.
4. `import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers"` resolves; the export is a callable factory.
5. `import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces"` resolves; the export is a callable factory.
6. README's Sandbox Providers table includes both new rows; Prerequisites section lists `container` CLI and `gh` CLI.
7. A single `.changeset/<slug>.md` exists with `"@ai-hero/sandcastle": patch` covering both providers; no duplicate changeset present.
8. `Issues - Pending Items.md` updated with known limitations (O8, O9 above; pre-existing items reviewed).
9. CLAUDE.md "Tools" section unchanged (no new tools added — providers are not "tools" in the project's tool-conventions sense).

Manual smoke tests (acceptance §8 and §9 of requirements doc) are out-of-scope for this plan's automated verification — they are a separate human task in Phase 10 (integration verification).

---

## 3. Unit Breakdown — No-Overlap File Map

The work is split into three units with strictly disjoint file ownership. **No file is owned by more than one unit.**

### Unit A — `apple-containers` provider

**Goal**: Implement the Apple-Silicon bind-mount provider end-to-end with unit tests.

**Files created (owned exclusively by A)**:

| Path                                     | Purpose                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/sandboxes/apple-containers.ts`      | Provider source (factory + handle + pre-flight helpers + signal handlers + `AppleContainerError` tagged error) |
| `src/sandboxes/apple-containers.test.ts` | Unit tests (vitest + `vi.mock("node:child_process")`)                                                          |

**Files modified by A**: **none**. Unit A does **not** touch `package.json`, `errors.ts`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `.changeset/*`, or any existing `src/` file.

**Dependencies**: none — fully isolated. May start in parallel with Units B and C.

**Implementation contract** (see §5.1 for full spec):

- `appleContainers(options?: AppleContainersOptions): SandboxProvider` via `createBindMountSandboxProvider`.
- Pre-flight order: arch → `container --version` → `container system status` → `container image inspect <imageName>`.
- Container creation: `container run -d --rm --name sandcastle-<uuid> -w /home/agent/workspace -u <uid>:<gid> -v <host>:/home/agent/workspace [-v <user-mounts>] [-e K=V] [--network <n>] <image> sleep infinity`.
- Handle methods: `worktreePath` (string), `exec`, `interactiveExec`, `copyFileIn`, `copyFileOut`, `close`.
- `copyFileIn`/`copyFileOut`: pure host filesystem (`node:fs/promises`) — no `container cp` (it does not exist).
- Signal handlers: `process.on("exit"/"SIGINT"/"SIGTERM")` calling `execFileSync("container", ["delete", "-f", containerName], ...)`.
- Branch strategies: all three (head, merge-to-head, branch) — no runtime guard needed.

**Acceptance criteria for Unit A**:

- A1. `npm run typecheck` passes for the new file.
- A2. `npm run build` produces `dist/sandboxes/apple-containers.js` and `.d.ts`.
- A3. `npm test -- src/sandboxes/apple-containers.test.ts` passes; all tests in §6.A green.
- A4. The `AppleContainersOptions` interface matches the shape required by the requirements doc §3.
- A5. No imports from `src/sandboxes/github-codespaces.ts` or `src/errors.ts`.
- A6. The factory call uses `createBindMountSandboxProvider`; `tag` discriminator is set automatically.
- A7. Argv construction is encapsulated in a small `buildRunArgs(...)` helper (or equivalent) at the top of the file so the test can assert exact strings without coupling to the spawn mock.

---

### Unit B — `github-codespaces` provider

**Goal**: Implement the GitHub Codespaces isolated provider end-to-end with unit tests.

**Files created (owned exclusively by B)**:

| Path                                      | Purpose                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sandboxes/github-codespaces.ts`      | Provider source (factory + discriminated-union options + `exec`/`copyIn`/`copyFileOut`/`close` + lifecycle + signal handlers + `CodespacesError` tagged error + state-poller) |
| `src/sandboxes/github-codespaces.test.ts` | Unit tests (vitest + mocked `gh` CLI)                                                                                                                                         |

**Files modified by B**: **none**. Unit B does **not** touch `package.json`, `errors.ts`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `.changeset/*`, or any existing `src/` file.

**Dependencies**: none — fully isolated. May start in parallel with Units A and C.

**Implementation contract** (see §5.2 for full spec):

- `githubCodespaces(options: GitHubCodespacesOptions): SandboxProvider` via `createIsolatedSandboxProvider`.
- `GitHubCodespacesOptions` is a discriminated union on `mode: "existing" | "managed"` — all required and optional fields per requirements doc §3 (item 11).
- Pre-flight at `create()`: `gh --version` → `gh auth status` → mode-specific (`gh codespace view -c <name>` for existing; flag-validation only for managed).
- `mode: "managed"` create flow: `gh codespace create -R <repo> --default-permissions [--branch] [--machine] [--location] [--devcontainer-path] [--idle-timeout] [-d <displayName>]` → capture stdout (codespace name) → poll `gh codespace view -c <name> --json state -q .state` until `Available` (default `pollIntervalMs: 3_000`, `createTimeoutMs: 600_000`). Treat `Failed`, `Unavailable`, `Unknown`, `Deleted`, `Moved`, `Archived` as terminal failures.
- `mode: "existing"` create flow: `gh codespace view -c <name> --json state -q .state` → if `Available` proceed, else `gh api --method POST /user/codespaces/<name>/start` then re-poll. Resolve `worktreePath` from `repoCwdInCodespace` if set, else `/workspaces/<basename(repository.full_name)>` derived from `gh codespace view --json repository`.
- Handle methods: `worktreePath`, `exec`, `copyIn`, `copyFileOut`, `close`.
- `exec`: `gh codespace ssh -c <name> -- bash -c '<cwd-prefixed cmd>'` via `child_process.spawn`; pipe `opts.stdin` to child's stdin and `end()`; line-stream stdout via `readline.createInterface` when `onLine` is set; collect stdout/stderr; resolve with `{ stdout, stderr, exitCode }`.
- `copyIn`: `gh codespace cp -r -c <name> <hostPath> remote:<sandboxPath>` via `execFile`. Never use `-e`.
- `copyFileOut`: `gh codespace cp -c <name> remote:<sandboxPath> <hostPath>` via `execFile`.
- `close()`:
  - `mode: "existing"`: do nothing (per requirements). Remove signal handlers.
  - `mode: "managed"`: `gh codespace delete -c <name> --force`. Remove signal handlers.
- Signal handlers (both modes): `process.on("exit"/"SIGINT"/"SIGTERM")` — for `managed`, run `execFileSync("gh", ["codespace", "delete", "-c", name, "--force"], { stdio: "ignore", timeout: 10_000, env: spawnEnv })` unless `keepOnFailure: true`. For `existing`, no-op (do not delete).
- `token?: string` option — when set, spawn `gh` children with `env: { ...process.env, GH_TOKEN: options.token }`. Never mutate `process.env`.
- Branch strategies: only `merge-to-head` (default) and `branch` are accepted by the type system; `head` is a compile-time error via the existing `IsolatedSandboxProvider` constraint — **no runtime check needed**.

**Acceptance criteria for Unit B**:

- B1. `npm run typecheck` passes for the new file.
- B2. `npm run build` produces `dist/sandboxes/github-codespaces.js` and `.d.ts`.
- B3. `npm test -- src/sandboxes/github-codespaces.test.ts` passes; all tests in §6.B green.
- B4. `GitHubCodespacesOptions` is a discriminated union; both arms type-check correctly; using `mode: "existing"` requires `name`, using `mode: "managed"` requires `repo`.
- B5. No imports from `src/sandboxes/apple-containers.ts` or `src/errors.ts`.
- B6. Argv construction is encapsulated in helpers (`buildSshArgs`, `buildCpArgs`, `buildCreateArgs`, `buildDeleteArgs`, `buildViewStateArgs`) so tests can assert exact strings.
- B7. The state-poller helper is exported (or reachable for testing) and recognises the full state enum from research §"Complete State Enum" (`Available`, transient set, terminal-failure set).
- B8. Tests assert `--default-permissions` is always present in the `create` argv (managed mode).
- B9. Tests assert that `mode: "existing"` never invokes `gh codespace create` or `gh codespace delete`.

---

### Unit C — Project integration: package.json exports + README + changeset + Issues file + functions doc

**Goal**: Wire the two providers into the package's public surface, documentation, and release pipeline. This unit owns every file that A and B both might otherwise touch, eliminating overlap.

**Files created (owned exclusively by C)**:

| Path                                                       | Purpose                                                                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.changeset/add-apple-containers-and-github-codespaces.md` | Single combined `patch` changeset entry (slug may be regenerated by Changesets). Body: short paragraph describing both providers in user-facing terms, using canonical CONTEXT.md vocabulary. |
| `docs/design/project-functions.md`                         | New file (created by the planner, see §7). Updated by Unit C only if further functional requirements need to be appended during implementation.                                               |

**Files modified (owned exclusively by C)**:

| Path                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`              | Add two `exports` entries (alphabetically): `./sandboxes/apple-containers` (between `./` and `./sandboxes/daytona` — i.e. immediately before `./sandboxes/daytona`) and `./sandboxes/github-codespaces` (between `./sandboxes/docker` and `./sandboxes/no-sandbox`). No version bump (Changesets handles that). No new dependencies.                                                                                                                                                 |
| `README.md`                 | (a) Add two rows to the Sandbox Providers table (lines ~70–76): `Apple Containers` (Bind-mount; accepted by `run()`/`createSandbox()`/`interactive()`) and `GitHub Codespaces` (Isolated; same accepted-by). (b) Add `container` CLI and `gh` CLI bullets to the Prerequisites section (lines ~22–27). (c) Add a brief usage example block per provider in the same style as the existing Docker/Podman examples. Use canonical terminology — never "backend"/"runtime"/"workspace". |
| `Issues - Pending Items.md` | (a) Move any pre-existing item about apple-containers / codespaces support to the completed section (none expected — verify). (b) Add new pending items for: O8 (`keepOnFailure` does not yet receive a `runFailed` flag from the orchestrator), O9 (codespaces `copyIn` does not preserve symlinks), Apple `container` runtime is pre-1.0 (test stability risk on minor bumps). If file does not exist, create it at the project root with the standard layout.                     |

**Files NOT modified by C (explicitly excluded)**:

- `src/sandboxes/apple-containers.ts` — Unit A.
- `src/sandboxes/apple-containers.test.ts` — Unit A.
- `src/sandboxes/github-codespaces.ts` — Unit B.
- `src/sandboxes/github-codespaces.test.ts` — Unit B.
- `src/SandboxProvider.ts`, `src/errors.ts`, `src/cli.ts`, any other `src/*.ts` — out of scope (no changes needed).
- `CLAUDE.md` — no edits needed; the project's tool-conventions section does not list sandbox providers as "tools".

**Dependencies**:

- Unit C may start in parallel with A and B for the README/changeset/Issues edits and for the `package.json` exports addition (the export entries are static strings and do not depend on the contents of A's or B's source files).
- However, the **build verification step of Unit C** (running `npm run build` and asserting that `import "@ai-hero/sandcastle/sandboxes/apple-containers"` resolves) requires Units A and B to have produced their `dist/` output. Therefore:
  - **Unit C's source edits** (package.json, README, changeset, Issues) — independent, run in parallel.
  - **Unit C's resolution check** — runs **after** A and B are built. This is captured as the "Phase 8 dependency validation" gate in the workflow checkpoint.

**Acceptance criteria for Unit C**:

- C1. `package.json#exports` contains both new subpaths in correct alphabetical position; `npm run build` succeeds.
- C2. After A and B are built, both `import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers"` and `import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces"` resolve via Node's ESM resolver. Verify with a one-line script under `test_scripts/verify-exports.mjs` (create folder if missing) or equivalent.
- C3. The README's Sandbox Providers table renders correctly (markdown lint clean) and uses canonical terminology.
- C4. Exactly one `.changeset/*.md` (other than `README.md` and `config.json`) covering these providers exists, with `"@ai-hero/sandcastle": patch` frontmatter and a one-paragraph user-facing summary.
- C5. `Issues - Pending Items.md` exists at project root and contains the new pending items.
- C6. No diff to any `src/sandboxes/*.ts`, `src/SandboxProvider.ts`, `src/errors.ts`, `src/cli.ts`, or `CLAUDE.md`.

---

## 4. Cross-Unit Integration Invariants

These invariants must hold across all three units after merge. The orchestrator (Phase 8) verifies them.

| Invariant                                                                                                             | Verified by                               |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| No two units modify the same file.                                                                                    | File-list diff at start of Phase 6.       |
| `package.json#exports` is sorted alphabetically.                                                                      | `jq` script in Phase 8 validation.        |
| `npm run typecheck` passes for the whole project.                                                                     | Phase 8.                                  |
| `npm run build` passes for the whole project.                                                                         | Phase 8.                                  |
| `npm test` passes for the whole project.                                                                              | Phase 8.                                  |
| Unit A and Unit B do **not** import from each other.                                                                  | grep + tsgo diagnostics.                  |
| Unit A and Unit B do **not** edit `src/errors.ts` or `src/SandboxProvider.ts`.                                        | `git diff` check.                         |
| README provider table is sorted (Apple Containers ahead of Daytona; GitHub Codespaces between Docker and No-sandbox). | Manual review during Phase 7 code review. |

---

## 5. Implementation Specs (Detailed)

### 5.1 Unit A — `apple-containers` detailed spec

#### 5.1.1 File structure (`src/sandboxes/apple-containers.ts`)

```
imports
  - createBindMountSandboxProvider, BindMountSandboxHandle, BindMountCreateOptions from "../SandboxProvider"
  - defaultImageName, resolveUserMounts, expandTilde from "../mountUtils"
  - randomUUID from "node:crypto"
  - spawn, execFile, execFileSync from "node:child_process"
  - createInterface from "node:readline"
  - copyFile, mkdir from "node:fs/promises"
  - dirname from "node:path"
  - Data from "effect"

exports
  - AppleContainerError class (Data.TaggedError "AppleContainerError")
  - AppleContainersOptions interface
  - appleContainers(options?: AppleContainersOptions): SandboxProvider
  - defaultImageName re-export (for parity with docker.ts)

internal helpers (file-private const arrow fns)
  - checkApplePlatform(): void  (sync — throws if not darwin/arm64)
  - checkContainerCli(): Promise<void>  (execFile container --version)
  - checkContainerSystem(): Promise<void>  (execFile container system status --format json)
  - checkContainerImageExists(name): Promise<void>  (execFile container image inspect <name>)
  - buildRunArgs(opts: { containerName, imageName, hostWorktreePath, sandboxWorktreePath, uid, gid, mounts, env, network }): string[]
  - startContainer(args: string[]): Promise<void>  (execFile)
  - removeContainer(containerName): Promise<void>  (execFile)
  - removeContainerSync(containerName): void  (execFileSync, used in onExit)
```

#### 5.1.2 `AppleContainersOptions` interface

```typescript
export interface AppleContainersOptions {
  readonly imageName?: string;
  readonly mounts?: readonly MountConfig[];
  readonly env?: Record<string, string>;
  readonly network?: string | readonly string[];
}
```

`MountConfig` is the existing type imported from `mountUtils`.

#### 5.1.3 Pre-flight order in `create()`

1. `checkApplePlatform()` — throw `AppleContainerError({ message: "..." })` if `process.platform !== "darwin" || process.arch !== "arm64"`.
2. `await checkContainerCli()` — throw with install URL on `ENOENT`.
3. `await checkContainerSystem()` — throw with `"container system start"` remediation.
4. `await checkContainerImageExists(resolvedImageName)` — throw with build instruction.

#### 5.1.4 Argv reference (frozen by tests)

`container run` args (in order):

```
run
  -d
  --rm
  --name sandcastle-<uuid>
  -w /home/agent/workspace
  -u <uid>:<gid>
  -v <hostWorktreePath>:/home/agent/workspace
  [-v <userMount.source>:<userMount.target>[:ro]]   ← repeated per user mount
  [-e K=V]                                          ← repeated per env var
  [--network <n>]                                   ← repeated if array
  <imageName>
  sleep infinity
```

`container exec` args:

```
exec
  [-i]                  ← when stdin defined
  [-w <cwd>]            ← when cwd set
  <containerName>
  bash -c <effectiveCommand>
```

`container exec -it` args (interactive):

```
exec
  -it | -i              ← TTY-detected
  [-w <cwd>]
  <containerName>
  <args...>
```

`container delete -f <containerName>` for teardown.

### 5.2 Unit B — `github-codespaces` detailed spec

#### 5.2.1 File structure (`src/sandboxes/github-codespaces.ts`)

```
imports
  - createIsolatedSandboxProvider, IsolatedSandboxHandle, IsolatedCreateOptions from "../SandboxProvider"
  - spawn, execFile, execFileSync from "node:child_process"
  - createInterface from "node:readline"
  - Data from "effect"

exports
  - CodespacesError class (Data.TaggedError "CodespacesError")
  - GitHubCodespacesOptions type (discriminated union)
  - GitHubCodespacesExistingOptions, GitHubCodespacesManagedOptions interfaces
  - githubCodespaces(options: GitHubCodespacesOptions): SandboxProvider

internal helpers (file-private)
  - TERMINAL_FAILURE_STATES: Set<string>
  - DEFAULT_POLL_INTERVAL_MS = 3000
  - DEFAULT_CREATE_TIMEOUT_MS = 600_000
  - buildSshArgs(name, cmd): string[]
  - buildCpArgs(direction, name, src, dst): string[]
  - buildCreateArgs(opts): string[]
  - buildDeleteArgs(name): string[]
  - buildViewStateArgs(name): string[]
  - buildStartViaApiArgs(name): string[]
  - resolveSpawnEnv(token?: string): NodeJS.ProcessEnv
  - checkGhCli(env): Promise<void>
  - checkGhAuth(env): Promise<void>
  - checkExistingCodespace(env, name): Promise<void>
  - createCodespace(env, args): Promise<string>  (returns name from stdout.trim())
  - waitForAvailable(env, name, pollIntervalMs, timeoutMs): Promise<void>
  - startCodespace(env, name): Promise<void>  (gh api POST .../start)
  - viewRepoFullName(env, name): Promise<string>  (returns owner/repo)
  - deleteCodespaceAsync(env, name): Promise<void>
  - deleteCodespaceSync(env, name): void  (execFileSync, for signal handlers)
```

#### 5.2.2 `GitHubCodespacesOptions` (discriminated union)

```typescript
export interface GitHubCodespacesExistingOptions {
  readonly mode: "existing";
  readonly name: string;
  readonly repoCwdInCodespace?: string;
  readonly env?: Record<string, string>;
  readonly token?: string;
}

export interface GitHubCodespacesManagedOptions {
  readonly mode: "managed";
  readonly repo: string; // "owner/repo"
  readonly branch?: string;
  readonly machine?: string;
  readonly region?: string; // gh's --location
  readonly devcontainerPath?: string;
  readonly idleTimeoutMinutes?: number;
  readonly displayName?: string;
  readonly keepOnFailure?: boolean; // default false
  readonly pollIntervalMs?: number; // default 3000
  readonly createTimeoutMs?: number; // default 600000
  readonly env?: Record<string, string>;
  readonly token?: string;
}

export type GitHubCodespacesOptions =
  | GitHubCodespacesExistingOptions
  | GitHubCodespacesManagedOptions;
```

#### 5.2.3 `gh` argv reference (frozen by tests)

```
gh codespace ssh -c <name> -- bash -c <remoteCmd>
gh codespace cp -r -c <name> <localPath> remote:<remotePath>      ← copyIn
gh codespace cp -c <name> remote:<remotePath> <localPath>          ← copyFileOut
gh codespace create -R <repo> [--branch <b>] [--machine <m>]
                  [--location <l>] [--devcontainer-path <p>]
                  [--idle-timeout <Nm>] [-d <displayName>]
                  --default-permissions
gh codespace view -c <name> --json state -q .state
gh codespace view -c <name> --json repository -q .repository.full_name
gh codespace delete -c <name> --force
gh api --method POST /user/codespaces/<name>/start
gh --version
gh auth status
```

`--default-permissions` is **always** present in `create` argv. `idle-timeout` is formatted as `<N>m` (e.g. `30m`) when `idleTimeoutMinutes` is set.

#### 5.2.4 State machine (from research §"Complete State Enum")

```typescript
const TERMINAL_FAILURE_STATES = new Set([
  "Failed",
  "Unavailable",
  "Unknown",
  "Deleted",
  "Moved",
  "Archived",
]);
// Available => success
// Anything else (Created, Queued, Provisioning, Awaiting, Starting,
// Rebuilding, Updating, ShuttingDown, Shutdown, Exporting) => keep polling
```

For `mode: "existing"`, observed `Shutdown` triggers `gh api POST /user/codespaces/<name>/start`, then re-polls.

---

## 6. Test Cases (Test-Builder Inputs)

### 6.A — `src/sandboxes/apple-containers.test.ts` (Unit A)

Mock pattern: `vi.mock("node:child_process")` at top of file (same as `docker.test.ts`). Tests use plain `vitest` `describe`/`it`/`expect`.

| ID   | Test name                                                         | Verifies                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TA1  | rejects on non-Apple-Silicon host                                 | Stub `process.platform = "linux"` (or `arch = "x64"`); `appleContainers().create(...)` rejects with message containing "Apple Silicon" / "darwin" / "arm64". Typed `AppleContainerError`.                                                                                                                                                                                            |
| TA2  | rejects when `container` CLI is missing                           | `mockExecFile` returns `ENOENT` for `container --version`; `create()` rejects with message including the install URL `https://github.com/apple/container`.                                                                                                                                                                                                                           |
| TA3  | rejects when `container system status` fails                      | Pass-through `--version`; fail `system status`; reject with message including `container system start`.                                                                                                                                                                                                                                                                              |
| TA4  | rejects when image does not exist                                 | Pass-through previous probes; fail `image inspect`; reject with message naming the image.                                                                                                                                                                                                                                                                                            |
| TA5  | constructs the expected `container run` argv                      | Mock all probes successfully; capture `mockExecFile.mock.calls` for the `run` call; assert exact argv equality (including `-d --rm --name sandcastle-<uuid> -w /home/agent/workspace -u <uid>:<gid> -v <host>:/home/agent/workspace` in order). UUID is matched via regex.                                                                                                           |
| TA6  | passes user mounts as `-v` flags                                  | Provide `mounts: [{ source: "/host/cache", target: "/cache" }]`; assert `-v /host/cache:/cache` in argv.                                                                                                                                                                                                                                                                             |
| TA7  | passes env vars as `-e K=V`                                       | `env: { FOO: "bar" }` results in `-e FOO=bar`.                                                                                                                                                                                                                                                                                                                                       |
| TA8  | passes network single string and array                            | `network: "host"` → `--network host`. `network: ["a", "b"]` → `--network a --network b`.                                                                                                                                                                                                                                                                                             |
| TA9  | `exec` builds correct argv with stdin and cwd                     | `handle.exec("ls", { stdin: "x", cwd: "/foo" })` → spawn args `["exec", "-i", "-w", "/foo", containerName, "bash", "-c", "ls"]`.                                                                                                                                                                                                                                                     |
| TA10 | `exec` streams onLine via readline                                | Fake spawn emits `"a\nb\n"`; `onLine` receives `["a","b"]`.                                                                                                                                                                                                                                                                                                                          |
| TA11 | `interactiveExec` allocates `-it` when stdin is TTY               | Fake stdin with `isTTY=true` → argv contains `-it`. Fake non-TTY → argv contains `-i`.                                                                                                                                                                                                                                                                                               |
| TA12 | `copyFileIn` copies via host filesystem                           | Spy on `node:fs/promises.copyFile`; assert called with correct host paths. **No `execFile` call to `container cp`.**                                                                                                                                                                                                                                                                 |
| TA13 | `copyFileOut` copies via host filesystem                          | Same as TA12 but reverse.                                                                                                                                                                                                                                                                                                                                                            |
| TA14 | `close()` calls `container delete -f` and removes signal handlers | Mock `execFile` for `delete`; assert it's called with `["delete", "-f", containerName]`; assert `process.removeListener("exit"/"SIGINT"/"SIGTERM")` invocations.                                                                                                                                                                                                                     |
| TA15 | branch strategies type-check                                      | A `// @ts-expect-error: head should be allowed`-style **negative** test isn't needed because all three are valid. Instead, an **expressive type test** in the test file: `appleContainers()` is assignable to `BindMountSandboxProvider`; `run({ sandbox: appleContainers(), branchStrategy: "head" })` type-checks (covered by tsgo, asserted via a no-runtime "type smoke" const). |
| TA16 | env overlap throws via `mergeProviderEnv`                         | Provider env `{ AGENT_KEY: "x" }` colliding with agent provider env `{ AGENT_KEY: "y" }` — assert `mergeProviderEnv` throws (importing `mergeProviderEnv` directly). Mirrors the existing pattern in `docker.test.ts`.                                                                                                                                                               |

### 6.B — `src/sandboxes/github-codespaces.test.ts` (Unit B)

Mock pattern: `vi.mock("node:child_process")` at top.

| ID   | Test name                                                                                                                           | Verifies                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TB1  | rejects when `gh` CLI is missing                                                                                                    | `gh --version` returns ENOENT; `create()` rejects with install URL.                                                                                                                                                                                                                                                                                                                                                                                            |
| TB2  | rejects when `gh auth status` fails                                                                                                 | `auth status` exits non-zero; `create()` rejects with hint to run `gh auth login` and add `codespace` scope.                                                                                                                                                                                                                                                                                                                                                   |
| TB3  | `mode: "existing"`: never invokes `gh codespace create` or `gh codespace delete`                                                    | Set up successful `view` returning `Available`; full happy-path through `create()` then `close()`; assert `mockExecFile.mock.calls` contains zero matches for argv `[0]==="codespace" && [1]==="create"` and zero for `[0]==="codespace" && [1]==="delete"`.                                                                                                                                                                                                   |
| TB4  | `mode: "existing"`: when state is `Shutdown`, calls `gh api POST /user/codespaces/<name>/start` then re-polls                       | First `view` → `Shutdown`; expect `gh api --method POST /user/codespaces/<name>/start`; subsequent `view` → `Available`.                                                                                                                                                                                                                                                                                                                                       |
| TB5  | `mode: "existing"`: derives `worktreePath` from `gh codespace view --json repository`                                               | Mock the view to return `repository.full_name="owner/my-repo"`; resolved `worktreePath === "/workspaces/my-repo"`.                                                                                                                                                                                                                                                                                                                                             |
| TB6  | `mode: "existing"`: honours `repoCwdInCodespace` override                                                                           | Option set to `/workspaces/custom`; resolved `worktreePath === "/workspaces/custom"`; no `view --json repository` probe is needed.                                                                                                                                                                                                                                                                                                                             |
| TB7  | `mode: "managed"`: `gh codespace create` argv is correct                                                                            | Options: `repo: "o/r"`, `branch: "main"`, `machine: "standardLinux32gb"`, `region: "WestUs2"`, `devcontainerPath: ".devcontainer/dev.json"`, `idleTimeoutMinutes: 30`, `displayName: "test"`. Asserts argv (in order): `["codespace", "create", "-R", "o/r", "--branch", "main", "--machine", "standardLinux32gb", "--location", "WestUs2", "--devcontainer-path", ".devcontainer/dev.json", "--idle-timeout", "30m", "-d", "test", "--default-permissions"]`. |
| TB8  | `mode: "managed"`: `--default-permissions` is always present                                                                        | Even with all optional fields omitted, argv includes `--default-permissions`.                                                                                                                                                                                                                                                                                                                                                                                  |
| TB9  | `mode: "managed"`: `close()` invokes `gh codespace delete -c <n> --force`                                                           | Assert exact argv.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| TB10 | `mode: "managed"`: state poller treats `Provisioning`/`Starting`/`Created`/`Queued`/`Awaiting`/`Rebuilding`/`Updating` as transient | Sequence multiple view responses; final `Available`; ensure poller does not throw.                                                                                                                                                                                                                                                                                                                                                                             |
| TB11 | `mode: "managed"`: state poller throws on `Failed`                                                                                  | `view` returns `Failed`; `create()` rejects with message naming the state. Same for `Unavailable`, `Unknown`, `Deleted`, `Moved`, `Archived`.                                                                                                                                                                                                                                                                                                                  |
| TB12 | `mode: "managed"`: poller respects `createTimeoutMs`                                                                                | `pollIntervalMs: 10`, `createTimeoutMs: 30`; all views return `Provisioning`; reject with timeout error after deadline.                                                                                                                                                                                                                                                                                                                                        |
| TB13 | `mode: "managed"`: `keepOnFailure: true` causes signal handler to skip delete                                                       | Trigger the registered SIGINT handler manually; `mockExecFileSync` should not have been called for `delete`. (Use a spy on the registered handler.)                                                                                                                                                                                                                                                                                                            |
| TB14 | `exec` builds correct argv                                                                                                          | `handle.exec("ls", { cwd: "/workspaces/r", stdin: "x" })` → spawn args `["codespace", "ssh", "-c", name, "--", "bash", "-c", "cd /workspaces/r && ls"]`. With no cwd, `bash -c "ls"`. With `sudo: true`, `bash -c "sudo ls"`.                                                                                                                                                                                                                                  |
| TB15 | `exec` streams onLine                                                                                                               | Fake spawn emits chunks; `onLine` receives lines in order.                                                                                                                                                                                                                                                                                                                                                                                                     |
| TB16 | `exec` pipes stdin                                                                                                                  | Spawn `stdin.write` called with provided string and `stdin.end()` invoked.                                                                                                                                                                                                                                                                                                                                                                                     |
| TB17 | `copyIn` argv                                                                                                                       | `copyIn("/h", "/s")` → execFile `gh ["codespace", "cp", "-r", "-c", name, "/h", "remote:/s"]`. **Never** `-e`.                                                                                                                                                                                                                                                                                                                                                 |
| TB18 | `copyFileOut` argv                                                                                                                  | `copyFileOut("/s", "/h")` → execFile `gh ["codespace", "cp", "-c", name, "remote:/s", "/h"]`.                                                                                                                                                                                                                                                                                                                                                                  |
| TB19 | `token` option injects `GH_TOKEN`                                                                                                   | Provide `token: "abc"`; assert all `gh` spawn/execFile calls receive `env.GH_TOKEN === "abc"`. `process.env` is unchanged after the test.                                                                                                                                                                                                                                                                                                                      |
| TB20 | branch strategy `head` is a compile-time error                                                                                      | `// @ts-expect-error` line where `head` is passed to a function typed against `IsolatedSandboxProvider`; tsgo enforces this — vitest does not assert directly, but the file fails typecheck if the `@ts-expect-error` is wrong.                                                                                                                                                                                                                                |
| TB21 | branch strategies `merge-to-head` and `branch` type-check                                                                           | A no-runtime "type smoke" assignment in the test file.                                                                                                                                                                                                                                                                                                                                                                                                         |
| TB22 | env overlap throws via `mergeProviderEnv`                                                                                           | Provider env colliding with agent env throws.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TB23 | `discriminated union` type narrowing works                                                                                          | Construct one of each option shape; tsgo narrows correctly inside the provider's create. (Compile-time; runtime no-op.)                                                                                                                                                                                                                                                                                                                                        |
| TB24 | signal handler unregistered on `close()`                                                                                            | After `close()`, `process.listeners("SIGINT")` does not include the handler.                                                                                                                                                                                                                                                                                                                                                                                   |

### 6.C — Unit C — Verification scripts (no new vitest specs)

| ID  | Verification                           | Method                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC1 | Both subpaths resolve                  | `test_scripts/verify-exports.mjs` does `await import("@ai-hero/sandcastle/sandboxes/apple-containers")` and `await import("@ai-hero/sandcastle/sandboxes/github-codespaces")`; asserts `typeof appleContainers === "function"` and `typeof githubCodespaces === "function"`. Run after `npm run build`. |
| TC2 | `package.json#exports` is alphabetised | `jq -r '.exports \| keys[]' package.json` produces a sorted list.                                                                                                                                                                                                                                       |
| TC3 | Single changeset present               | `ls .changeset/*.md \| grep -v -E '(README\|config)' \| wc -l` equals 1.                                                                                                                                                                                                                                |
| TC4 | README table parses                    | `grep -E '^\| Apple Containers' README.md` and `^\| GitHub Codespaces` each match exactly once.                                                                                                                                                                                                         |

---

## 7. Functional Requirements Update — `docs/design/project-functions.md`

This file is created as part of this plan. Future plans append additional FRs.

```markdown
# Project Functional Requirements — @ai-hero/sandcastle

## Sandbox Providers

### FR-NEW (Plan 001) — apple-containers

**ID**: FR-001
**Status**: Implemented in Plan 001
**Description**: The library MUST support `apple-containers` as a bind-mount sandbox provider that drives Apple's native `container` CLI on Apple-Silicon macOS hosts.
**Branch strategies**: `head` (default), `merge-to-head`, `branch`.
**Pre-flight**: hard-fail on non-darwin/arm64; verify `container --version`, `container system status`, and `container image inspect <image>`.
**Lifecycle**: register `process.on("exit"/"SIGINT"/"SIGTERM")` for best-effort `container delete -f`.
**File-copy**: bind-mount transparent — `copyFileIn`/`copyFileOut` operate on the host worktree directly via `node:fs/promises`.

### FR-NEW (Plan 001) — github-codespaces

**ID**: FR-002
**Status**: Implemented in Plan 001
**Description**: The library MUST support `github-codespaces` as an isolated sandbox provider that drives GitHub Codespaces via the `gh codespace` CLI.
**Modes**:

- `existing` — caller supplies a Codespace name; provider attaches; never creates or deletes.
- `managed` — provider creates a Codespace per run, waits for `Available`, runs the agent, deletes on `close()` (subject to `keepOnFailure`).
  **Branch strategies**: `merge-to-head` (default), `branch`. `head` is a compile-time error via the existing `IsolatedSandboxProvider` type constraint.
  **Pre-flight**: `gh --version`; `gh auth status` (codespace scope); for `existing`, `gh codespace view -c <name>`.
  **Exec transport**: `gh codespace ssh -c <name> -- bash -c <cmd>`. (`gh codespace exec` does not exist.)
  **File transport**: `gh codespace cp -r` for copyIn; `gh codespace cp` for copyFileOut. Never use `-e`.
  **Auth in CI**: optional `token?: string` option injects `GH_TOKEN` into spawned `gh` children.
  **Lifecycle**: register signal handlers in both modes; `managed` deletes on signal unless `keepOnFailure`; `existing` is a no-op cleanup.
```

---

## 8. Risks and Mitigations

| #   | Risk                                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Apple `container` CLI is pre-1.0 — argv may break on minor releases.                                     | Medium     | Medium | Pin tests to exact argv strings via `buildRunArgs` helper. Document in changeset. Add to `Issues - Pending Items.md`.                                                            |
| R2  | Codespaces provides only `linux/amd64`; agent images that hardcode `arm64` will not run.                 | Low        | Low    | Document in `github-codespaces.ts` JSDoc.                                                                                                                                        |
| R3  | `gh codespace` rate limits or transient failures during polling.                                         | Low        | Medium | Default `pollIntervalMs: 3_000` (well under 5,000 req/hr limit). Treat all transient states as keep-polling. Single timeout hard-stop.                                           |
| R4  | `gh codespace ssh` SSH banner noise on stderr causes false-positive errors in tests.                     | Medium     | Low    | Tests assert exit code only, not stderr content. Documented.                                                                                                                     |
| R5  | `keepOnFailure` does not yet receive a `runFailed` signal from the orchestrator.                         | Medium     | Medium | Document scope: `keepOnFailure` only protects against signal-driven cleanup (SIGINT/SIGTERM). Normal `close()` always deletes. Logged as pending in `Issues - Pending Items.md`. |
| R6  | Codespaces `copyIn` does not preserve symlinks.                                                          | Low        | Low    | Documented in JSDoc and pending items.                                                                                                                                           |
| R7  | macOS 26 hard-requirement for Apple `container` may not be detectable from Node.                         | Low        | Low    | Skip programmatic macOS version probe; rely on `container system status` failure for actionable error. (Per investigation Q1.)                                                   |
| R8  | `process.env` mutation when `token` is set could leak secrets across providers.                          | Low        | High   | Always use `{ ...process.env, GH_TOKEN: ... }` — never assign to `process.env`. Test TB19 verifies.                                                                              |
| R9  | UID/GID on Apple `container` may not be honoured by all images.                                          | Medium     | Medium | Open Question Q4 from requirements doc. Ship as-is; flag in `Issues - Pending Items.md`.                                                                                         |
| R10 | Three-unit parallel build introduces race on `package.json` if Unit A or Unit B accidentally touches it. | Low        | High   | Phase 8 dependency validation step explicitly diffs against the file ownership map in §3.                                                                                        |

---

## 9. Execution Sequence (for the orchestrator)

1. **Phase 5 — Design**: confirm `docs/design/project-design.md` records both providers (separate task, not part of this plan).
2. **Phase 6 — Parallel implementation**: launch three subagents simultaneously, one per Unit (A, B, C). Each receives §3 as its sub-prompt plus the §5 detailed spec for its unit.
3. **Phase 7 — Code review**: review all three units' diffs together; check no-overlap invariant from §4.
4. **Phase 8 — Dependency validation**: run `npm install` if needed; `npm run typecheck`; `npm run build`; `node test_scripts/verify-exports.mjs`; `npm test`.
5. **Phase 9 — Parallel test build**: ensure tests in §6.A and §6.B are present and green.
6. **Phase 10 — Integration verification**: manual smoke tests per requirements §8 and §9. (Out of automated scope.)

---

## 10. Output (Summary spec for the orchestrator's record-keeping)

When the plan is fully executed, a `SUMMARY.md` (or equivalent record in the workflow checkpoint JSON) should capture:

- The three units' commit hashes.
- `npm test` final result (pass / fail counts).
- Any deviations applied per the create-plans skill's deviation rules (auto-fix bugs / auto-add critical / auto-fix blockers / log enhancements).
- A list of items moved to / added to `Issues - Pending Items.md`.
- The final `dist/` size delta (sanity check for "no large new files").

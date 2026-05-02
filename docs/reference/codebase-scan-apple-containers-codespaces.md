---
language: typescript
framework: effect
package_manager: npm
build_command: "tsgo --project tsconfig.build.json"
test_command: "vitest run"
lint_command: "prettier --check ."
entry_points:
  - src/main.ts
  - src/index.ts
  - src/cli.ts
last_scanned_commit: 20cb6086b567f3fd83f2b2cb9c7ad565a852c67f
scanned_for_request: requirements-001-apple-containers-and-codespaces-providers.md
scanned_at: "2026-05-02T22:00:00Z"
---

# Codebase Scan — @ai-hero/sandcastle

## 1. Project Overview

`@ai-hero/sandcastle` (v0.5.7) is a TypeScript ESM library and CLI that orchestrates AI coding agents inside isolated sandbox environments. It is built entirely on Effect.ts (v3.20) for async/error management and uses `@effect/cli` for CLI command construction. The source lives entirely under `src/`; providers are exported as subpath ESM entries under `dist/sandboxes/*.js`. The build tool is `tsgo` (TypeScript native preview); tests run via `vitest` with `@effect/vitest`. A `postbuild` step copies `src/templates/` into `dist/templates/`.

---

## 2. Module Map

| Path                               | Purpose                                                                                                      | Representative symbols                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/SandboxProvider.ts`           | Core type definitions and factory functions for all sandbox provider kinds                                   | `createBindMountSandboxProvider`, `createIsolatedSandboxProvider`, `BindMountSandboxHandle`, `IsolatedSandboxHandle` |
| `src/sandboxes/docker.ts`          | Bind-mount sandbox provider for Docker; the canonical reference for new bind-mount providers                 | `docker`, `DockerOptions`, `defaultImageName`                                                                        |
| `src/sandboxes/podman.ts`          | Bind-mount sandbox provider for Podman; adds SELinux label and userns handling over Docker                   | `podman`, `PodmanOptions`, `checkPodmanMachine`, `checkImageExists`                                                  |
| `src/sandboxes/vercel.ts`          | Isolated sandbox provider driving `@vercel/sandbox` SDK; reference for isolated provider pattern             | `vercel`, `VercelOptions`                                                                                            |
| `src/sandboxes/daytona.ts`         | Isolated sandbox provider driving `@daytona/sdk`; second reference for isolated pattern                      | `daytona`, `DaytonaOptions`                                                                                          |
| `src/sandboxes/no-sandbox.ts`      | No-sandbox provider; agent runs directly on host                                                             | `noSandbox`                                                                                                          |
| `src/sandboxes/test-bind-mount.ts` | Filesystem-based stub for bind-mount sandbox used in tests                                                   | `testBindMount`                                                                                                      |
| `src/sandboxes/test-isolated.ts`   | Filesystem-based stub for isolated sandbox used in tests                                                     | `testIsolated`                                                                                                       |
| `src/DockerLifecycle.ts`           | Effect-wrapped Docker CLI helpers (build, start, stop, remove image/container)                               | `startContainer`, `removeContainer`, `buildImage`, `removeImage`                                                     |
| `src/PodmanLifecycle.ts`           | Effect-wrapped Podman CLI helpers (mirrors DockerLifecycle)                                                  | `buildImage`, `removeImage`                                                                                          |
| `src/cli.ts`                       | `@effect/cli` command tree: `init`, `docker build-image/remove-image`, `podman build-image/remove-image`     | `sandcastle`, `dockerCommand`, `podmanCommand`                                                                       |
| `src/mountUtils.ts`                | Shared host/sandbox path resolution, tilde expansion, image naming, git volume mount helpers                 | `defaultImageName`, `resolveUserMounts`, `expandTilde`, `PARENT_GIT_SANDBOX_DIR`                                     |
| `src/mergeProviderEnv.ts`          | Merges env from env-resolver, agent provider, and sandbox provider; throws on overlapping agent+sandbox keys | `mergeProviderEnv`                                                                                                   |
| `src/syncOut.ts`                   | Isolated sandbox commit extraction: `git format-patch` + `git am`, uncommitted diffs, untracked files        | `syncOut`                                                                                                            |
| `src/syncIn.ts`                    | Copy host worktree into isolated sandbox before a run                                                        | `syncIn`                                                                                                             |
| `src/SandboxFactory.ts`            | Assembles provider + branch strategy into a running sandbox                                                  | `createSandbox`, `SANDBOX_REPO_DIR`                                                                                  |
| `src/run.ts`                       | Top-level `run()` orchestration: branch strategy, worktree creation, agent invocation loop                   | `run`                                                                                                                |
| `src/interactive.ts`               | Top-level `interactive()` orchestration; accepts all three sandbox provider types                            | `interactive`                                                                                                        |
| `src/createWorktree.ts`            | Creates git worktrees for `merge-to-head` and `branch` strategies                                            | `createWorktree`                                                                                                     |
| `src/Orchestrator.ts`              | Main iteration loop inside a running sandbox                                                                 | `Orchestrator`                                                                                                       |
| `src/errors.ts`                    | Typed error classes (`DockerError`, `SyncError`, `ConfigDirError`, etc.)                                     | `DockerError`, `SyncError`                                                                                           |
| `src/index.ts`                     | Public API re-exports for the root subpath                                                                   | `run`, `interactive`, `createSandbox`, `claudeCode`                                                                  |

---

## 3. Conventions

- **Factory function pattern** — every sandbox provider is a single exported `const` that returns a provider object created by `createBindMountSandboxProvider` or `createIsolatedSandboxProvider`. The factory captures options in closure; `create()` is called by the framework with resolved `BindMountCreateOptions` / `IsolatedCreateOptions` at runtime (`src/sandboxes/docker.ts:59`, `src/sandboxes/vercel.ts:123`).

- **Effect.ts for CLI primitives, plain Promises for sandbox handles** — `DockerLifecycle.ts` and `PodmanLifecycle.ts` use `Effect.async` / `Effect.gen` for CLI operations and are consumed with `Effect.runPromise` inside `create()`. The `BindMountSandboxHandle` and `IsolatedSandboxHandle` methods are plain `async` Promises, not Effects. New providers should follow the same seam (`src/sandboxes/docker.ts:95–110`, `src/DockerLifecycle.ts:6–26`).

- **Signal cleanup pattern** — after starting a container, `docker.ts` registers `process.on("exit", onExit)` and `process.on("SIGINT"/"SIGTERM", onSignal)` for best-effort removal. `handle.close()` removes those listeners and tears down the sandbox. This pattern must be replicated in both new providers (`src/sandboxes/docker.ts:113–128`, `src/sandboxes/podman.ts:182–196`).

- **Error message style** — provider errors use the form `"<cli> <subcommand> failed: <message>"` (e.g. `"docker cp (in) failed: ..."`, `"podman exec failed: ..."`). Every pre-flight check throws with a remediation hint (e.g. `"Build it first with 'podman build -t ...'"`). No silent fallbacks for missing config (`src/sandboxes/podman.ts:353–365`, `src/mergeProviderEnv.ts:20–24`).

- **Subpath ESM exports** — each provider is its own subpath entry in `package.json#exports` with both `"import"` and `"types"` keys pointing into `dist/sandboxes/`. The main `@ai-hero/sandcastle` entry does not re-export any provider. New entries must be added in alphabetical order (`package.json` exports section).

- **Test mock strategy** — unit tests for bind-mount providers (`docker.test.ts`, `podman.test.ts`) use `vi.mock("node:child_process")` at the top of the file to stub `execFile`, `execFileSync`, and `spawn`. `mockExecFile.mockImplementation` is called per test to simulate success/failure. `@effect/vitest` is declared as a dev dependency but the provider unit tests currently use plain `vitest` `describe`/`it`/`expect`. The `testSetup.ts` setupFile isolates per-worker git config to avoid lock contention (`src/testSetup.ts:1–29`).

---

## 4. Integration Points

### In-Scope Files

#### `src/SandboxProvider.ts` — **Core contracts to implement**

Lines 23–98: `BindMountSandboxHandle`, `BindMountCreateOptions`, `BindMountSandboxProviderConfig`, `createBindMountSandboxProvider`.  
Both `appleContainers()` and its handle must satisfy these interfaces exactly. `AppleContainersOptions` mirrors `DockerOptions` / `PodmanOptions`.

Lines 100–159: `IsolatedSandboxHandle`, `IsolatedCreateOptions`, `IsolatedSandboxProviderConfig`, `createIsolatedSandboxProvider`.  
`githubCodespaces()` must satisfy `IsolatedSandboxHandle` (note: `copyIn` not `copyFileIn` — isolated handles use `copyIn(hostPath, sandboxPath)` accepting directories).

Lines 161–334: `BindMountSandboxProvider`, `IsolatedSandboxProvider`, `SandboxProvider`, `BindMountBranchStrategy`, `IsolatedBranchStrategy`.  
`IsolatedBranchStrategy` is `MergeToHeadBranchStrategy | NamedBranchStrategy` — `HeadBranchStrategy` is intentionally excluded, giving the `head` compile-time error. No runtime guard is needed.

Lines 313–334: `createBindMountSandboxProvider` and `createIsolatedSandboxProvider` factory functions.  
**These are the only entry points needed.** Both are thin wrappers that attach the `tag` discriminator and normalize `env` to `{}`.

> **Risk Q1 (from request):** `createIsolatedSandboxProvider` is a complete factory — `tag`, `name`, `env`, and `create` are all set. However, commit extraction for isolated providers is handled by `syncOut.ts` (called by the orchestrator), which drives the handle's `exec` and `copyFileOut` methods. The factory itself does **not** implement commit extraction; that is the orchestrator's responsibility. `testIsolated` exercising `syncOut` in the test suite confirms the path is live. No gap found for basic commit extraction — but `stdin` is not yet in `IsolatedSandboxHandle.exec`'s option type (only in `BindMountSandboxHandle`), which may be a minor omission.

#### `src/sandboxes/docker.ts` — **Bind-mount template for `apple-containers`**

Lines 59–272: Complete implementation pattern. Key points:

- `sandboxHomedir = "/home/agent"` → worktree resolved to `/home/agent/workspace` if no matching mount found.
- `randomUUID()` from `node:crypto` for sandbox name: `sandcastle-<uuid>`.
- `startContainer` called with `Effect.runPromise`; all other handle methods are plain Promises.
- `interactiveExec` TTY detection: checks `opts.stdin.isTTY`; allocates `-it` or `-i` accordingly.
- `defaultImageName` re-exported for backwards compatibility.

`AppleContainersOptions` must include: `imageName?`, `mounts?`, `env?`, `network?`. Pre-flight checks (`checkImageExists` pattern from `podman.ts`) should be modeled after `podman.ts:353–396`.

#### `src/sandboxes/podman.ts` — **Pre-flight and helper pattern**

Lines 90–409: `checkPodmanMachine()` and `checkImageExists()` are the canonical pre-flight check pattern. Apple-containers pre-flights (`platform/arch check`, `container --version`, system status, image exists) should follow the same Promise-wrapping style with actionable error messages.

#### `src/sandboxes/vercel.ts` — **Isolated provider template for `github-codespaces`**

Lines 123–294: `createIsolatedSandboxProvider` usage pattern. Key observations:

- `create()` is `async`, uses dynamic `import()` for the SDK peer dep.
- `copyIn` handles both file and directory (tar-based for Vercel). The `github-codespaces` provider will use `gh codespace cp -r` for directories.
- No signal handler registered — isolated providers in the current codebase do **not** register `process.on` handlers. The request requires best-effort cleanup on exit/signal; this is new behavior for isolated providers.
- `worktreePath` is a fixed constant (`VERCEL_REPO_PATH`). For `github-codespaces`, this must be derived at runtime.

#### `src/mountUtils.ts` — **Shared helpers available to `apple-containers`**

`defaultImageName(repoDir)`, `resolveUserMounts(mounts, sandboxHomedir)`, `expandTilde`, `PARENT_GIT_SANDBOX_DIR`. No changes needed to mountUtils — `apple-containers` calls these directly.

#### `src/mergeProviderEnv.ts` — **Env overlap enforcement**

Lines 1–31: Throws `Error` with overlap key names when `agentProviderEnv` and `sandboxProviderEnv` share keys. Both new providers must not introduce keys that overlap with standard agent provider env. Tests must assert this throws.

#### `src/cli.ts` lines 319–480 — **CLI command registration pattern**

The CLI registers provider namespaces with `Command.make("<name>", {}, handler).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]))`. Docker and Podman each get their own namespace.

**Important:** The request explicitly marks CLI namespace commands (`sandcastle apple-containers build-image`, `sandcastle codespaces create`) as **out of scope** for v1. The two new providers do **not** require changes to `cli.ts`.

#### `package.json` exports — **Subpath export addition required**

Current entries: `./sandboxes/docker`, `./sandboxes/vercel`, `./sandboxes/podman`, `./sandboxes/daytona`, `./sandboxes/no-sandbox`.  
Must add (in alphabetical order):

```json
"./sandboxes/apple-containers": {
  "import": "./dist/sandboxes/apple-containers.js",
  "types": "./dist/sandboxes/apple-containers.d.ts"
},
"./sandboxes/github-codespaces": {
  "import": "./dist/sandboxes/github-codespaces.js",
  "types": "./dist/sandboxes/github-codespaces.d.ts"
}
```

`apple-containers` comes before `daytona` alphabetically; `github-codespaces` comes between `docker` and `no-sandbox`.

#### `README.md` lines 70–76 — **Sandbox Providers table**

Two rows must be added:

| Provider          | Import path                                       | Type       | Accepted by                                 |
| ----------------- | ------------------------------------------------- | ---------- | ------------------------------------------- |
| Apple Containers  | `@ai-hero/sandcastle/sandboxes/apple-containers`  | Bind-mount | `run()`, `createSandbox()`, `interactive()` |
| GitHub Codespaces | `@ai-hero/sandcastle/sandboxes/github-codespaces` | Isolated   | `run()`, `createSandbox()`, `interactive()` |

The Prerequisites section (lines 22–27) also needs entries for the `container` CLI and `gh` CLI.

#### `.changeset/` directory — **Changeset addition required**

Currently contains only `config.json` and `README.md` (no draft changesets). A new `.changeset/<slug>.md` must be created with:

```yaml
---
"@ai-hero/sandcastle": patch
---
```

No existing changeset covers these providers — safe to add a fresh one.

#### `src/sandboxes/*.test.ts` — **Test file pattern**

All provider tests use plain `vitest` (`describe`, `it`, `expect`, `vi`) — **not** `@effect/vitest` — despite `@effect/vitest` being a devDependency. Tests for `docker` and `podman` mock `node:child_process` at file top via `vi.mock()`. `vercel.test.ts` only tests construction (no CLI calls to mock). New provider tests should follow this structure:

- `apple-containers.test.ts`: top-level `vi.mock("node:child_process")`; test pre-flight failures by making `execFile` error; test `container run` argv via `spawn` call inspection.
- `github-codespaces.test.ts`: mock the `gh` CLI calls; use discriminated union fixture for `mode: "existing"` vs `mode: "managed"`.
- Both: test `mergeProviderEnv` overlap throws (can import `mergeProviderEnv` directly).

#### `src/syncOut.ts` — **Commit extraction for isolated providers**

The full three-phase extraction (committed patches via `git format-patch` + `git am`, uncommitted diffs, untracked files via `copyFileOut`) is already implemented and driven by the orchestrator via the `IsolatedSandboxHandle`. `github-codespaces` only needs to implement the handle's `exec`, `copyIn`, `copyFileOut`, and `close` methods — no changes to `syncOut.ts`.

### Out of Scope

The following modules are not implicated by the two new providers and must not be modified:

- `src/Orchestrator.ts` — iteration loop is provider-agnostic; no changes needed.
- `src/run.ts` / `src/interactive.ts` — accept any `SandboxProvider`; no changes needed.
- `src/createWorktree.ts` / `src/WorktreeManager.ts` — worktree lifecycle is provider-agnostic.
- `src/AgentProvider.ts` — agent provider is independent of sandbox provider.
- `src/InitService.ts` — `sandcastle init` template selection remains Docker/Podman-only (per out-of-scope).
- `src/DockerLifecycle.ts` / `src/PodmanLifecycle.ts` — no changes needed (apple-containers will have its own lifecycle helpers or inline them).
- `src/syncIn.ts` / `src/syncOut.ts` — isolated sync path works through handle methods; no changes needed.
- `src/SandboxFactory.ts` — factory is provider-agnostic.
- `src/EnvResolver.ts`, `src/PromptArgumentSubstitution.ts`, `src/PromptPreprocessor.ts` — unrelated subsystems.
- All `src/templates/` — no new init template for either provider in v1.

### New Integration Points

| New file                                                 | Landing location                         | Notes                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/sandboxes/apple-containers.ts`                      | Mirrors `docker.ts` / `podman.ts` shape  | Uses `createBindMountSandboxProvider`; no new lifecycle helper file needed unless shared helpers are extracted |
| `src/sandboxes/apple-containers.test.ts`                 | Alongside source file                    | `vi.mock("node:child_process")` pattern                                                                        |
| `src/sandboxes/github-codespaces.ts`                     | Mirrors `vercel.ts` / `daytona.ts` shape | Uses `createIsolatedSandboxProvider`; no SDK peer dep — pure `gh` CLI shelling                                 |
| `src/sandboxes/github-codespaces.test.ts`                | Alongside source file                    | Mock `gh` CLI calls                                                                                            |
| Optional: `src/sandboxes/_shared/containerPreflights.ts` | New shared module                        | If apple-containers + podman pre-flight logic is extracted per the non-disruptive refactor allowance           |

---

## 5. Notes

- **`IsolatedSandboxHandle` lacks `stdin` in `exec` options.** `BindMountSandboxHandle.exec` accepts `stdin?: string`; `IsolatedSandboxHandle.exec` does not. This inconsistency may affect `github-codespaces` if `gh codespace exec` needs to pipe stdin (e.g. for large prompt text). Flag as delivery risk per Q1 pattern.

- **No `@effect/vitest` usage in provider unit tests despite devDependency.** The devDependency is declared (`"@effect/vitest": "^0.28.0"`) but provider tests (`docker.test.ts`, `podman.test.ts`, `vercel.test.ts`) use plain vitest. The request asks for `@effect/vitest` for new provider tests; this is additive and safe, but the team should be aware of the precedent divergence.

- **Isolated providers have no signal handler today.** `vercel.ts` and `daytona.ts` do not register `process.on("exit"/"SIGINT"/"SIGTERM")`. The request requires `github-codespaces` to add best-effort cleanup on those signals. This is new behavior for the isolated provider family and should be noted in the changeset.

- **`tsconfig.build.json` excludes `**/\*.test.ts`and`src/templates/`.** The `postbuild` step (`rm -rf dist/templates && cp -r src/templates dist/templates`) re-injects templates. New provider files have no templates, so no postbuild change is needed. Verify that `apple-containers.ts`and`github-codespaces.ts` are not accidentally excluded by any tsconfig pattern.

# Project Design — `@ai-hero/sandcastle`

This document is the canonical place for the project's evolving technical
design. New design sections are appended; existing sections are not rewritten
without an explicit change request.

Conventions used here mirror `CONTEXT.md`: "sandbox provider", "branch
strategy", "host", "worktree". The terms "backend", "runtime", and
"workspace" are not used in user-facing surfaces — only "sandbox provider"
abstractions.

---

## Apple Containers and GitHub Codespaces Providers Design

**Source plan**: `docs/design/plan-001-apple-containers-and-codespaces-providers.md`
**Source requirements**: `docs/design/requirements-001-apple-containers-and-codespaces-providers.md`
**Investigation**: `docs/reference/investigation-apple-containers-codespaces.md`
**Research**: `docs/research/effect-shell-out-patterns.md`,
`docs/research/codespaces-lifecycle.md`
**Codebase scan**: `docs/reference/codebase-scan-apple-containers-codespaces.md`
**Target package**: `@ai-hero/sandcastle@0.5.7` (pre-1.0, ESM, TypeScript,
Effect.ts 3.20)

This section specifies the technical design for two new sandbox providers:

- `apple-containers` — bind-mount provider driving Apple's native `container`
  CLI on Apple Silicon macOS. Architectural twin of `docker()` / `podman()`.
- `github-codespaces` — isolated provider driving the `gh codespace` CLI in
  two modes (`existing`, `managed`). Architectural twin of `vercel()` /
  `daytona()`, with the addition of signal-handler-driven cleanup.

Both ship in a single `patch` changeset against `@ai-hero/sandcastle@0.5.7`.

---

### 1. Architecture

#### 1.1 Layered placement

Each provider sits at the same layer as `docker.ts` / `podman.ts` (for
`apple-containers`) and `vercel.ts` / `daytona.ts` (for `github-codespaces`).
The factory → handle → close lifecycle for both is:

```
Caller (run() / interactive() / createSandbox())
        │
        ▼
[ provider factory ]                  ←  appleContainers(opts) | githubCodespaces(opts)
        │  returns BindMountSandboxProvider | IsolatedSandboxProvider
        │
        ▼
[ create(BindMountCreateOptions | IsolatedCreateOptions) ]   ←  invoked by SandboxFactory
        │
        ├─ pre-flight checks  (typed errors on failure)
        ├─ provision sandbox  (container run | gh codespace create + poll)
        ├─ register signal handlers  (process.on exit/SIGINT/SIGTERM)
        │
        ▼
[ BindMountSandboxHandle | IsolatedSandboxHandle ]
        │
        ▼
[ Orchestrator + syncOut + agent loop ]
        │
        ▼
[ handle.close() ]
        │
        ├─ removeListener exit/SIGINT/SIGTERM
        └─ tear down sandbox  (container delete -f | gh codespace delete --force)
```

The provider exports plug into `package.json#exports` as alphabetically-sorted
ESM subpaths:

```jsonc
{
  "exports": {
    "./sandboxes/apple-containers": {
      "import": "./dist/sandboxes/apple-containers.js",
      "types": "./dist/sandboxes/apple-containers.d.ts",
    },
    "./sandboxes/github-codespaces": {
      "import": "./dist/sandboxes/github-codespaces.js",
      "types": "./dist/sandboxes/github-codespaces.d.ts",
    },
  },
}
```

`apple-containers` slots immediately before `./sandboxes/daytona`;
`github-codespaces` slots between `./sandboxes/docker` and
`./sandboxes/no-sandbox`. The root entry (`@ai-hero/sandcastle`) does not
re-export either provider; callers must import the subpath explicitly.

`package.json` is owned by Unit C (per plan §3). Units A and B never edit
it.

#### 1.2 Lifecycle data flow

##### Apple Containers (bind-mount)

```
build-image (out-of-band; user runs `container build -t <img> .`)
   │
   ▼
appleContainers({ imageName, mounts, env, network })
   │
   ▼ create(BindMountCreateOptions { worktreePath, hostRepoPath, mounts, env })
   │
   ├─ pre-flight 1: arch check         (sync — no I/O)
   ├─ pre-flight 2: container --version
   ├─ pre-flight 3: container system status --format json
   ├─ pre-flight 4: container image inspect <imageName>
   │
   ├─ build argv via buildRunArgs(...)
   ├─ container run -d --rm --name sandcastle-<uuid> -w <sandboxWorktree>
   │                -u <uid>:<gid> -v <hostWorktree>:<sandboxWorktree>
   │                [-v userMounts] [-e env] [--network n] <image> sleep infinity
   │
   ├─ register process.on("exit", onExit)
   ├─ register process.on("SIGINT" | "SIGTERM", onSignal)
   │
   ▼
BindMountSandboxHandle { worktreePath, exec, interactiveExec,
                          copyFileIn, copyFileOut, close }
   │
   ▼ run loop drives handle.exec(...) repeatedly
   │
   ▼ close()
   ├─ process.removeListener exit/SIGINT/SIGTERM
   └─ container delete -f <containerName>
```

Files cross the boundary by host-side filesystem only — Apple `container`
exposes no `cp` subcommand and the worktree is bind-mounted, so
`copyFileIn` / `copyFileOut` use `node:fs/promises` (`mkdir -p` +
`copyFile`) directly against the host worktree.

##### GitHub Codespaces (isolated)

```
githubCodespaces({ mode, ... })
   │
   ▼ create(IsolatedCreateOptions { env })
   │
   ├─ pre-flight 1: gh --version
   ├─ pre-flight 2: gh auth status
   │
   ├─ if mode === "existing":
   │     ├─ gh codespace view -c <name> --json state -q .state
   │     ├─ if state === "Shutdown": gh api --method POST /user/codespaces/<name>/start
   │     ├─ poll gh codespace view ... until "Available" or terminal-failure
   │     ├─ resolve worktreePath:
   │     │     repoCwdInCodespace ?? "/workspaces/" + basename(repository.full_name)
   │     │     where repository.full_name is fetched once via
   │     │     gh codespace view -c <name> --json repository -q .repository.full_name
   │     └─ register signal handlers (no-op cleanup)
   │
   ├─ if mode === "managed":
   │     ├─ gh codespace create -R <repo> [--branch] [--machine] [--location]
   │     │                       [--devcontainer-path] [--idle-timeout <N>m]
   │     │                       [-d <displayName>] --default-permissions
   │     ├─ capture stdout (codespace name)
   │     ├─ poll gh codespace view -c <name> --json state -q .state
   │     │     until "Available" or terminal-failure
   │     │     (default pollIntervalMs=3000, createTimeoutMs=600_000)
   │     ├─ resolve worktreePath = "/workspaces/" + basename(repo)
   │     └─ register signal handlers (delete --force unless keepOnFailure)
   │
   ▼
IsolatedSandboxHandle { worktreePath, exec, copyIn, copyFileOut, close }
   │
   ▼ run loop drives handle.exec(...) — every call shells through
   │  gh codespace ssh -c <name> -- bash -c '<cwd-prefixed cmd>'
   │
   ▼ syncOut.ts (orchestrator) drives the same handle to extract commits
   │  via git format-patch + handle.copyFileOut → host-side git am --3way
   │
   ▼ close()
   ├─ process.removeListener exit/SIGINT/SIGTERM
   ├─ if mode === "existing": no-op
   └─ if mode === "managed": gh codespace delete -c <name> --force
```

`syncOut.ts` is reused unchanged. The provider only supplies the four
`IsolatedSandboxHandle` methods plus `worktreePath`; commit extraction is the
orchestrator's responsibility.

---

### 2. Component Contracts

#### 2.1 Apple Containers — `src/sandboxes/apple-containers.ts`

##### 2.1.1 Factory

```typescript
export const appleContainers = (
  options?: AppleContainersOptions,
): SandboxProvider;
```

Signature, defaults, and validation:

| Field       | Type                          | Default                                              | Validation                                                                                                                                                                                                     |
| ----------- | ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imageName` | `string`                      | `defaultImageName(hostRepoPath)`                     | If undefined, derive in `create()` from `BindMountCreateOptions.hostRepoPath` (mirrors `docker.ts`). Never silently fall back to a literal — the derivation is an explicit project convention, not a fallback. |
| `mounts`    | `readonly MountConfig[]`      | `[]` (handled by `resolveUserMounts`)                | Each entry passes through `resolveUserMounts(mounts, sandboxHomedir)`; `hostPath` is tilde-expanded; missing host paths cause a typed error from the existing helper.                                          |
| `env`       | `Record<string, string>`      | `{}`                                                 | Captured into `BindMountSandboxProvider.env`; merge with agent-provider env via `mergeProviderEnv` — overlap throws.                                                                                           |
| `network`   | `string \| readonly string[]` | `undefined` (uses Apple `container` default network) | When set, becomes one or more `--network <n>` flags.                                                                                                                                                           |

The factory delegates to `createBindMountSandboxProvider({ name:
"apple-containers", env, sandboxHomedir: "/home/agent", create })`. The
`tag: "bind-mount"` discriminator is set automatically.

##### 2.1.2 Pre-flight order (in `create()`)

| #   | Check                                                       | Helper                             | Failure error                                                                                                                                                                         |
| --- | ----------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `process.platform === "darwin" && process.arch === "arm64"` | `checkApplePlatform()` (sync)      | `AppleContainerError("apple-containers requires an Apple Silicon Mac (darwin/arm64). Detected platform=<p> arch=<a>.")`                                                               |
| 2   | `container --version` resolves on PATH                      | `checkContainerCli()` (`execFile`) | `AppleContainerError("Apple 'container' CLI not found on PATH. Install from https://github.com/apple/container")` (on `ENOENT`) — generic message wrapping `error.message` otherwise. |
| 3   | `container system status --format json` exits zero          | `checkContainerSystem()`           | `AppleContainerError("Apple 'container' system is not running. Start it with: container system start")`                                                                               |
| 4   | `container image inspect <imageName>` exits zero            | `checkContainerImageExists(name)`  | `AppleContainerError("Image '<name>' not found locally. Build it first with: container build -t <name> .")`                                                                           |

Pre-flights run in strict sequential order; the first failure short-circuits.

##### 2.1.3 Argv reference (frozen by tests)

`buildRunArgs(opts)` is exported (or file-private and reachable for the test)
so argv can be asserted exactly. Argv ordering:

```
container run
  -d
  --rm
  --name sandcastle-<uuid>
  -w <sandboxWorktreePath>          // default: /home/agent/workspace
  -u <hostUid>:<hostGid>            // from os.userInfo() / process.getuid()/getgid()
  -v <hostWorktreePath>:<sandboxWorktreePath>
  [-v <userMount.hostPath>:<userMount.sandboxPath>[:ro]]   // repeated
  [-e KEY=VALUE]                                            // repeated
  [--network <n>]                                           // repeated for array
  <imageName>
  sleep infinity
```

`exec` argv:

```
container exec
  [-i]                       // when stdin defined
  [-w <cwd>]
  <containerName>
  bash -c <effectiveCommand> // sudo prefix applied to command, not argv
```

`interactiveExec` argv:

```
container exec
  -it | -i                   // TTY-detected from opts.stdin.isTTY
  [-w <cwd>]
  <containerName>
  <args...>
```

Teardown argv: `container delete -f <containerName>`.

##### 2.1.4 Handle method contract

| Method            | Mechanism                                                                                                   | Error mapping                                                                                                                               | Exit code                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `worktreePath`    | string (from `BindMountCreateOptions.mounts` lookup, fallback `"/home/agent/workspace"`)                    | n/a                                                                                                                                         | n/a                                                         |
| `exec`            | `spawn("container", [...])` + `readline.createInterface`                                                    | `proc.on("error", e) → reject Error("container exec failed: <e.message>"))`; non-zero exit codes resolve normally with `exitCode` populated | `code ?? 0` (signal-killed → 0, mirrors existing providers) |
| `interactiveExec` | `spawn("container", [...], { stdio: [stdin, stdout, stderr] })`                                             | Same shape as `docker.ts`                                                                                                                   | `code ?? 0`                                                 |
| `copyFileIn`      | `mkdir(dirname(sandboxPath), { recursive: true }) → copyFile(hostPath, sandboxPath)` (host filesystem only) | `node:fs/promises` rejection passes through                                                                                                 | n/a                                                         |
| `copyFileOut`     | `mkdir(dirname(hostPath), { recursive: true }) → copyFile(sandboxPath, hostPath)` (host filesystem only)    | Same                                                                                                                                        | n/a                                                         |
| `close`           | Remove signal listeners → `execFile("container", ["delete", "-f", containerName])`                          | `Error("container delete failed: <e.message>")`                                                                                             | n/a                                                         |

##### 2.1.5 Signal handler registration and cleanup order

Registered immediately after `container run` returns success:

```typescript
const onExit = () => {
  try {
    execFileSync("container", ["delete", "-f", containerName], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch {
    /* best-effort */
  }
};
const onSignal = () => {
  onExit();
  process.exit(1);
};
process.on("exit", onExit);
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
```

On `close()`, the order is:

1. `process.removeListener("exit", onExit)`
2. `process.removeListener("SIGINT", onSignal)`
3. `process.removeListener("SIGTERM", onSignal)`
4. `await execFile("container", ["delete", "-f", containerName])`

The synchronous `execFileSync` in `onExit` is intentional — by the time the
`"exit"` event fires, the Node event loop is draining and async work is not
guaranteed to complete (per `docker.ts`).

##### 2.1.6 Branch strategies

All three are accepted: `head` (default), `merge-to-head`, `branch`. Apple
Containers is a `BindMountSandboxProvider`, so the type system already
permits all three through `BindMountBranchStrategy`. No runtime guard.

#### 2.2 GitHub Codespaces — `src/sandboxes/github-codespaces.ts`

##### 2.2.1 Factory

```typescript
export const githubCodespaces = (
  options: GitHubCodespacesOptions,
): IsolatedSandboxProvider;
```

`options` is **required** (the discriminated union has no default mode).

Discriminated union shape:

```typescript
export interface GitHubCodespacesExistingOptions {
  readonly mode: "existing";
  readonly name: string; // REQUIRED
  readonly repoCwdInCodespace?: string; // override worktreePath derivation
  readonly env?: Record<string, string>;
  readonly token?: string; // injected as GH_TOKEN
  readonly pollIntervalMs?: number; // default 3000
  readonly createTimeoutMs?: number; // default 600_000
}

export interface GitHubCodespacesManagedOptions {
  readonly mode: "managed";
  readonly repo: string; // REQUIRED, "owner/repo"
  readonly branch?: string;
  readonly machine?: string;
  readonly region?: string; // → gh's --location
  readonly devcontainerPath?: string;
  readonly idleTimeoutMinutes?: number; // formatted as "<N>m"
  readonly displayName?: string;
  readonly keepOnFailure?: boolean; // default false
  readonly pollIntervalMs?: number; // default 3000
  readonly createTimeoutMs?: number; // default 600_000
  readonly env?: Record<string, string>;
  readonly token?: string;
}

export type GitHubCodespacesOptions =
  | GitHubCodespacesExistingOptions
  | GitHubCodespacesManagedOptions;
```

Defaults applied per research §"Recommended Default Values":

- `pollIntervalMs: 3_000` (well under the 5,000 req/hr primary rate limit
  — at 3s polling for 10 min, ~200 requests).
- `createTimeoutMs: 600_000` (covers cold-start p95 for complex repos).
- `stopOnClose: false` — the design does **not** expose a `stopOnClose`
  option on either mode. Managed mode goes straight to `delete --force`
  (research §"stop vs delete"). Existing mode is a no-op cleanup
  (per requirements §17). This decision is recorded in §6 ADRs.
- `deleteOnClose: true` for `mode: "managed"` (implicit; not a separate
  option).
- `deleteOnClose: false` for `mode: "existing"` (implicit; the provider
  never deletes a Codespace it did not create).

Validation:

- `mode: "existing"` requires `name` (TypeScript enforced).
- `mode: "managed"` requires `repo` (TypeScript enforced).
- Both modes: missing required values throw — never silently fall back
  (per project rule).

##### 2.2.2 Pre-flight order (in `create()`)

| #   | Check                                                                                                                      | Helper                                   | Failure error                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `gh --version` resolves on PATH                                                                                            | `checkGhCli(spawnEnv)`                   | `CodespacesError("'gh' CLI not found on PATH. Install from https://cli.github.com")` (on `ENOENT`)                        |
| 2   | `gh auth status` exits zero                                                                                                | `checkGhAuth(spawnEnv)`                  | `CodespacesError("'gh' is not authenticated or lacks the 'codespace' scope. Run: gh auth login --scopes codespace,repo")` |
| 3   | (existing only) `gh codespace view -c <name>`                                                                              | `checkExistingCodespace(spawnEnv, name)` | `CodespacesError("Codespace '<name>' not found or inaccessible: <stderr>")`                                               |
| 4   | (managed only) flag-validation only — actual `gh codespace create` deferred to the lifecycle step (per requirements §12.4) | inline                                   | n/a                                                                                                                       |

##### 2.2.3 `gh` argv reference (frozen by tests)

```
gh --version
gh auth status

gh codespace view -c <name> --json state -q .state
gh codespace view -c <name> --json repository -q .repository.full_name

gh codespace create
  -R <repo>
  [--branch <b>]
  [--machine <m>]
  [--location <region>]
  [--devcontainer-path <p>]
  [--idle-timeout <N>m]
  [-d <displayName>]
  --default-permissions          // ALWAYS present

gh api --method POST /user/codespaces/<name>/start

gh codespace ssh -c <name> -- bash -c <remoteCmd>
gh codespace cp -r -c <name> <localPath> remote:<remotePath>      // copyIn
gh codespace cp -c <name> remote:<remotePath> <localPath>          // copyFileOut
gh codespace delete -c <name> --force
```

Notes:

- `--default-permissions` is **always** included in the `create` argv.
  Without it, `gh codespace create` blocks on stdin for permission
  confirmation in non-TTY environments (research §"Best Practices" #1).
- The `-e/--expand` flag for `gh codespace cp` is **never** used —
  `remote:` paths are absolute and literal (research §"Recommended
  implementation approach" item 2).
- `gh codespace start` does not exist as a CLI subcommand;
  `gh api --method POST /user/codespaces/<name>/start` is the canonical
  start path (research §"Start a stopped Codespace").

##### 2.2.4 State-machine poll loop

```typescript
const TERMINAL_FAILURE_STATES = new Set([
  "Failed",
  "Unavailable",
  "Unknown",
  "Deleted",
  "Moved",
  "Archived",
]);

// Available     => success; resolve.
// Failed et al  => reject CodespacesError("Codespace entered terminal state: <state>").
// otherwise     => transient; sleep(pollIntervalMs); poll again.
// deadline hit  => reject CodespacesError("Codespace did not reach Available within <ms>ms (last state: <state>)").
```

Transient states observed in normal flows (per research §"Complete State
Enum"): `Created`, `Queued`, `Provisioning`, `Awaiting`, `Starting`,
`Rebuilding`, `Updating`, `ShuttingDown`, `Shutdown` (existing mode only),
`Exporting`. `Shutdown` triggers an explicit `gh api ... /start` call only
in `mode: "existing"` (managed flow never observes `Shutdown` because the
Codespace is freshly created).

##### 2.2.5 Token injection (CI parity with `vercel.token`)

```typescript
const resolveSpawnEnv = (token?: string): NodeJS.ProcessEnv =>
  token !== undefined ? { ...process.env, GH_TOKEN: token } : process.env;
```

Every `spawn`/`execFile`/`execFileSync` call against `gh` receives this env
object via the `env` option. `process.env` is **never** mutated — see
ADR §6.4.

##### 2.2.6 Handle method contract

| Method         | Mechanism                                                                                                                                                                                         | Error mapping                                                                                        | Exit code   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| `worktreePath` | string, derived per mode (see §1.2)                                                                                                                                                               | n/a                                                                                                  | n/a         |
| `exec`         | `spawn("gh", buildSshArgs(name, cwdPrefixedCmd), { env: spawnEnv, stdio: [stdin?"pipe":"ignore", "pipe", "pipe"] })` + `readline.createInterface`; pipes `opts.stdin` to child stdin and `end()`s | `proc.on("error", e) → reject Error("gh codespace ssh failed: <e.message>")`; non-zero codes resolve | `code ?? 0` |
| `copyIn`       | `execFile("gh", buildCpArgs("in", name, host, sandbox), { env: spawnEnv })`                                                                                                                       | `Error("gh codespace cp (in) failed: <e.message>")`                                                  | n/a         |
| `copyFileOut`  | `execFile("gh", buildCpArgs("out", name, sandbox, host), { env: spawnEnv })`                                                                                                                      | `Error("gh codespace cp (out) failed: <e.message>")`                                                 | n/a         |
| `close`        | Remove signal listeners → mode-specific cleanup                                                                                                                                                   | `Error("gh codespace delete failed: <e.message>")` (managed only)                                    | n/a         |

`exec` constructs the remote command as:

```typescript
const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
const remoteCmd = opts?.cwd
  ? `cd ${opts.cwd} && ${effectiveCommand}`
  : effectiveCommand;
const args = [
  "codespace",
  "ssh",
  "-c",
  codespaceName,
  "--",
  "bash",
  "-c",
  remoteCmd,
];
```

Stdin piping mirrors the `docker.ts` / `podman.ts` pattern: when
`opts.stdin !== undefined`, set `stdio[0] = "pipe"`, `proc.stdin.write(stdin)`,
`proc.stdin.end()`. Confirmed compatible with `IsolatedSandboxHandle.exec`'s
`stdin?: string` field (per investigation §Q3 codebase-scan correction —
`IsolatedSandboxHandle.exec` already accepts `stdin`).

##### 2.2.7 Signal handler registration

Both modes register handlers immediately after the Codespace reaches
`Available`:

```typescript
const onExit = () => {
  if (mode === "managed" && !options.keepOnFailure) {
    try {
      execFileSync("gh", ["codespace", "delete", "-c", name, "--force"], {
        stdio: "ignore",
        timeout: 10_000,
        env: spawnEnv,
      });
    } catch {
      /* best-effort */
    }
  }
  // mode === "existing": no-op (never delete a user-owned Codespace).
};
const onSignal = () => {
  onExit();
  process.exit(1);
};
process.on("exit", onExit);
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
```

`close()` removes the listeners, then:

- `mode: "existing"`: returns; no remote cleanup.
- `mode: "managed"`: `await execFile("gh", ["codespace", "delete", "-c",
codespaceName, "--force"], { env: spawnEnv })`. Always deletes — the
  `keepOnFailure` flag only protects against signal-driven cleanup
  (per plan §0 O8 ADR).

##### 2.2.8 Branch strategies

`merge-to-head` (default) and `branch`. `head` is excluded by the type
system: `IsolatedSandboxProvider` is constrained by `IsolatedBranchStrategy
= MergeToHeadBranchStrategy | NamedBranchStrategy` (no `HeadBranchStrategy`
arm). No runtime guard required; `// @ts-expect-error` test verifies the
exclusion.

##### 2.2.9 Commit extraction

The provider supplies the four `IsolatedSandboxHandle` methods plus
`worktreePath`. `syncOut.ts` drives the rest unchanged: it issues
`git rev-parse`, `git format-patch`, `git ls-files --others`, `mktemp -d`
through `handle.exec(...)` (with `cwd` set to `worktreePath`), then
streams generated `.patch` files via `handle.copyFileOut`. Host-side
`git am --3way` is performed by `syncOut.ts` itself.

`exec` already accepts `stdin` per the codebase-scan correction in
investigation §Q3. No interface change to `SandboxProvider.ts`.

---

### 3. Error Model

#### 3.1 New tagged errors

Per plan §0 O6, each provider declares its `Data.TaggedError` class
**inside its own provider file** and re-exports it. Neither provider
edits `src/errors.ts` and neither error is added to the
`SandboxError` union there. Rationale: scope discipline — the providers
are independently shippable, and adding to a shared union forces
cross-unit coordination.

```typescript
// src/sandboxes/apple-containers.ts
import { Data } from "effect";
export class AppleContainerError extends Data.TaggedError(
  "AppleContainerError",
)<{ readonly message: string }> {}
```

```typescript
// src/sandboxes/github-codespaces.ts
import { Data } from "effect";
export class CodespacesError extends Data.TaggedError("CodespacesError")<{
  readonly message: string;
}> {}
```

#### 3.2 Error message templates

All messages include the failing CLI command and (when meaningful) the
argv plus exit code. Templates:

| Surface                                      | Template                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-flight, missing CLI                      | `Apple 'container' CLI not found on PATH. Install from https://github.com/apple/container` / `'gh' CLI not found on PATH. Install from https://cli.github.com` |
| Pre-flight, system not running               | `Apple 'container' system is not running. Start it with: container system start`                                                                               |
| Pre-flight, image missing                    | `Image '<name>' not found locally. Build it first with: container build -t <name> .`                                                                           |
| Pre-flight, gh not authenticated             | `'gh' is not authenticated or lacks the 'codespace' scope. Run: gh auth login --scopes codespace,repo`                                                         |
| Pre-flight, codespace not found (existing)   | `Codespace '<name>' not found or inaccessible: <stderr>`                                                                                                       |
| Lifecycle, container start failed            | `container run failed: <e.message>` (argv embedded in `e` already)                                                                                             |
| Lifecycle, container exec error              | `container exec failed: <e.message>`                                                                                                                           |
| Lifecycle, container delete failed           | `container delete failed: <e.message>`                                                                                                                         |
| Lifecycle, gh codespace ssh error            | `gh codespace ssh failed: <e.message>`                                                                                                                         |
| Lifecycle, gh codespace cp (in / out) failed | `gh codespace cp (in) failed: <e.message>` / `gh codespace cp (out) failed: <e.message>`                                                                       |
| Lifecycle, codespace state failure           | `Codespace entered terminal state: <state>`                                                                                                                    |
| Lifecycle, codespace timeout                 | `Codespace did not reach Available within <ms>ms (last state: <state>)`                                                                                        |
| Lifecycle, codespace delete failed           | `gh codespace delete failed: <e.message>`                                                                                                                      |

Non-zero exit codes from `handle.exec(...)` are **not** raised as errors —
they are returned in `ExecResult.exitCode` for the caller to interpret
(matches existing providers; see `syncOut.ts`'s `execOk` helper for the
caller-side check pattern).

---

### 4. Test Strategy

#### 4.1 Mocking pattern

Both `apple-containers.test.ts` and `github-codespaces.test.ts` mock
`node:child_process` at file top (per `docker.test.ts` / `podman.test.ts`
precedent):

```typescript
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual, // keep readline-compatible behaviour
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});
```

`...actual` is critical. `readline.createInterface` consumes `proc.stdout`
which must be an `EventEmitter` capable of supporting the
internal `pipe`/`on('data')` interface. Tests that assert `onLine`
streaming construct the fake `proc` from `EventEmitter` (per research §6.2):

```typescript
const fakeProc = new EventEmitter() as any;
fakeProc.stdout = new EventEmitter();
fakeProc.stderr = new EventEmitter();
fakeProc.stdin = { write: vi.fn(), end: vi.fn() };
mockSpawn.mockReturnValueOnce(fakeProc);
// ... later:
fakeProc.stdout.emit("data", Buffer.from("line1\nline2\n"));
fakeProc.emit("close", 0);
```

Project uses plain `vitest` (`describe`/`it`/`expect`/`vi`) for provider
unit tests, not `@effect/vitest` — the codebase scan confirms this for
`docker.test.ts`, `podman.test.ts`, `vercel.test.ts`. New tests follow
suit. Provider files use `Effect`'s `Data.TaggedError` only as a type
constructor; `Effect.runPromise` is not invoked in either provider.

#### 4.2 Argv snapshot tests (CLI is pre-1.0; pin to prevent silent regression)

Each provider isolates argv construction in named helpers
(`buildRunArgs`, `buildSshArgs`, `buildCpArgs`, `buildCreateArgs`,
`buildDeleteArgs`, `buildViewStateArgs`, `buildStartViaApiArgs`). Tests
assert the produced argv via direct calls to these helpers AND via
inspection of `mockSpawn.mock.calls` / `mockExecFile.mock.calls` for
end-to-end coverage. Both checks are required because:

- Helper-level assertion catches argv-construction bugs.
- Mock-call assertion catches plumbing bugs (wrong helper invoked, env
  not threaded, etc.).

Argv tests pin **exact** flag ordering. Apple `container` CLI is pre-1.0
(per investigation §Q1) and minor releases may break — argv pinning is
the only safety net.

#### 4.3 Type-level tests

For `github-codespaces`, a `// @ts-expect-error` line in the test file
exercises the `head` branch-strategy exclusion:

```typescript
// In src/sandboxes/github-codespaces.test.ts:
import { run } from "../run.js";
import { githubCodespaces } from "./github-codespaces.js";

// @ts-expect-error: 'head' is not assignable to IsolatedBranchStrategy
const _typeCheck1 = (): unknown =>
  run({
    sandbox: githubCodespaces({ mode: "existing", name: "x" }),
    branchStrategy: { type: "head" },
    /* ... */
  });
const _typeCheck2 = (): unknown =>
  run({
    sandbox: githubCodespaces({ mode: "existing", name: "x" }),
    branchStrategy: { type: "merge-to-head" },
    /* ... */
  }); // OK
const _typeCheck3 = (): unknown =>
  run({
    sandbox: githubCodespaces({ mode: "existing", name: "x" }),
    branchStrategy: { type: "branch", branch: "feature" },
    /* ... */
  }); // OK
```

If the `@ts-expect-error` directive becomes a real type-error site (i.e.
the type system stops rejecting `head`), `tsgo` fails the test file's
type check.

For `apple-containers`, an analogous **positive** type-smoke test asserts
all three strategies are accepted (no `@ts-expect-error` needed —
`BindMountBranchStrategy` covers all three).

#### 4.4 Pre-flight tests

Apple Containers:

- `process.platform === "linux"` → throws `AppleContainerError` with the
  arch message.
- `process.arch === "x64"` → throws.
- `mockExecFile` returns `ENOENT` for `container --version` → throws
  with install URL.
- `system status` non-zero → throws with `container system start`
  remediation.
- `image inspect` non-zero → throws naming the image.

GitHub Codespaces:

- `gh --version` ENOENT → throws.
- `gh auth status` non-zero → throws with login command.
- `mode: "existing"` + `gh codespace view` failure → throws.

#### 4.5 State-machine tests for codespaces

Per plan §6.B (TB10–TB12):

- All transient states cycle to `Available` → success.
- Each terminal-failure state (`Failed`, `Unavailable`, `Unknown`,
  `Deleted`, `Moved`, `Archived`) → reject with state in message.
- `pollIntervalMs: 10` + `createTimeoutMs: 30` + always-`Provisioning`
  → reject with timeout error after deadline.

Stderr content from `gh codespace ssh` is **not** asserted (SSH banner
noise per plan §0 O7); only `exitCode` is checked.

---

### 5. Parallelisation

Three units, strictly disjoint file ownership (per plan §3):

| Unit | Owns                                                                                                                 | Touches                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A    | `src/sandboxes/apple-containers.ts`, `src/sandboxes/apple-containers.test.ts`                                        | None outside its own files.                                                                                   |
| B    | `src/sandboxes/github-codespaces.ts`, `src/sandboxes/github-codespaces.test.ts`                                      | None outside its own files.                                                                                   |
| C    | `.changeset/<slug>.md`, `package.json`, `README.md`, `Issues - Pending Items.md`, `docs/design/project-functions.md` | Adds two `exports` entries; adds two README rows + prerequisite bullets; adds new pending items; appends FRs. |

#### 5.1 No-shared-file invariant

The following files are written by exactly one unit and **never** by
another:

- `src/sandboxes/apple-containers.ts` — A only.
- `src/sandboxes/apple-containers.test.ts` — A only.
- `src/sandboxes/github-codespaces.ts` — B only.
- `src/sandboxes/github-codespaces.test.ts` — B only.
- `package.json` — C only.
- `README.md` — C only.
- `.changeset/<slug>.md` — C only.
- `Issues - Pending Items.md` — C only.
- `docs/design/project-functions.md` — C only.

Files explicitly **not** edited by any unit:

- `src/SandboxProvider.ts` (no interface change required —
  `IsolatedSandboxHandle.exec` already accepts `stdin?: string`).
- `src/errors.ts` (per plan §0 O6 — provider errors live in their own
  files).
- `src/cli.ts` (no CLI namespaces in v1; image lifecycle is out-of-band).
- `src/Orchestrator.ts`, `src/run.ts`, `src/interactive.ts`,
  `src/createWorktree.ts`, `src/SandboxFactory.ts`, `src/syncOut.ts`,
  `src/syncIn.ts`, `src/EnvResolver.ts`, `src/InitService.ts`,
  any `src/templates/*` — all out of scope.
- `CLAUDE.md` — sandbox providers are not "tools" in the project's
  tool-conventions sense, so no Tools-section entry is added.

#### 5.2 Sequencing

- Unit A and Unit B are fully independent — they may run in parallel
  (Phase 6 parallel implementation).
- Unit C's source edits (changeset, package.json exports, README,
  Issues file, project-functions.md) are also independent of A and B
  and may run in parallel.
- Unit C's **resolution check** (verify `import "@ai-hero/sandcastle/
sandboxes/apple-containers"` and `.../github-codespaces"` resolve via
  Node's ESM resolver) requires `dist/sandboxes/*.js` from A and B.
  This runs in Phase 8 (dependency validation), after A and B are built.

The sequence diagram:

```
Phase 6 (parallel):  [Unit A] ⫼ [Unit B] ⫼ [Unit C source edits]
Phase 7 (review):    Code review of all three diffs.
Phase 8 (validate):  npm run typecheck → npm run build → Unit C
                      resolution check (verify-exports.mjs) → npm test.
Phase 9 (test build): Tests for A and B run together as part of
                      `npm test` from Phase 8.
Phase 10 (smoke):    Manual integration on real Apple Silicon mac and
                      real GitHub Codespace (out of automated scope).
```

#### 5.3 Discrepancy with the user's prompt: CLI subcommands

The user's prompt mentions
`sandcastle apple-containers build-image` / `remove-image` subcommands
and CLI registration in `src/cli.ts`. The refined requirements doc
(§"Out of scope" line 45) and the plan (§3 Unit C "Files NOT modified by
C") explicitly mark these as out of scope for v1 — image lifecycle is
performed out-of-band by the user.

**Resolution**: this design follows the requirements + plan. A future
plan-002 may add CLI namespaces; this design does not. If the user
intends to lift the out-of-scope marker, the requirements doc must be
amended and a separate unit must be added to the plan (it would touch
`src/cli.ts` and would not be parallelisable with anything else that
touches the same file).

---

### 6. Architectural Decisions (ADRs)

The following decisions are recorded with their rationale. All are
binding for this design unless explicitly amended in a follow-up plan.

#### ADR §6.1 — Mirror `docker.ts` / `podman.ts` for `apple-containers`; do not extract a shared `_shared/containerCli.ts` module

Rationale: Apple's `container` CLI is 95% Docker-compatible but has
divergences (no `cp`, different `system` lifecycle commands, faster
churn — pre-1.0). A shared abstraction is tempting but premature: the
divergences are exactly what a single-file mirror handles cleanly.
Defer extraction until both providers are stable in production.

#### ADR §6.2 — Use `gh codespace ssh -- <cmd>` exclusively; never `gh codespace exec`

Rationale: `gh codespace exec` does not exist as a subcommand
(investigation §Q2 conclusive against the requirements doc's A3
assumption). `gh codespace ssh -- <cmd>` is the only documented path
for non-interactive remote command execution. This eliminates an entire
class of version-detection code.

#### ADR §6.3 — Skip `gh codespace cp -e/--expand`; pass absolute remote paths verbatim

Rationale: `-e` evaluates the remote path as a Bash expression,
introducing quoting and injection risk. Sandcastle controls all paths
absolutely; expansion adds no value. Confirmed by research §"`gh
codespace cp` semantics".

#### ADR §6.4 — Inject `GH_TOKEN` via `{ ...process.env, GH_TOKEN: token }`; never mutate `process.env`

Rationale: mutating `process.env` would leak secrets across providers
within a single Node process and would survive across calls in long-lived
CLI runs. The new-object pattern matches `vercel.token` and is testable.
Test TB19 verifies `process.env` is unchanged after the call.

#### ADR §6.5 — `keepOnFailure` only protects signal-driven cleanup; normal `close()` always deletes (managed mode)

Rationale: `IsolatedSandboxHandle.close()` does not currently receive a
`runFailed` flag from the orchestrator. Plumbing one through is a
separate, larger change to `Orchestrator.ts` / `SandboxFactory.ts`
(per plan §0 O8). Until that change lands, `keepOnFailure: true`
provides the narrow guarantee: SIGINT/SIGTERM during a run will not
delete the Codespace, so the user can inspect it after a process kill.
Normal `close()` (clean shutdown) always deletes. This limitation is
recorded in `Issues - Pending Items.md` as a known scope constraint.

#### ADR §6.6 — Default `pollIntervalMs: 3_000` and `createTimeoutMs: 600_000` for `mode: "managed"`

Rationale: research §"Recommended Default Values". At 3s polling for
10 min: ~200 GET requests, ~720 req/hr — well under the 5,000 req/hr
primary rate limit. 10 min covers cold-start p95 for complex repos.

#### ADR §6.7 — Always include `--default-permissions` in `gh codespace create` argv

Rationale: research §"Best Practices" #1. Without it, `create` blocks on
stdin in non-TTY environments. The provider always operates without a
TTY (subprocess of Sandcastle), so the flag is mandatory.

#### ADR §6.8 — `apple-containers` uses host filesystem for `copyFileIn` / `copyFileOut`; no `container cp` shim

Rationale: bind-mount semantics make the boundary transparent
(investigation §Q1 — Apple `container` has no `cp` subcommand, but the
bind-mount makes one unnecessary). The host worktree IS the sandbox
worktree; `node:fs/promises.copyFile` operates on both ends.

#### ADR §6.9 — Provider tagged errors live in their provider files; no edits to `src/errors.ts`'s `SandboxError` union

Rationale: per plan §0 O6 — keeps Unit A and Unit B fully independent of
shared files, removes a merge-conflict source. The trade-off is that
`SandboxError` is no longer a fully-closed union; `try/catch` consumers
who pattern-match on `_tag` can still detect the new errors at runtime,
they just are not exhaustively typed at the union level. Acceptable for
the current scope.

#### ADR §6.10 — CLI namespaces for `apple-containers` and `github-codespaces` ARE included (amended 2026-05-02)

**Original**: deferred CLI subcommands to a follow-up plan to avoid touching
`src/cli.ts` and breaking parallelisation.

**Amendment**: the project owner directed CLI namespaces in during the
design review (mirroring docker/podman's UX is required for parity).
Resolution: Units A and B export their `Command.make` builders from
their own provider files (`buildImageCommand`, `removeImageCommand` for
apple-containers; `verifyCommand` for github-codespaces — `verify`
replaces `build-image`/`remove-image` because Codespaces use dev
containers, not local images). Unit C (sequential after A/B) wires
them into `src/cli.ts`. Parallelisation invariant preserved.

#### ADR §6.11 — `init` template wiring (amended 2026-05-02)

**Original**: skipped to keep v1 small.

**Amendment**: both providers are registered as `SandboxProviderEntry`
rows in `InitService.ts` so they appear in `sandcastle init`'s provider
selector. Apple-containers carries an image build step like docker;
github-codespaces skips the build step (no local image). Dockerfile
template substitution remains docker/podman-only — out of scope for
this rollout.

#### ADR §6.12 — Continue using `node:child_process` directly; do not adopt `@effect/platform`'s `Command` module

Rationale: research §"Why the project uses raw `node:child_process`
instead". Adopting `Command` would either change the
`SandboxProvider`'s Promise-based handle interface to Effect-based, or
require `Effect.runPromise(...)` per `exec` call. Both are larger
changes than this design warrants. The `Effect` boundary is
`create()`'s `await` only.

#### ADR §6.13 — No new `@octokit/*` dependency; `gh api` is the REST proxy

Rationale: requirements §"Out of scope" item 7. `gh api --method POST
/user/codespaces/<name>/start` covers the only REST-only operation
(starting a stopped Codespace) without adding a peer dep. The investigation
§Q2 confirms `gh api` is suitable.

#### ADR §6.14 — `apple-containers` registers signal handlers; this matches `docker.ts` but diverges from `vercel.ts` / `daytona.ts`

Rationale: bind-mount providers must clean up local containers (orphaned
containers consume disk and ports). Existing isolated providers (vercel,
daytona) do not register handlers today, but `github-codespaces`
**does** — leaked managed Codespaces incur per-minute CPU charges
(research §"Best Practices" #4). The divergence is intentional.

---

### 7. Acceptance Criteria

This design is implemented when all of the following hold:

1. `npm run typecheck` passes.
2. `npm run build` passes; `dist/sandboxes/apple-containers.{js,d.ts}` and
   `dist/sandboxes/github-codespaces.{js,d.ts}` exist.
3. `npm test` passes; the test cases in plan §6.A and §6.B are all green.
4. `import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers"`
   resolves; the export is a callable factory.
5. `import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces"`
   resolves; the export is a callable factory.
6. `package.json#exports` keys are alphabetically sorted; both new entries
   present.
7. README's Sandbox Providers table has rows for both providers and
   uses canonical `CONTEXT.md` terminology.
8. README's Prerequisites lists `container` CLI and `gh` CLI.
9. Exactly one new `.changeset/*.md` file with `"@ai-hero/sandcastle":
patch` describing both providers.
10. `Issues - Pending Items.md` contains:
    - `keepOnFailure` is signal-only until orchestrator plumbing exists
      (ADR §6.5).
    - `gh codespace cp` does not preserve symlinks (research note).
    - Apple `container` runtime is pre-1.0; argv may break on minor
      releases (mitigated by argv-pinning tests).
11. No diffs to `src/SandboxProvider.ts`, `src/errors.ts`, `src/cli.ts`,
    `src/Orchestrator.ts`, `src/run.ts`, `src/interactive.ts`,
    `src/syncOut.ts`, `src/syncIn.ts`, `CLAUDE.md`, or any file outside
    the units' ownership map.

Manual smoke tests (requirements §8 and §9) are deferred to Phase 10
and are out of automated scope.

---

### 8. Risks and Mitigations

| #   | Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                             |
| --- | --------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Apple `container` CLI argv breaks on a minor release (it is pre-1.0).       | Medium     | Medium | Pin argv via `buildRunArgs`/`buildExecArgs` helper tests; document risk in changeset and `Issues - Pending Items.md`.                  |
| R2  | Codespaces are Linux-x86_64 only; agent images that hard-code `arm64` fail. | Low        | Low    | Document in `github-codespaces.ts` JSDoc and README prerequisites.                                                                     |
| R3  | `gh codespace` rate limits trip during dense polling.                       | Low        | Medium | Default `pollIntervalMs: 3_000` keeps load far below the 5,000 req/hr primary limit; transient states keep polling without escalation. |
| R4  | `gh codespace ssh` SSH-banner noise on stderr causes test false positives.  | Medium     | Low    | Tests assert exit code only, never stderr content (plan §0 O7).                                                                        |
| R5  | `keepOnFailure` does not yet receive a `runFailed` flag.                    | Medium     | Medium | Documented as ADR §6.5; signal-only protection; pending item recorded.                                                                 |
| R6  | `gh codespace cp` dereferences symlinks.                                    | Low        | Low    | Documented in JSDoc and pending items; no workaround in v1.                                                                            |
| R7  | macOS-26 hard requirement for Apple `container` not detectable from Node.   | Low        | Low    | Skip programmatic OS-version probe; rely on `container system status` failure for actionable error.                                    |
| R8  | `process.env` mutation could leak `GH_TOKEN` across providers.              | Low        | High   | ADR §6.4: always copy env into a new object; test TB19 verifies `process.env` is unchanged.                                            |
| R9  | UID/GID may not be honoured by all images on Apple `container`.             | Medium     | Medium | Open question (Q4 in requirements); ship as-is; flag in `Issues - Pending Items.md`.                                                   |
| R10 | Three-unit parallel build introduces a race on `package.json`.              | Low        | High   | Plan §4 invariants enforce no-shared-file via `git diff` checks at Phase 8.                                                            |
| R11 | `--default-permissions` semantics change in a future `gh` release.          | Low        | Medium | Argv-pinning tests catch the regression; doc cross-references research §"Best Practices" #1.                                           |

---

### 9. References

| Source                                                                      | Used for                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/design/requirements-001-apple-containers-and-codespaces-providers.md` | Functional / non-functional requirements; acceptance.                     |
| `docs/design/plan-001-apple-containers-and-codespaces-providers.md`         | Unit breakdown; ownership map; test cases; sequencing.                    |
| `docs/reference/investigation-apple-containers-codespaces.md`               | Apple `container` surface; `gh codespace` surface.                        |
| `docs/research/effect-shell-out-patterns.md`                                | Promise vs Effect boundary; mocking pattern.                              |
| `docs/research/codespaces-lifecycle.md`                                     | State machine; defaults; `gh` argv reference.                             |
| `docs/reference/codebase-scan-apple-containers-codespaces.md`               | Module map; integration points; subpath ordering.                         |
| `src/sandboxes/podman.ts`                                                   | Pre-flight helper pattern; signal handlers.                               |
| `src/sandboxes/docker.ts`                                                   | Bind-mount factory + handle template.                                     |
| `src/sandboxes/vercel.ts`                                                   | Isolated factory + handle template.                                       |
| `src/sandboxes/daytona.ts`                                                  | Second isolated reference.                                                |
| `src/SandboxProvider.ts`                                                    | `BindMountSandboxHandle`, `IsolatedSandboxHandle`, branch-strategy types. |
| `src/errors.ts`                                                             | `Data.TaggedError` pattern (errors live elsewhere for new providers).     |
| `src/syncOut.ts`                                                            | Commit extraction reuse — no changes needed.                              |
| `CONTEXT.md`                                                                | Canonical terminology.                                                    |

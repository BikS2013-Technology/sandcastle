# Project Functional Requirements — `@ai-hero/sandcastle`

This document tracks the functional requirements (FRs) of the Sandcastle library and CLI. Each FR is registered when introduced or materially modified by a plan in `docs/design/plan-*.md`.

Terminology follows `CONTEXT.md`: "sandbox provider", "branch strategy", "host", "worktree" — never "backend", "runtime", or "workspace".

---

## Sandbox Providers

### FR-001 — `apple-containers` sandbox provider

- **Status**: Planned in `docs/design/plan-001-apple-containers-and-codespaces-providers.md`; pending implementation.
- **Type**: Bind-mount sandbox provider.
- **Subpath export**: `@ai-hero/sandcastle/sandboxes/apple-containers`.
- **Description**: The library MUST support `apple-containers` as a bind-mount sandbox provider that drives Apple's native `container` CLI on Apple-Silicon macOS hosts (macOS 26+, `darwin/arm64`).
- **Branch strategies supported**: `head` (default), `merge-to-head`, `branch` — same matrix as `docker()` / `podman()`.
- **Pre-flight checks** (in order, fail-fast with actionable messages):
  1. `process.platform === "darwin" && process.arch === "arm64"`.
  2. `container --version` resolves on `PATH`.
  3. `container system status` reports the runtime is running.
  4. The configured `imageName` exists locally (`container image inspect`).
- **Lifecycle**:
  - Container creation via `container run -d --rm --name sandcastle-<uuid> -w /home/agent/workspace -u <uid>:<gid> -v <host>:/home/agent/workspace [-v ...] [-e ...] [--network ...] <image> sleep infinity`.
  - Best-effort teardown via `container delete -f` registered on `process.on("exit"/"SIGINT"/"SIGTERM")`.
- **File copy**: bind-mount makes the boundary transparent. `copyFileIn` and `copyFileOut` operate on the host worktree directly via `node:fs/promises` (`copyFile` + `mkdir`). The Apple `container` CLI has no `cp` subcommand, but no shim is needed.
- **Constraints**:
  - Hard-fail on non-Apple-Silicon hosts (Linux, Windows, Intel macOS).
  - No new top-level runtime dependencies.

### FR-002 — `github-codespaces` sandbox provider

- **Status**: Planned in `docs/design/plan-001-apple-containers-and-codespaces-providers.md`; pending implementation.
- **Type**: Isolated sandbox provider.
- **Subpath export**: `@ai-hero/sandcastle/sandboxes/github-codespaces`.
- **Description**: The library MUST support `github-codespaces` as an isolated sandbox provider that drives GitHub Codespaces via the `gh codespace` CLI.
- **Modes** (discriminated union on `mode`):
  - **`mode: "existing"`** — caller supplies a Codespace `name`; the provider attaches via `gh codespace ssh` / `gh codespace cp`. Never creates or deletes the Codespace. If the Codespace is in `Shutdown`, the provider transitions it to `Available` via `gh api --method POST /user/codespaces/<name>/start` and re-polls.
  - **`mode: "managed"`** — caller supplies `repo` plus optional `branch`, `machine`, `region`, `devcontainerPath`, `idleTimeoutMinutes`, `displayName`. The provider creates the Codespace per run, polls `gh codespace view --json state` until `Available`, runs the agent, and deletes the Codespace on `close()` unless `keepOnFailure: true` and the run failed.
- **Branch strategies supported**: `merge-to-head` (default) and `branch`. `head` is a compile-time error via the existing `IsolatedSandboxProvider` type constraint — no runtime check needed.
- **Pre-flight checks**:
  1. `gh --version` resolves on `PATH`.
  2. `gh auth status` reports an authenticated user with `codespace` scope.
  3. For `mode: "existing"`: `gh codespace view -c <name>` succeeds.
  4. For `mode: "managed"`: validate required fields (`repo` slug); actual creation deferred to `create()`.
- **Exec transport**: `gh codespace ssh -c <name> -- bash -c <cmd>`. The investigation confirmed `gh codespace exec` does not exist; SSH is the only canonical non-interactive exec path. Stdin is piped through transparently.
- **File transport**:
  - `copyIn`: `gh codespace cp -r -c <name> <hostPath> remote:<sandboxPath>`.
  - `copyFileOut`: `gh codespace cp -c <name> remote:<sandboxPath> <hostPath>`.
  - Never use `-e/--expand`. Always pass absolute remote paths.
- **Authentication for CI**: optional `token?: string` option. When set, all `gh` child processes are spawned with `env: { ...process.env, GH_TOKEN: <token> }`. `process.env` is never mutated.
- **State machine** (from research §"Complete State Enum"):
  - Terminal-success: `Available`.
  - Terminal-failure (abort polling): `Failed`, `Unavailable`, `Unknown`, `Deleted`, `Moved`, `Archived`.
  - Transient (keep polling): `Created`, `Queued`, `Provisioning`, `Awaiting`, `Starting`, `Rebuilding`, `Updating`, `ShuttingDown`, `Shutdown`, `Exporting`.
- **Polling defaults**: `pollIntervalMs: 3_000`, `createTimeoutMs: 600_000` (10 min). Both overridable per call.
- **Signal handlers**: registered in both modes via `process.on("exit"/"SIGINT"/"SIGTERM")`. For `managed`, the handler runs `execFileSync("gh", ["codespace", "delete", "-c", name, "--force"], …)` unless `keepOnFailure: true`. For `existing`, the handler is a no-op (never deletes).
- **Commit extraction**: reuses the existing `src/syncOut.ts` pipeline as-is. The provider implements only `worktreePath`, `exec`, `copyIn`, `copyFileOut`, and `close`; the orchestrator's `syncOut` does the rest via those methods.
- **Constraints**:
  - All Codespaces are Linux on x86_64; no ARM tier.
  - Symlinks are not preserved by `gh codespace cp` (scp behaviour) — known limitation.
  - `keepOnFailure` only protects against signal-driven cleanup; normal `close()` always deletes (the orchestrator does not yet pass a `runFailed` signal to the handle).

---

## How to update this document

Each new plan that adds, modifies, or removes a functional requirement must update this file in the same commit / unit as the plan is created (or at the latest in the plan's design phase). Plans append a new `FR-NNN` section under the appropriate top-level heading and reference the plan file.

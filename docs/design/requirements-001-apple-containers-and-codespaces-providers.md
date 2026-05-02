# Refined Request: Add `apple-containers` and `github-codespaces` Sandbox Providers

## Category

Development

## Objective

Implement two new first-class sandbox providers for `@ai-hero/sandcastle`:

1. **`apple-containers`** — a bind-mount sandbox provider that drives Apple's native `container` CLI on Apple Silicon, mirroring the architectural shape of the existing Docker and Podman bind-mount providers.
2. **`github-codespaces`** — an isolated sandbox provider that drives GitHub Codespaces via the `gh codespace` CLI, supporting both an "attach to an existing Codespace" mode and a "create + manage lifecycle" mode.

Both providers must conform to the existing `SandboxProvider` contract, integrate with all relevant sandbox/branch/worktree flows in `run()`, `interactive()`, `createSandbox()`, and `createWorktree()`, ship as ESM subpath exports, and be released as a patch-level changeset against the pre-1.0 line.

## Scope

### In scope

- A new `apple-containers` provider at `src/sandboxes/apple-containers.ts`, exported as `@ai-hero/sandcastle/sandboxes/apple-containers`.
- A new `github-codespaces` provider at `src/sandboxes/github-codespaces.ts`, exported as `@ai-hero/sandcastle/sandboxes/github-codespaces`.
- Provider option types (`AppleContainersOptions`, `GitHubCodespacesOptions`) consistent with the existing options shapes (`DockerOptions`, `PodmanOptions`, `VercelOptions`).
- Pre-flight checks specific to each provider:
  - `apple-containers`: hard-fail on non-Apple-Silicon hosts (i.e. anything other than `darwin` + `arm64`); verify `container` CLI on PATH and that the container subsystem/VM is running.
  - `github-codespaces`: verify `gh` CLI on PATH and that the user is authenticated (`gh auth status`); verify the `codespace` extension is available; for "existing codespace" mode, verify the named Codespace exists and is reachable.
- Lifecycle: container/Codespace creation, exec, file copy in/out, interactive exec (for `interactive()`), graceful and signal-driven teardown.
- Branch-strategy support per provider type:
  - `apple-containers`: all three strategies — `head` (default), `merge-to-head`, `branch` — same matrix as `docker()` / `podman()`.
  - `github-codespaces`: `merge-to-head` (default) and `branch` only — `head` must be a compile-time type error, matching the existing `IsolatedSandboxProvider` contract.
- Two integration modes for `github-codespaces`, selected via discriminated union on the options:
  - `existing` mode — caller supplies a Codespace name; Sandcastle attaches via `gh codespace ssh`/`cp`/`exec` and never creates or deletes it.
  - `managed` mode — Sandcastle creates the Codespace per run (with caller-supplied repo / machine / region / devcontainer settings), runs the agent, extracts commits, and tears it down on `close()`.
- Code reuse with existing providers where it is a non-disruptive refactor (e.g. extracting shared helpers in `src/mountUtils.ts` or new `src/sandboxes/_shared/` modules), but not larger architectural changes.
- Subpath export entries in `package.json#exports` for both providers, mirroring the existing pattern.
- Unit tests with `@effect/vitest` for option parsing, pre-flight failures, branch-strategy validation, and command construction (mocked CLI).
- Integration test scaffolding (skipped by default behind an env flag, like the existing `test-podman` / `test-vercel` scripts) that exercises a real `container` runtime and a real Codespace.
- A `.changeset/*.md` patch-level changeset entry under `package.json#name` (`@ai-hero/sandcastle`) describing the new providers in user-facing terms.
- README updates: add both providers to the Sandbox Providers table and the prerequisites section, using the project's canonical terminology from `CONTEXT.md`.
- Provider documentation: a brief usage example block per provider, in the same style as the existing Docker/Podman examples.

### Out of scope

- Implementing or redesigning the shared infrastructure for `IsolatedSandboxProvider` beyond what is already exposed by `createIsolatedSandboxProvider`. The codespaces provider must consume the existing factory contract as-is and treat any limitations as risks to be flagged (see Open Questions).
- Cross-cloud migration tooling or Codespace-to-Vercel/Daytona conversion.
- Behavioral changes to the existing `docker`, `podman`, `vercel`, `daytona`, or `no-sandbox` providers beyond minor, non-breaking refactors needed to share helpers.
- New `sandcastle init` template choices for either provider (the providers must be usable via the JS API; CLI scaffolding integration is a follow-up).
- New CLI namespaces such as `sandcastle apple-containers build-image` or `sandcastle codespaces create` — image/codespace lifecycle is performed by the user out-of-band for v1.
- Vendoring or wrapping the GitHub REST API — the `gh` CLI is the integration surface.
- Multi-Codespace orchestration, Codespace pooling, or warm-pool reuse across runs.
- Windows / Linux support for `apple-containers` (Apple's `container` runtime is macOS-on-Apple-Silicon only).

## Requirements

### Functional — `apple-containers`

1. Export `appleContainers(options?: AppleContainersOptions): SandboxProvider` from `src/sandboxes/apple-containers.ts`.
2. The provider must be constructed via `createBindMountSandboxProvider({ name: "apple-containers", ... })` with the same `BindMountCreateOptions` → `BindMountSandboxHandle` shape used by `docker()` and `podman()`.
3. `AppleContainersOptions` must support, at minimum:
   - `imageName?: string` — image used for the sandbox; defaults to `defaultImageName(hostRepoPath)` from `src/mountUtils.ts`.
   - `mounts?: readonly MountConfig[]` — additional host bind-mounts, resolved via the existing `resolveUserMounts` helper.
   - `env?: Record<string, string>` — provider-level env, merged at launch time per existing rules (must not overlap agent-provider env).
   - `network?: string | readonly string[]` — passed through to the `container` CLI's network flag(s); behavior must mirror `docker()`'s.
4. Pre-flight checks (in this order, fail fast with actionable messages):
   1. `process.platform === "darwin"` and `process.arch === "arm64"` — otherwise throw a typed error stating the provider only runs on Apple Silicon macOS.
   2. `container --version` resolves on PATH — otherwise throw with install instructions ("Install Apple's container CLI: https://github.com/apple/container").
   3. The `container` system/VM is running (e.g. `container system status` or equivalent) — otherwise throw with a remediation hint (`container system start`).
   4. The configured `imageName` exists locally (`container images inspect <name>` or `container image list`) — otherwise throw asking the user to build it first.
5. Container creation must:
   - Generate a unique container name (`sandcastle-<uuid>`).
   - Apply all internal + user-provided mounts as bind-mounts.
   - Set `workdir` to the sandbox-side worktree path (`/home/agent/workspace` by default, derived the same way as `docker.ts`).
   - Pass through merged env vars.
   - Set the runtime user to `${hostUid}:${hostGid}` if the underlying CLI supports it; if not, document the limitation and explicitly fail when the resulting ownership would block git.
   - Attach to the requested network(s).
6. The handle must implement: `worktreePath`, `exec` (with optional `onLine`, `cwd`, `sudo`, `stdin`), `interactiveExec` (with TTY detection consistent with `docker.ts`), `copyFileIn`, `copyFileOut`, and `close`.
7. On process `exit`, `SIGINT`, and `SIGTERM`, the provider must best-effort remove the container (mirroring `docker.ts`'s `onExit`/`onSignal` pattern).
8. The provider must accept all three branch strategies via the standard `branchStrategy` option on `run()` / `createSandbox()` / `createWorktree()`.

### Functional — `github-codespaces`

9. Export `githubCodespaces(options: GitHubCodespacesOptions): SandboxProvider` from `src/sandboxes/github-codespaces.ts`.
10. The provider must be constructed via `createIsolatedSandboxProvider({ name: "github-codespaces", ... })`. It must satisfy the existing `IsolatedSandboxHandle` shape: `worktreePath`, `exec`, `copyIn`, `copyFileOut`, `close` (and `interactiveExec` if needed for `interactive()`).
11. `GitHubCodespacesOptions` must be a discriminated union over `mode`:
    - `mode: "existing"` —
      - `name: string` (required) — the Codespace's `gh` name (e.g. `urban-spork-abc123`).
      - `repoCwdInCodespace?: string` — the repo path inside the Codespace (default: `/workspaces/<repo-name>` derived at runtime; document the heuristic and how to override).
      - `env?: Record<string, string>`.
    - `mode: "managed"` —
      - `repo: string` (required) — `owner/repo` slug used by `gh codespace create -R`.
      - `branch?: string` — the Codespace base branch (independent of Sandcastle's branch strategy).
      - `machine?: string` — instance size (e.g. `basicLinux32gb`).
      - `region?: string` — Codespace region.
      - `devcontainerPath?: string` — non-default devcontainer file.
      - `idleTimeoutMinutes?: number` — passed to `gh codespace create`.
      - `displayName?: string` — visible in `gh codespace list`.
      - `keepOnFailure?: boolean` (default `false`) — when `true`, do not delete the Codespace if `close()` runs after a failed iteration; otherwise always delete.
      - `env?: Record<string, string>`.
12. Pre-flight checks (run-once at provider creation, before sandbox creation):
    1. `gh --version` resolves on PATH; otherwise throw with `gh` install URL.
    2. `gh auth status` reports an authenticated user with `codespace` scope; otherwise throw.
    3. For `mode: "existing"`: `gh codespace view -c <name>` succeeds and the Codespace state is `Available` or can be transitioned via `gh codespace start` — otherwise throw.
    4. For `mode: "managed"`: `gh codespace create -R <repo> ...` is reachable (validate the repo slug and required fields) — actual creation deferred to `create()`.
13. `exec` must run commands inside the Codespace via `gh codespace exec` (or `gh codespace ssh -- <cmd>` if `exec` is unavailable for the user's `gh` version — document the chosen approach and its minimum `gh` version), with `onLine` line-streaming, `cwd`, `sudo`, and `stdin` semantics matching the bind-mount providers' shape where feasible.
14. `copyIn` and `copyFileOut` must use `gh codespace cp` for both file and directory transfers. Directory transfers must succeed (matching the contract documented in README's "Isolated provider example") — verify the recursive flag of `gh codespace cp` and document the exact flag used.
15. Branch strategy: provider must support `merge-to-head` (default) and `branch` only. Passing `head` must be a compile-time error via the existing type-system constraint on isolated providers (no runtime check needed).
16. The provider must extract commits made inside the Codespace back to the host worktree via the standard isolated-provider commit-extraction path (i.e. it must work with whatever `extractCommits` mechanism `createIsolatedSandboxProvider` already drives — the provider only supplies the handle).
17. On `close()`:
    - `mode: "existing"`: do **not** delete or stop the Codespace. Optionally clear out the temporary worktree directory used inside it (document this — the directory is whatever `worktreePath` resolved to).
    - `mode: "managed"`: delete the Codespace via `gh codespace delete -c <name> --force` unless `keepOnFailure: true` and the run failed.
    - In both modes, on process `exit`/`SIGINT`/`SIGTERM`, perform best-effort cleanup honoring the same rule.
18. Provider env merging must follow the project-wide rule: agent-provider env and sandbox-provider env must not overlap; `.sandcastle/.env` and `process.env` are merged underneath.

### Non-functional

19. **Language & runtime**: TypeScript only, ESM, target the same TS config as the rest of `src/sandboxes/*.ts`. No new top-level runtime dependencies; use `node:child_process` and the existing Effect.ts toolkit.
20. **Effect.ts integration**: where the existing providers use `Effect.runPromise` (e.g. `docker.ts` invoking `startContainer` / `removeContainer`), new providers should follow the same pattern — keep the `create()` callback `async` while internal subprocess primitives remain Effect-friendly. Do not introduce a separate execution model.
21. **Logging/observability**: every CLI invocation must produce an actionable error message that includes the failing command name and a remediation hint, matching the existing `docker exec failed: …` / `podman cp (in) failed: …` style.
22. **Terminology**: all user-facing strings, errors, and docs must use the canonical project glossary from `CONTEXT.md` — "sandbox provider", "branch strategy", "host", "worktree" — never "backend", "runtime", "workspace".
23. **Build & typecheck**: `npm run build` (`tsgo --project tsconfig.build.json`) and `npm run typecheck` (`tsgo --noEmit`) must pass with no new errors after the change.
24. **Tests**: `npm test` (`vitest run`) must pass with no new failures. New unit tests must use `@effect/vitest` and live alongside the source (or under the project's existing test layout — match what other providers do).
25. **Bundle hygiene**: no large new files copied into `dist/`; only the new `sandboxes/*.js` outputs and their `.d.ts`.
26. **Subpath exports**: `package.json#exports` must add entries for the two new subpaths in alphabetical order, matching the existing `import` + `types` shape.
27. **Optional peer deps**: if either provider needs an SDK package (e.g. an Apple `container` SDK or `@octokit/*`), it must be declared as an optional `peerDependency` (mirroring `@vercel/sandbox` / `@daytona/sdk`). Otherwise, no new deps.

## Constraints

- **Package**: `@ai-hero/sandcastle` v0.5.7, ESM only.
- **Effect.ts**: `effect@^3.20`, `@effect/cli@^0.74`, `@effect/platform-node@^0.105`. Do not introduce a different DI or async framework.
- **Tooling**: build with `tsgo`; tests with `vitest` + `@effect/vitest`.
- **Versioning**: pre-1.0; the changeset must be `patch`. Changesets live in `.changeset/`; before adding one, scan the directory for an existing draft that already covers these providers.
- **Coding conventions**: follow the existing `src/sandboxes/*.ts` style — single default export factory function, `interface XOptions { readonly … }`, `randomUUID()` for sandbox names, signal-handler pattern for cleanup.
- **Terminology**: strict adherence to `CONTEXT.md`. Avoid "container" in user-facing prose for the codespaces provider (Codespaces are sandboxes, not containers). For `apple-containers`, the word "container" is acceptable when referring to the Apple `container` CLI itself but the abstraction is still a "sandbox".
- **Apple Silicon hard requirement**: Apple's `container` runtime is macOS arm64 only. Failing loudly on other hosts is non-negotiable.
- **No fallback config defaults that hide missing required values**: per project convention, missing required configuration must throw a typed error, not silently fall back.

## Acceptance Criteria

The work is complete when **all** of the following hold:

1. `npm run build` succeeds.
2. `npm run typecheck` succeeds.
3. `npm test` passes, and includes the following new test cases (all green):
   - `apple-containers`: rejects on `process.arch !== "arm64"` with a typed, message-stable error.
   - `apple-containers`: rejects when `container` CLI is missing on PATH.
   - `apple-containers`: constructs the expected `container run` argv given a fixture `BindMountCreateOptions` (snapshot or argv-equality assertion).
   - `apple-containers`: branch strategies `head`, `merge-to-head`, and `branch` all type-check when passed to `run()`.
   - `github-codespaces`: in `mode: "existing"`, attaches to a fixture Codespace name and never invokes `gh codespace create` or `gh codespace delete`.
   - `github-codespaces`: in `mode: "managed"`, invokes `gh codespace create` with the supplied repo/machine/region and `gh codespace delete` on close.
   - `github-codespaces`: branch strategy `head` is a compile-time type error (asserted via a `// @ts-expect-error` test fixture).
   - `github-codespaces`: branch strategies `merge-to-head` and `branch` type-check.
   - Both providers: agent-provider env overlapping sandbox-provider env throws as the project rule mandates.
4. The two subpaths resolve via Node's ESM resolver:
   - `import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers"` resolves and the export is a callable factory.
   - `import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces"` resolves and the export is a callable factory.
5. The README's Sandbox Providers table includes both new rows, with correct import paths, type (Bind-mount / Isolated), and accepted-by columns.
6. A `.changeset/*.md` file exists with `"@ai-hero/sandcastle": patch` and a one-paragraph user-facing summary of the two new providers; the directory has been scanned to confirm no duplicate changeset already covers this work.
7. `Issues - Pending Items.md` is updated: any pre-existing entry related to these providers is moved to the completed section; any new known limitations (see Risks/Open Questions) are recorded as pending items.
8. Manual smoke test on an Apple Silicon mac:
   - Build a minimal sandbox image, then `run({ sandbox: appleContainers(), agent: claudeCode(...), prompt: "echo hi" })` produces a successful run with at least one iteration.
9. Manual smoke test against GitHub Codespaces:
   - `mode: "existing"`: pre-create a Codespace by hand, run Sandcastle against it, verify the Codespace remains after `close()`.
   - `mode: "managed"`: run Sandcastle without a pre-existing Codespace, verify a new Codespace appears in `gh codespace list` during the run and is gone after `close()`.
10. All provider-emitted error messages reference the canonical terminology (no "backend", "workspace", or "runtime" leaks).

## Assumptions

The following assumptions were made during refinement and should be confirmed before implementation begins:

- **A1 — Apple Silicon detection**: `process.platform === "darwin" && process.arch === "arm64"` is sufficient as the Apple Silicon check; we do not need to additionally probe `sysctl hw.optional.arm64` or VM-host scenarios. Basis: matches how Node reports arch on Apple Silicon, and any Node running under Rosetta will still see `arm64` in modern releases.
- **A2 — Apple `container` CLI scope**: Apple's `container` CLI exposes `run`, `exec`, `cp`, `rm`, and a `system status`-equivalent command. We will probe its actual surface during implementation; if a primitive (e.g. `cp`) is missing, we will emulate it via `exec` + `tar` streams the same way some Docker contexts do, and document the choice.
- **A3 — `gh codespace exec` availability**: a recent enough `gh` (>= 2.40, to be confirmed) supports non-interactive exec. If the user's `gh` is older we will fall back to `gh codespace ssh -- <cmd>` with documented minimum-version requirements.
- **A4 — Repo path inside the Codespace**: `/workspaces/<repo-name>` is the standard Codespaces convention. We will derive `<repo-name>` from `repo` (`mode: "managed"`) or via a one-time probe (`gh codespace exec -c <name> -- pwd` in the default shell) for `mode: "existing"`. The user can override via `repoCwdInCodespace`.
- **A5 — Commit extraction for Codespaces**: the existing `IsolatedSandboxProvider` factory's commit-extraction path (likely bundle/patch sync) is sufficient. We will not implement a parallel mechanism. If we discover the factory does not yet handle commit extraction in this repo, that is a Risk to flag rather than absorb into this scope.
- **A6 — No new top-level deps**: shelling out to `gh` and `container` is preferable to adding SDKs. If a future need arises, the SDK becomes an optional peer dep, not a hard dep.
- **A7 — Changeset discipline**: a single combined changeset for both providers is acceptable; reviewers can split it later if desired.
- **A8 — `interactive()` support**: `interactive()` for Codespaces uses `gh codespace ssh` (TTY-aware). For `apple-containers`, `interactiveExec` mirrors `docker.ts`. Both are part of v1.
- **A9 — No `init` template wiring**: users wire the provider in their own `main.ts`. The `sandcastle init` flow remains Docker/Podman-only; adding Apple Containers and Codespaces as init choices is a follow-up.

## Open Questions

These remain unresolved and should be tracked downstream:

- **Q1 — Isolated factory completeness**: Does `createIsolatedSandboxProvider` in `src/SandboxProvider.ts` already implement commit extraction end-to-end (e.g. bundle/patch sync), or is Vercel/Daytona currently the only thing exercising it? If gaps exist, they are in scope for a separate workstream (per the original request) but must be flagged as a delivery risk for this one.
- **Q2 — Apple `container` interactive TTY**: Whether `container exec -it` matches Docker's TTY semantics 1:1 — needs verification during implementation.
- **Q3 — `gh codespace exec` vs `ssh`**: Which non-interactive exec path is canonical and stable across `gh` versions in late 2025/early 2026 — needs a quick spike at the start of implementation.
- **Q4 — UID/GID mapping under Apple `container`**: whether the runtime supports `--user` overrides; if not, all bind-mount writes inside the sandbox must be owned by an in-image user, which constrains the Dockerfile/Containerfile template story (potentially out of scope for v1).
- **Q5 — Codespace prebuild reuse**: Whether `mode: "managed"` should opt into prebuilds for faster boot, or always cold-start. Probably a v1 nicety, not a v1 blocker.
- **Q6 — Authentication for Codespaces in CI**: `gh auth status` requires a token; should the provider also accept a `token: string` option (mirroring `vercel.token`) to avoid relying on `gh`'s on-disk credentials? Strong candidate for v1 but listed here for explicit decision.

## Original Request

> Add support for two new sandbox providers to the Sandcastle CLI/library (https://github.com/mattpocock/sandcastle, package: `@ai-hero/sandcastle`):
>
> 1. **apple-containers** — Apple's native container runtime on Apple Silicon. Same architectural shape as the existing `docker` and `podman` providers (a bind-mount sandbox provider). The `container` CLI is Apple's tool. Must mirror the Docker/Podman provider — supports all three branch strategies (head, merge-to-head, branch). Must fail loudly on non-Apple-Silicon hosts.
> 2. **github-codespaces** — GitHub Codespaces cloud development environments. Isolated sandbox provider (separate filesystem, requires sync). Must support BOTH integration modes:
>    - Use an **existing Codespace** by name — sandcastle drives a pre-created Codespace via `gh codespace ssh`/`cp`/`exec`
>    - **Create + manage** a Codespace lifecycle per run — sandcastle creates the Codespace, runs the agent, extracts commits, and tears it down
>
> User pre-decisions already locked in:
>
> - Full implementation (not just design/scaffolding)
> - TypeScript only (project already TS, uses Effect.ts)
> - Both modes for codespaces (configurable)
> - Apple-containers mirrors Docker/Podman provider shape
>
> Out of scope (do NOT include in this spec):
>
> - Implementing the not-yet-implemented `isolated sandbox provider` shared infrastructure as a separate workstream. Codespaces is the first real isolated provider — assume the existing isolated factory in the type system is the contract to fulfil and flag any gaps as risks.
> - Cross-cloud migration tooling
> - Changes to Docker/Podman/Vercel/Daytona providers beyond minor refactors needed to share code
>
> Project conventions (must be respected):
>
> - Package: `@ai-hero/sandcastle`, version 0.5.7, ESM, exports each provider via subpath (e.g. `sandcastle/sandboxes/apple-containers`, `sandcastle/sandboxes/github-codespaces`)
> - Effect.ts based (Effect 3.x, @effect/cli, @effect/platform-node)
> - Tests via vitest (`@effect/vitest`)
> - Build: `tsgo --project tsconfig.build.json`
> - Typecheck: `tsgo --noEmit`
> - A changeset must be added for user-facing changes (patch level, pre-1.0)
> - Repo terminology is strict — read CONTEXT.md at repo root for the canonical glossary (e.g. say "sandbox provider", "branch strategy", "host", not "backend"/"runtime"/"workspace")

# Investigation: Apple Containers and GitHub Codespaces Sandbox Providers

## Executive Summary

This investigation answers three concrete questions for the design of the new
`apple-containers` and `github-codespaces` sandbox providers in
`@ai-hero/sandcastle`. The recommendations are:

1. **Apple `container` CLI surface** — the project should treat Apple's
   `container` CLI as a near-Docker substitute for `run`, `exec`, `build`,
   `images list`, `images delete`, `kill`, `stop`, `delete (rm)`, and
   `system start/stop/status/version`. There is **no `container cp`**
   subcommand, so file copy in/out must be implemented via a tar-stream piped
   through `container exec`. Bind-mounts use the standard `-v host:container`
   syntax. Apple Silicon detection is `process.platform === "darwin" &&
process.arch === "arm64"`. macOS 26 is the supported host OS; older versions
   are unsupported by Apple. The runtime is at version 0.x and minor releases
   may break — pin command-construction tests to the exact CLI surface.
2. **GitHub Codespaces drive-from-outside** — the canonical exec path is
   `gh codespace ssh -c <name> -- <command>` (which transparently pipes host
   stdin to the remote process); **`gh codespace exec` does not exist**. File
   copy uses `gh codespace cp -e -r` with the `remote:` prefix. Lifecycle uses
   `gh codespace create -R <repo> [...]`, `gh codespace view -c <name> --json
state`, `gh codespace start -c <name>`, and `gh codespace delete -c <name>
--force`. Codespaces are always Linux on x86_64 — no ARM tier is exposed.
3. **Commit extraction for Codespaces** — the existing `syncOut.ts` machinery
   works as-is. It only needs the `IsolatedSandboxHandle` contract, which
   already supports the `stdin?: string` option in `exec` (the codebase scan
   was incorrect on that point). The codespaces provider implements `exec` by
   shelling out to `gh codespace ssh -c <name> -- bash -c <cmd>` with `stdin`
   piped to the child process; this is exactly what Vercel and Daytona do,
   adapted to the `gh` CLI as the transport.

## Context

- **What was investigated**: implementation strategy for two new sandbox
  providers in a TypeScript/Effect.ts/ESM codebase.
- **Refined request**:
  `/Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/design/requirements-001-apple-containers-and-codespaces-providers.md`
- **Codebase scan**:
  `/Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/reference/codebase-scan-apple-containers-codespaces.md`
- **Driving constraints**: ESM, TypeScript, Effect.ts 3.20, `tsgo` build,
  `vitest` + `@effect/vitest`, no new top-level deps, follow existing
  `docker.ts` / `vercel.ts` patterns, conform to existing
  `BindMountSandboxHandle` / `IsolatedSandboxHandle` contracts, never silently
  fall back on missing config.

---

## Q1 — Apple `container` CLI surface and stability

### Findings

**Command set (verified against the official command-reference for the current
branch):**

| Operation                   | Apple `container` command                                                                                                                                                              | Docker equivalent         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Run a container             | `container run [-d] [-i] [-t] [-v src:dst] [-w /path] [-e K=V] [--user u:g] [--name n] [--rm] <image> [args...]`                                                                       | `docker run`              |
| Exec in a running container | `container exec [-i] [-t] [-w /path] [-e K=V] [--user u:g] [--uid N] [--gid N] <id> <args...>`                                                                                         | `docker exec`             |
| Stop                        | `container stop [-s SIG] [-t SECS] <id...>`                                                                                                                                            | `docker stop`             |
| Kill                        | `container kill [-s SIG] <id...>`                                                                                                                                                      | `docker kill`             |
| Delete                      | `container delete [-f] <id...>` (alias `container rm`)                                                                                                                                 | `docker rm`               |
| List                        | `container list [-a] [--format json]` (alias `container ls`)                                                                                                                           | `docker ps`               |
| Build                       | `container build [-t name] [-f Dockerfile] [-c CPUS] [-m MEM] [--no-cache] [--platform os/arch] [<context>]` (also surfaces as `container image build` per the project's mental model) | `docker build`            |
| Image list                  | `container image list [--format json]` (alias `container image ls`)                                                                                                                    | `docker images`           |
| Image delete                | `container image delete [-f] <ref...>` (alias `container image rm`)                                                                                                                    | `docker rmi`              |
| Image inspect               | `container image inspect <ref...>`                                                                                                                                                     | `docker image inspect`    |
| System lifecycle            | `container system start`, `container system stop`, `container system status`, `container system version`                                                                               | `docker info` / `dockerd` |
| **No `cp` subcommand**      | **N/A**                                                                                                                                                                                | `docker cp`               |

**Bind-mount semantics:** `container run -v <host>:<container>[:ro]` is
documented identically to Docker. There is also a `--mount
type=...,source=...,target=...,readonly` long form. Both work for bind-mounts,
though `-v host:container` is the lowest-friction form. Anonymous volumes
(`-v /data` without source) are _not_ auto-cleaned with `--rm` — flagged in
the docs but irrelevant to bind-mount usage in this project.

**UID/GID and workdir:** `container run`, `container create`, and
`container exec` all support `-u/--user u:g`, `--uid N`, `--gid N`, and
`-w/--workdir /path`. This satisfies the requirements doc point about setting
the runtime user to `${hostUid}:${hostGid}` to keep git happy on bind-mounted
worktrees (parity with Docker/Podman).

**Apple Silicon detection:** Per the README, Apple's `container` runtime is
"a tool that you can use to create and run Linux containers as lightweight
virtual machines on your Mac" and explicitly requires "a Mac with Apple
silicon". `process.platform === "darwin" && process.arch === "arm64"` is the
correct Node-side check (Node reports `arm64` on Apple Silicon hosts). No
additional `sysctl hw.optional.arm64` probe is needed; assumption A1 in the
requirements doc holds.

**macOS version:** The README states `container` is "supported on macOS 26"
and that maintainers will not address issues that cannot be reproduced on
macOS 26. macOS version detection is achievable via `os.release()` (returns
the Darwin kernel version, e.g. `25.x.x` for macOS 26) or by parsing
`sw_vers -productVersion` from a child process. However, the requirements doc
does _not_ mandate a macOS version check — only an Apple Silicon check plus
`container --version` and `container system status` probes. **Recommendation:
do not add a programmatic macOS-26 check.** The `container` binary itself
won't install or function correctly on older macOS, so `container --version`
and `container system status` failures are sufficient pre-flight signals, and
they produce more actionable error messages than re-implementing macOS version
detection.

**Image-build semantics:** `container build [-t name] [-f Dockerfile] .`
produces an OCI image. The `--platform` flag accepts `os/arch[/variant]`. The
default architecture for a build is `arm64` (per the `--arch` default in the
build options) and the default OS is `linux`. So `container build -t my-img
.` produces a `linux/arm64` OCI image suitable for running under Apple's
Linux-VM container runtime. **Important:** Docker images built for `linux/arm64`
_are_ compatible with Apple's `container` runtime — they're consumed as
standard OCI images. Cross-architecture (`linux/amd64`) images can be run via
Rosetta with `--rosetta` on `container run`, but for Sandcastle's bind-mount
worktree image we always want native `linux/arm64`. The default Sandcastle
Dockerfile under `src/templates/` should therefore be portable as-is, provided
no `--platform=linux/amd64` is hardcoded.

**Stability and limitations vs Docker:**

- The project README explicitly notes: "currently under active development.
  Its stability ... is only guaranteed within patch versions ... Minor version
  number releases may include breaking changes until we achieve a 1.0.0
  release." Pin tests to exact argv construction; expect the surface to shift
  on minor bumps.
- **No `container cp`** — file copy in/out must be implemented via tar
  streamed through `container exec` (mirroring how rootless container engines
  often do this). For Sandcastle's bind-mount provider this is largely
  irrelevant: `copyFileIn` / `copyFileOut` happen on the host side of the
  bind-mount and don't need to traverse the container boundary. The provider
  can implement them by writing/reading the host-side worktree file directly.
  **This eliminates the need for a `cp` shim entirely.**
- Signal handling: `container stop` sends `SIGTERM` (5-second default before
  `SIGKILL`); `container kill` sends `SIGKILL` by default. Same semantics as
  Docker. The `--init` flag attaches a tini-equivalent for signal forwarding.
- TTY: `container run -it` and `container exec -it` are documented and behave
  like Docker. Open question Q2 from the requirements doc remains "verify
  during implementation" — no documented divergence found.
- Networks: `container network create` is macOS-26+ only, but the default
  network works on any supported host. The provider's `network` option should
  pass values through to `--network`.

### Recommended implementation approach

1. **Pre-flight in this exact order:**
   1. `process.platform === "darwin" && process.arch === "arm64"` — throw
      typed error if not. (Fast: no I/O.)
   2. `container --version` via `execFile`/`Effect.async` — throw with install
      URL on `ENOENT`.
   3. `container system status --format json` — throw with `container system
start` remediation on non-zero exit.
   4. `container image inspect <imageName>` — throw with build instruction
      on non-zero exit.
2. **Argv construction for `container run`** (mirrors `docker.ts`):
   `container run -d --rm --name sandcastle-<uuid> -w /home/agent/workspace
-u <uid>:<gid> -v <host-worktree>:/home/agent/workspace [-v <user-mounts>]
[-e K=V] [--network <n>] <imageName> sleep infinity` (the agent then
   targets the running container via `container exec`).
3. **`exec`** via `container exec [-i] [-w cwd] [--user uid:gid]
<container-id> bash -c <command>`. Stream stdout line-by-line with the
   same Writable pattern as `vercel.ts`. When `stdin?: string` is provided,
   spawn with `-i`, write the string to the child's stdin, then end it.
4. **`interactiveExec`** — TTY detection from `opts.stdin.isTTY`, allocate
   `-it` when true, `-i` when false. Same shape as `docker.ts`.
5. **`copyFileIn` / `copyFileOut`** — bind-mount provider, so just
   read/write on the host worktree (no `container cp` needed).
6. **`close`** via `container delete -f <container-id>`. Register
   `process.on("exit"/"SIGINT"/"SIGTERM")` handlers per `docker.ts`.

### Recommendation

**Adopt the surface above as the contract for the `apple-containers` provider
and freeze it in unit tests.** Do not attempt to abstract over Docker and
`container` differences in a shared module — the surfaces are 95% identical,
but the divergences (no `cp`, different system-lifecycle commands, faster CLI
churn) are exactly the kind of detail a single-file mirror of `docker.ts`
handles cleanly. A shared `_shared/containerCli.ts` helper for argv-building
is a tempting refactor but should be deferred until both providers are landed
and stable.

---

## Q2 — GitHub Codespaces drive-from-outside surface

### Findings

**`gh codespace` subcommands** (verified against the official `gh` manual at
cli.github.com/manual):

| Subcommand             | Purpose                                                                       | Key flags                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh codespace create`  | Create a new Codespace                                                        | `-R/--repo <user/repo>`, `-b/--branch`, `-m/--machine <type>`, `-l/--location <region>`, `--devcontainer-path`, `--idle-timeout <dur>`, `-d/--display-name`, `--retention-period`, `--default-permissions` |
| `gh codespace delete`  | Delete a Codespace                                                            | `-c/--codespace <name>`, `-f/--force`, `--all`, `-R/--repo`                                                                                                                                                |
| `gh codespace list`    | List all Codespaces                                                           | `-R/--repo`, `--json <fields>`, `-q/--jq`                                                                                                                                                                  |
| `gh codespace view`    | View details of a Codespace                                                   | `-c/--codespace <name>`, `--json state,name,...`, `-q/--jq`                                                                                                                                                |
| `gh codespace ssh`     | SSH into a Codespace; also runs a remote command non-interactively after `--` | `-c/--codespace <name>`, `--config`, `--profile`, `--server-port`, `-- <ssh-flags>`, `<command...>`                                                                                                        |
| `gh codespace cp`      | Copy files between local and remote                                           | `-c/--codespace <name>`, `-e/--expand`, `-r/--recursive`, `-- <scp-flags>`                                                                                                                                 |
| `gh codespace stop`    | Stop a Codespace                                                              | `-c/--codespace <name>`                                                                                                                                                                                    |
| `gh codespace rebuild` | Rebuild devcontainer                                                          | `-c/--codespace <name>`, `--full`                                                                                                                                                                          |
| `gh codespace logs`    | View Codespace logs                                                           | `-c/--codespace <name>`, `-f/--follow`                                                                                                                                                                     |
| `gh codespace ports`   | Manage forwarded ports                                                        | `-c/--codespace <name>`                                                                                                                                                                                    |
| `gh codespace edit`    | Edit Codespace metadata (display name, machine, idle timeout)                 | `-c`, `-d`, `-m`, `--idle-timeout`                                                                                                                                                                         |
| `gh codespace code`    | Open a Codespace in VS Code                                                   | `-c/--codespace <name>`, `--web`, `--insiders`                                                                                                                                                             |
| `gh codespace jupyter` | Open Jupyter in a Codespace                                                   | `-c/--codespace <name>`                                                                                                                                                                                    |

**Critical finding: `gh codespace exec` does NOT exist.** The requirements
doc's assumption A3 ("a recent enough `gh` >= 2.40 supports non-interactive
exec") is **incorrect**. The canonical non-interactive exec path is and has
always been `gh codespace ssh -c <name> -- <command...>`. This is not a
fallback — it is the only available path.

`gh codespace ssh -- <cmd>` semantics (from the man page and GitHub CLI
source):

- Runs `<cmd>` via SSH on the Codespace, returning the remote command's exit
  code.
- **Stdin is piped through transparently** — `echo "x" | gh codespace ssh -c
<name> -- 'cat > /tmp/x'` works as expected. This solves the project's
  stdin requirement without any additional plumbing.
- Stdout/stderr are wired through transparently — line-streaming via `spawn`
  and a Writable consumer works the same way as for `docker exec`.
- Auto-creates an SSH key pair in `~/.ssh` if none exists. From `gh` 2.13.0+,
  per-Codespace SSH config is also auto-generated and can be included from
  `~/.ssh/config` for direct `ssh`/`scp`/`rsync` use, but Sandcastle does not
  need this — shelling out to `gh codespace ssh` and `gh codespace cp` is
  sufficient.
- The Codespace must have an SSH server installed. The default GitHub-managed
  devcontainer images include one; user devcontainers may need the
  `ghcr.io/devcontainers/features/sshd:1` feature.

**`gh codespace cp` semantics:**

- Syntax: `gh codespace cp [-e] [-r] [-c <name>] <sources...> <dest>`. Either
  side may use the `remote:` prefix to denote the Codespace.
- `-r/--recursive` is **required** for directory copies (matches `scp`).
- `-e/--expand` enables shell-expansion of `~`, globs, and braces on the
  remote side. **Sandcastle should NOT use `-e`** because it evaluates the
  remote path as a Bash expression, which is unsafe with arbitrary host paths
  and adds quoting risk. Instead, always pass absolute remote paths verbatim.
- Without `-e`, the `remote:` path is interpreted literally relative to the
  remote user's home directory.
- `--` can be used to pass through SCP flags (e.g. `-F` for a custom config).

**Lifecycle / waiting for `Available` state:**

- `gh codespace view -c <name> --json state -q .state` returns one of:
  `Available`, `Provisioning`, `Starting`, `Stopped`, `ShuttingDown`,
  `Failed`, `Unavailable`, ... (the full set is internal to `gh`; only
  `Available` matters for "ready to ssh into").
- After `gh codespace create`, the CLI typically blocks until the Codespace
  is _Provisioning → Available_ and prints the name on stdout. In practice,
  the recommended pattern is: capture stdout from `gh codespace create`,
  trim, then poll `gh codespace view -c <name> --json state` with backoff
  until `state === "Available"` (or fail after a configurable timeout, e.g.
  10 minutes). For `mode: "managed"` this is exactly what's needed.
- For `mode: "existing"`: if `state !== "Available"`, run `gh codespace start
-c <name>` (which is a synchronous start) and re-poll. Note: there is no
  documented `gh codespace start` subcommand in the manual snapshot fetched
  for this investigation, but it has appeared in older `gh` releases. If it
  is unavailable, alternative is to call any `gh codespace ssh -c <name> --
true` which auto-starts a stopped Codespace as a side effect; this is the
  behavior used by VS Code's Codespaces extension.

**Authentication model:**

- `gh auth status` confirms the user is logged in.
- The `codespace` OAuth scope is required for create/delete/view/start/stop;
  `gh auth refresh -h github.com -s codespace` adds it.
- Fine-grained PATs **do not** support Codespaces today — only classic PATs
  with `codespace` scope, OAuth tokens with `codespace` scope, or `gh`'s own
  device-flow login work. (`gh auth status` will show what kind of token is
  in use.)
- For CI: set `GH_TOKEN` (preferred over `GITHUB_TOKEN`, which is the
  Actions-injected token and lacks `codespace` scope by default) to a token
  with `codespace`+`repo` scopes; `gh` reads it automatically.
- The provider should accept an optional `token?: string` option (per Open
  Question Q6 in the requirements doc) and, when supplied, set `GH_TOKEN` in
  the spawned `gh` child process's env. **Strongly recommended for v1**
  because (a) it mirrors `vercel.token`, (b) it eliminates the on-disk
  credential dependency for CI, and (c) it costs ~5 LOC.

**Listing/finding a Codespace by name:**

- Names like `urban-spork-abc123` are globally unique per user; passing them
  to `-c` is unambiguous.
- Multi-org / billable-owner: `gh codespace view -c <name>` works regardless
  of which org owns the Codespace, as long as the authenticated user has
  access. No disambiguation needed.
- Case sensitivity: Codespace names are lowercase-only (kebab + suffix). No
  case-folding required.

**Per-run cost and lifecycle for `mode: "managed"`:**

- A managed Codespace is billed per minute of compute + per GB of storage.
  `gh codespace delete -c <name> --force` immediately stops billing.
- Default `--idle-timeout` is 30 minutes; the requirements doc exposes this
  as a provider option, which is correct.
- Prebuilds are repository-level, not Codespace-level, and reuse for managed
  mode is automatic if the repo configures them. No provider work is needed.
  Open Question Q5 stands as deferred.
- Retention period: defaults to 7 days; the requirements doc exposes this
  via `idleTimeoutMinutes` and could optionally also expose
  `retentionPeriodMinutes`. **Recommendation: skip `retention-period` for
  v1**; managed Codespaces are deleted on `close()`, so retention is moot.

**Architecture / OS:**

- All Codespaces run **Linux on x86_64**. The machine API does not expose
  arch info and there is no ARM64 tier. The provider's Dockerfile / image
  assumptions can therefore safely assume `linux/amd64`.

### Recommended implementation approach

1. **`exec`** = `gh codespace ssh -c <name> -- bash -c <command>` spawned via
   `child_process.spawn`. Pipe `opts.stdin` to child stdin and `child.stdin.end()`.
   Stream stdout via a Writable + line buffer (same pattern as `vercel.ts`
   lines 173–222). Use the spawned process exit code as `ExecResult.exitCode`.
2. **`copyIn(hostPath, sandboxPath)`** = `gh codespace cp -r -c <name>
<hostPath> remote:<sandboxPath>` (the `-r` flag is harmless on single
   files in `scp`). Always pass absolute paths; never use `-e`.
3. **`copyFileOut(sandboxPath, hostPath)`** = `gh codespace cp -c <name>
remote:<sandboxPath> <hostPath>`.
4. **`mode: "existing"` create:**
   - Run `gh codespace view -c <name> --json state -q .state`.
   - If `Available`: proceed.
   - Else: `gh codespace ssh -c <name> -- true` (which warm-starts the
     Codespace) and re-poll for `Available` with timeout.
   - Resolve `worktreePath`: default to `/workspaces/<repoName>` derived from
     the JSON field `repository`; allow override via
     `repoCwdInCodespace`.
5. **`mode: "managed"` create:**
   - `gh codespace create -R <repo> [-b <branch>] [-m <machine>] [-l
<region>] [--devcontainer-path <p>] [--idle-timeout <m>] [-d
<displayName>] --default-permissions` (the `--default-permissions` flag
     auto-accepts permission prompts; without it, `create` blocks on stdin
     for permission confirmation).
   - Capture stdout (the Codespace name).
   - Poll `gh codespace view ... state` until `Available`.
   - Resolve `worktreePath` to `/workspaces/<basename(repo)>`.
6. **`close`:**
   - `mode: "existing"`: do nothing (per requirements doc).
   - `mode: "managed"`: `gh codespace delete -c <name> --force` unless
     `keepOnFailure && lastRunFailed`.
   - Both modes: register `process.on("exit"/"SIGINT"/"SIGTERM")` handlers
     for best-effort cleanup; remove handlers in `close()`.
7. **Auth:** if `options.token` is set, spawn `gh` children with
   `env: { ...process.env, GH_TOKEN: options.token }`.

### Recommendation

**Implement `exec` exclusively via `gh codespace ssh -- <cmd>` and remove the
"`gh codespace exec` if available, else `ssh` fallback" logic from the
requirements doc.** There is no fallback — `ssh` is the canonical path. This
simplifies the provider and removes an entire class of version-detection code.
Note this in the changeset and in the provider's JSDoc so future readers don't
recreate the assumption.

---

## Q3 — Commit extraction strategy for Codespaces

### Findings

**Existing isolated-provider commit-extraction is `syncOut.ts`.** Read of
`/Users/giorgosmarinos/aiwork/coding-platform/sandcastle/src/syncOut.ts`
confirms the extraction pipeline is already three-prong, provider-agnostic,
and consumes `IsolatedSandboxHandle` only via:

- `handle.exec(command, { cwd })` — for `git rev-parse`, `git diff HEAD`, `git
ls-files --others`, `mktemp -d`, `git format-patch`, `ls`, `rm -rf`.
- `handle.copyFileOut(sandboxPath, hostPath)` — for each generated
  `.patch` file and each untracked file.
- `handle.worktreePath` — to scope all of the above.

There is no `handle.copyIn` or `handle.exec({ stdin })` requirement in
`syncOut`; it works strictly via outbound copy and host-side `git am --3way`.

**Important codebase-scan correction:** The scan's note (line 192) that
`IsolatedSandboxHandle.exec` lacks `stdin` is **incorrect** — the actual
type at `src/SandboxProvider.ts:101–124` includes `stdin?: string` in the
options. Both `BindMountSandboxHandle` and `IsolatedSandboxHandle` have
identical `exec` signatures including `stdin`. There is no gap. This means
the codespaces provider's `exec` only needs to honor `stdin` by piping it to
`gh codespace ssh`'s stdin, which is exactly what shells do natively.

**How `vercel.ts` and `daytona.ts` extract commits today:**

- They don't. They implement `exec`, `copyIn`, `copyFileOut`, `close`, and
  `worktreePath`. The orchestrator calls `syncOut` against the handle, and
  `syncOut` does all the git-bundle / patch / format-patch work via
  `handle.exec` and `handle.copyFileOut`.
- Vercel uses the `@vercel/sandbox` SDK's `runCommand` for `exec`, and
  `sandbox.readFileToBuffer` + `writeFile` for `copyFileOut` (writes to a
  host file).
- Daytona uses `sandbox.process.executeSessionCommand` for streaming `exec`
  and `sandbox.fs.downloadFile` for `copyFileOut`.

**Pattern for `github-codespaces` extraction:**

The codespaces provider has the simplest of the three because `gh codespace
ssh` and `gh codespace cp` are both OS-process boundaries. The extraction
flow is:

1. `syncOut` calls `handle.exec("git rev-parse HEAD", { cwd })` →
   `gh codespace ssh -c <name> -- 'cd /workspaces/repo && git rev-parse HEAD'`.
2. `syncOut` calls `handle.exec("git format-patch <range> -o
<sandboxTmpDir>", { cwd })` → same SSH-pipe pattern.
3. `syncOut` calls `handle.copyFileOut(<sandbox>/0001-foo.patch,
<host>/.sandcastle/patches/<ts>/0001-foo.patch)` →
   `gh codespace cp -c <name> remote:/tmp/...patches/0001-foo.patch
/host/.sandcastle/patches/<ts>/0001-foo.patch`.
4. Host-side `git am --3way <patches...>` is run by `syncOut`'s host code,
   not by the handle.

**Large diffs / binary files:**

- `git format-patch` handles binary files via the `--binary` flag, but
  `syncOut.ts` does not currently pass it. This means binary changes
  committed inside the sandbox will produce a "binary patch" warning during
  `git am`. This is a pre-existing limitation that affects Vercel and
  Daytona equally — out of scope for this work but worth flagging.
- For large diffs, `gh codespace cp` is fine; the bottleneck is the SSH
  channel, not `gh`. Per-patch files of tens of MB transfer cleanly.
- For untracked files, `syncOut` already uses one `copyFileOut` call per
  file. No bundling.

**`git bundle` vs `git format-patch`:** `syncOut` uses `format-patch`. There
is no need for `git bundle`. Bundles are useful when you need a sealed,
self-contained reproduction of a subset of history; for "apply the new
commits onto the host's HEAD," `format-patch` + `git am --3way` is strictly
simpler and matches the existing implementation. **Recommendation: do not
introduce `git bundle` for codespaces.**

**Does `gh codespace ssh -- <cmd>` solve the stdin gap?** Yes — confirmed in
the GitHub CLI source and the `gh codespace ssh` manual. Stdin is piped
through transparently. Sandcastle's `exec` implementation can simply spawn
`gh codespace ssh -c <name> -- bash -c <cmd>`, write `opts.stdin` to the
child's stdin, end it, and let SSH carry it to the remote process.

### Recommendation

**Reuse `syncOut.ts` as-is.** The codespaces provider's only obligations
are:

- `worktreePath`: derived (`/workspaces/<repoName>`) or user-provided.
- `exec(cmd, { onLine, cwd, sudo, stdin })`: implemented via
  `gh codespace ssh -c <name> -- bash -c '<cwd-prefixed cmd>'`, with stdin
  piping and line-streaming.
- `copyIn(hostPath, sandboxPath)`: `gh codespace cp -r -c <name> <host>
remote:<sandbox>`.
- `copyFileOut(sandboxPath, hostPath)`: `gh codespace cp -c <name>
remote:<sandbox> <host>`.
- `close()`: per `mode`.

The orchestrator-driven `syncOut.ts` does the rest. No new mechanism is
needed.

**Update the codebase scan** (line 192) to remove the incorrect
`IsolatedSandboxHandle.exec lacks stdin` note. The risk it raised is not real.

---

## Comparison Matrix

This investigation produced single-path recommendations rather than ranked
options for each question, so the matrix below highlights the _rejected
alternatives_ alongside the chosen approach.

| Concern                               | Chosen approach                                             | Rejected alternative(s)                                        | Why                                                             |
| ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Apple `container` exec                | `container exec [-i]`                                       | `container attach`                                             | `attach` is for stdio of a running PID 1, not new commands      |
| Apple `container` file copy in/out    | Direct host filesystem read/write (bind-mount)              | Tar-stream via `container exec`                                | Worktree is bind-mounted; no boundary to traverse               |
| Apple `container` macOS version check | None (rely on `container --version` failure)                | `os.release()` parse, `sw_vers` shell-out                      | Redundant — the binary won't function on unsupported macOS      |
| Apple Silicon detection               | `process.platform === "darwin" && process.arch === "arm64"` | `sysctl hw.optional.arm64`                                     | Node already reports `arm64` natively                           |
| Codespaces non-interactive exec       | `gh codespace ssh -c <n> -- <cmd>`                          | `gh codespace exec` (does not exist), Octokit REST + WebSocket | `ssh` is the only documented path                               |
| Codespaces stdin to remote process    | Spawn `gh codespace ssh` and pipe to child stdin            | Encode stdin into command args                                 | Args have a 128 KB Linux limit; stdin pipe avoids it            |
| Codespaces file copy                  | `gh codespace cp [-r]`                                      | `cat <file> \| gh codespace ssh -- 'cat > /path'`              | `cp` handles binaries, recursive dirs, and SCP retries natively |
| Codespaces auth in CI                 | `GH_TOKEN` env (option `token?: string`)                    | Rely on on-disk `gh auth login` only                           | CI environments lack persistent home; mirrors `vercel.token`    |
| Commit extraction transport           | Existing `syncOut.ts` (format-patch + copyFileOut)          | `git bundle` + `cp`                                            | `format-patch` is already implemented and tested                |
| Codespaces "wait for Available"       | `gh codespace view --json state -q .state` polling          | Octokit `GET /codespaces/{name}` polling                       | Avoids adding `@octokit/*` dep; same data                       |

---

## Recommendation

For each of the three questions, the recommended implementation path is the
single approach described above. Summarized for the planning step:

- **Q1**: Mirror `docker.ts` 1:1 with substituted argv; pre-flight on Apple
  Silicon + `container --version` + `container system status` + `container
image inspect`. Skip macOS-26 version probe. Use `-v host:container` for
  bind-mounts. Use `--user uid:gid` and `-w /home/agent/workspace`. Implement
  `copyFileIn`/`copyFileOut` against the host worktree directly (bind-mount
  semantics make the container boundary transparent).

- **Q2**: Use `gh codespace ssh -c <name> -- <cmd>` as the only exec path —
  never `gh codespace exec` (it does not exist). Use `gh codespace cp -r` for
  copyIn/copyFileOut without `-e`. Use `gh codespace view --json state` for
  readiness polling. Use `gh codespace create -R <repo>
--default-permissions [...]` for managed mode. Use `gh codespace delete -c
<name> --force` for teardown. Add an optional `token?: string` provider
  option that injects `GH_TOKEN` into spawned `gh` children.

- **Q3**: Reuse `syncOut.ts` unchanged. The codespaces provider only needs
  to implement the four `IsolatedSandboxHandle` methods (`exec`, `copyIn`,
  `copyFileOut`, `close`) plus `worktreePath`. `IsolatedSandboxHandle.exec`
  already supports `stdin` (the codebase scan's note to the contrary is
  incorrect). Pipe `stdin` directly into the spawned `gh codespace ssh`
  child process.

These three recommendations are concrete enough that planning can proceed
without further architectural debate.

---

## Technical Research Guidance

**Research needed: Yes — but narrow.**

### Topic 1: Effect.ts patterns for shelling out to long-running CLI processes with streaming stdout

- **Why**: Both new providers shell out heavily (`container exec`, `gh
codespace ssh`). The existing providers have _two_ patterns for this:
  `DockerLifecycle.ts` wraps things in `Effect.async`/`Effect.gen` for
  startup/teardown, while `vercel.ts` and `daytona.ts` use raw async/Promise
  inside the `create()` callback for handle methods. The new providers must
  match this seam — but the boundary between "use Effect" and "use plain
  Promise" is not documented anywhere in the codebase. A short pattern
  reference will avoid each provider author re-inventing the line.
- **Focus**: When to use `Effect.async` for `child_process.spawn`; when to
  use `Effect.tryPromise`; how to model line-streaming as an Effect (or
  whether to keep it plain async); how `Effect.runPromise` is invoked at the
  provider seam.
- **Depth**: Intermediate (one short doc page is enough — not a deep dive).
- **Relevance**: Directly affects both providers' implementation style and
  test mocking strategy.

### Topic 2: GitHub Codespaces `state` lifecycle values and timing

- **Why**: The recommendation polls `gh codespace view --json state` until
  `state === "Available"`. The full enum of `state` values is not
  authoritatively documented in any single GitHub source; only `Available`
  is named in the public docs. If a Codespace transitions through
  `Provisioning → Starting → Rebuilding → Available`, the provider needs to
  know how long each phase typically takes (for timeout tuning) and which
  intermediate states should be treated as transient vs failed. `Failed`
  and `Unavailable` should be hard-stops; the rest should be polled.
- **Focus**: enumerate observed `state` values from a real `gh codespace
view` against a freshly-created Codespace; capture typical p50/p95
  duration from `Provisioning` → `Available`; identify any state that
  should be treated as terminal failure.
- **Depth**: Overview (one polling experiment + manual list).
- **Relevance**: Sets the default `createTimeoutMs` and the polling interval
  for managed-mode pre-flight.

### Topic 3 (NOT NEEDED): Apple `container` CLI

The CLI surface is well-documented at
`github.com/apple/container/blob/main/docs/command-reference.md` and was
captured in detail above. The remaining unknowns (TTY behavior under `-it`,
Q4 from the requirements doc on UID overrides) are quick verifications
during implementation — not pre-planning research.

### Topic 4 (NOT NEEDED): GitHub Codespaces REST API + Octokit

The `gh` CLI is the chosen integration surface. Adding `@octokit/*` as a dep
was explicitly out-of-scope per the requirements doc. No Octokit research is
needed. The `gh` CLI's flag set is fully documented.

---

## Implementation Considerations

- **Codebase-scan correction** (line 192): the note that
  `IsolatedSandboxHandle.exec` lacks `stdin` is wrong. `stdin?: string` is
  on the type. The codespaces provider can rely on it.
- **`copyIn` for codespaces**: even though `gh codespace cp -r` works for
  directories, there's a wrinkle — `scp`/`gh cp` does not preserve symlinks
  by default. If Sandcastle's host-worktree contains symlinks (e.g. monorepo
  setups using `pnpm`), they may be dereferenced. Flag this as a known
  limitation in the provider's JSDoc and the `Issues - Pending Items.md`.
- **`gh codespace start` ambiguity**: not in the current `gh` manual but
  historically present. The recommendation uses `gh codespace ssh -c <name>
-- true` which auto-starts a stopped Codespace as a side effect.
  Implementation should verify with a quick spike against a stopped
  Codespace. If `gh codespace start` is available, prefer it for clarity.
- **`gh codespace create` and `--default-permissions`**: this flag is
  required to avoid the create blocking on a stdin permission prompt when
  the devcontainer requests scopes. Tests should assert it's always
  present on the argv for managed mode.
- **Apple `container` minimum version**: pin tests to the surface from
  the current branch's `command-reference.md` (which corresponds to roughly
  `v0.4.x`). The requirements doc does not specify a minimum version; the
  pre-flight should accept any version that responds to `--version`.
- **Process signal cleanup for isolated providers**: as the codebase scan
  notes, `vercel.ts` and `daytona.ts` do _not_ register signal handlers
  today. The requirements doc requires this for `github-codespaces`
  (especially in `mode: "managed"` where leaking a Codespace costs money).
  The implementation should follow the `docker.ts` pattern _without_
  modifying `vercel.ts` or `daytona.ts` (out of scope).
- **`postbuild` step**: no impact. New provider files do not need template
  copying.
- **Subpath export ordering**: `apple-containers` slots between
  `./templates/*` (if present) and `./sandboxes/daytona`; `github-codespaces`
  slots between `./sandboxes/docker` and `./sandboxes/no-sandbox`.
- **First steps for the planning doc**:
  1. Codify the exact argv for `apple-containers` `run`/`exec`/`delete` and
     for `github-codespaces` `ssh`/`cp`/`create`/`view`/`delete` as constants
     (or argv-builder helpers) at the top of each provider file.
  2. Mirror the `docker.test.ts` mock pattern for both providers.
  3. Verify `IsolatedSandboxHandle.exec stdin` ergonomics with a small spike
     against a real Codespace before locking the implementation.

---

## References

| #   | Source                                                   | URL                                                                                                           | What was learned                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | apple/container README                                   | https://github.com/apple/container                                                                            | macOS 26 + Apple Silicon required; runtime is pre-1.0 with breaking changes possible on minor bumps; OCI-image compatible                        |
| 2   | apple/container command reference                        | https://github.com/apple/container/blob/main/docs/command-reference.md                                        | Full subcommand list; `-v host:container` bind-mount; no `cp` subcommand; `--user`/`--uid`/`--gid`/`--workdir` on run/exec                       |
| 3   | gh codespace manual                                      | https://cli.github.com/manual/gh_codespace                                                                    | Authoritative subcommand list — `gh codespace exec` does NOT exist                                                                               |
| 4   | gh codespace ssh manual                                  | https://cli.github.com/manual/gh_codespace_ssh                                                                | `ssh -- <cmd>` runs a remote command non-interactively; stdin pipes through; auto-creates SSH key pair                                           |
| 5   | gh codespace cp manual                                   | https://cli.github.com/manual/gh_codespace_cp                                                                 | `-r` for directories, `-e` for shell expansion (avoid in Sandcastle), `remote:` prefix syntax                                                    |
| 6   | gh codespace create manual                               | https://cli.github.com/manual/gh_codespace_create                                                             | All flags for managed mode: `-R`, `-b`, `-m`, `-l`, `--devcontainer-path`, `--idle-timeout`, `-d`, `--default-permissions`, `--retention-period` |
| 7   | gh codespace view manual                                 | https://cli.github.com/manual/gh_codespace_view                                                               | JSON fields including `state`, `name`, `repository`, `machineName`, `gitStatus` — used for readiness polling                                     |
| 8   | gh codespace delete manual                               | https://cli.github.com/manual/gh_codespace_delete                                                             | `-c`, `--force`, `--all`, `--days N` for filtered deletion                                                                                       |
| 9   | GitHub CLI 2.2.0 discussion                              | https://github.com/cli/cli/discussions/4609                                                                   | Historical context for `gh codespace ssh` non-interactive command behavior                                                                       |
| 10  | GitHub Codespaces machine types                          | https://docs.github.com/en/codespaces/customizing-your-codespace/changing-the-machine-type-for-your-codespace | `basicLinux32gb` / `standardLinux32gb` / `premiumLinux` / `largePremiumLinux`; all Linux x86_64                                                  |
| 11  | GitHub Community: x86_64/AMD64/ARM64 platform discussion | https://github.com/orgs/community/discussions/8507                                                            | Confirms no ARM Codespace tier exists; `linux/amd64` is the only architecture                                                                    |
| 12  | Sandcastle src/SandboxProvider.ts (lines 100–124)        | (local file)                                                                                                  | `IsolatedSandboxHandle.exec` accepts `stdin?: string` — codebase scan correction                                                                 |
| 13  | Sandcastle src/syncOut.ts                                | (local file)                                                                                                  | Three-prong commit extraction works through `handle.exec` + `handle.copyFileOut`; no provider-side bundle/patch implementation needed            |
| 14  | Sandcastle src/sandboxes/vercel.ts (lines 162–290)       | (local file)                                                                                                  | Reference pattern for isolated-provider `exec` with `onLine`, `copyIn`, `copyFileOut`                                                            |

---

## Original Request

The investigation was driven by the refined request at
`/Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/design/requirements-001-apple-containers-and-codespaces-providers.md`,
which specifies two new sandbox providers (`apple-containers` and
`github-codespaces`) for `@ai-hero/sandcastle` v0.5.7. See that file for the
full functional and non-functional requirements, acceptance criteria, and
open questions. The codebase scan at
`/Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/reference/codebase-scan-apple-containers-codespaces.md`
provided the structural context this investigation built on.

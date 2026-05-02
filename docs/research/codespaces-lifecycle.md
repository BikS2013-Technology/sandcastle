# GitHub Codespaces Lifecycle State Machine, Polling, and Timeouts

Research for the `github-codespaces` sandbox provider (`mode: "managed"`).
Covers the complete state machine, realistic timing, recommended defaults, CLI
argv strings, REST API / Octokit references, and rate-limit guidance.

---

## Overview

A managed Codespace follows a create → poll-until-ready → use → teardown
pattern. This document answers:

1. What state values can `gh codespace view --json state -q .state` return?
2. Which are transient (keep polling), which are terminal-success
   (`Available`), and which are terminal-failure (abort immediately)?
3. How long does creation realistically take?
4. What polling cadence is safe under GitHub's rate limits?
5. What do `gh codespace stop` vs `gh codespace delete` do, and when should
   each be called?
6. Which `gh codespace create` flags matter for Sandcastle?
7. What are the Octokit REST endpoints for each lifecycle operation?

---

## Complete State Enum

The `state` field on a Codespace object is a PascalCase string. The following
values are defined in the gh CLI Go source
(`internal/codespaces/api/api.go`) and the GitHub REST API OpenAPI schema.

| State          | Category         | Description                                                             |
| -------------- | ---------------- | ----------------------------------------------------------------------- |
| `Unknown`      | Terminal-failure | State cannot be determined. Treat as fatal.                             |
| `Created`      | Transient        | Codespace record exists; VM provisioning not yet started.               |
| `Queued`       | Transient        | Awaiting a compute slot. More common during region capacity pressure.   |
| `Provisioning` | Transient        | VM is being allocated and base image loaded.                            |
| `Awaiting`     | Transient        | Waiting on a dependency (e.g. prebuild lock).                           |
| `Starting`     | Transient        | Container is booting; SSH not yet ready.                                |
| `Rebuilding`   | Transient        | `gh codespace rebuild` triggered; devcontainer being rebuilt.           |
| `Updating`     | Transient        | Machine type or other metadata update in progress.                      |
| `Exporting`    | Transient        | Branch export triggered. Not reachable in normal Sandcastle flows.      |
| `ShuttingDown` | Transient        | `gh codespace stop` or idle-timeout triggered.                          |
| `Available`    | Terminal-success | Codespace is running and SSH-accessible. Only usable state.             |
| `Shutdown`     | Terminal-stopped | Codespace is stopped (cold). Needs start before use.                    |
| `Failed`       | Terminal-failure | Provisioning or container build failed. Must delete and recreate.       |
| `Unavailable`  | Terminal-failure | Exists but inaccessible (billing/policy/region issue).                  |
| `Deleted`      | Terminal-failure | Already deleted; object should not appear in normal polling.            |
| `Moved`        | Terminal-failure | Internal infrastructure migration. Treat as fatal for polling purposes. |
| `Archived`     | Terminal-failure | Codespace has been archived (long-term inactivity).                     |

### Authoritative source: gh CLI state constants

Extracted from the gh CLI source at
`github.com/cli/cli/blob/trunk/internal/codespaces/api/api.go`:

```go
// CodespaceStateAvailable is the state for a running codespace environment.
CodespaceStateAvailable = "Available"
// CodespaceStateShutdown is the state for a shutdown codespace environment.
CodespaceStateShutdown = "Shutdown"
// CodespaceStateShuttingDown is the state for a shutting down codespace environment.
CodespaceStateShuttingDown = "ShuttingDown"
// CodespaceStateStarting is the state for a starting codespace environment.
CodespaceStateStarting = "Starting"
// CodespaceStateRebuilding is the state for a rebuilding codespace environment.
CodespaceStateRebuilding = "Rebuilding"
```

Additional values (`Unknown`, `Created`, `Queued`, `Provisioning`, `Awaiting`,
`Unavailable`, `Deleted`, `Moved`, `Archived`, `Exporting`, `Updating`,
`Failed`) are confirmed by the GitHub REST API OpenAPI schema
(`github/rest-api-description`) and community observation.

---

## State Diagram

The normal create path in `mode: "managed"`:

```
POST /user/codespaces
        │
        ▼
    [Created]
        │
        ▼
    [Queued]  ──── (capacity pressure, rare)
        │
        ▼
 [Provisioning]  ── VM allocated, image pulled
        │
        ├── (prebuild hit)
        │         │
        │         ▼
        │    [Awaiting]  ── waiting on prebuild snapshot
        │         │
        │         ▼
        └────► [Starting]  ── container booting, SSH agent starting
                   │
                   ▼
              [Available]  ◄─── ONLY STATE THAT IS USABLE
                   │
           ┌───────┴────────┐
           │                │
     [ShuttingDown]    [Rebuilding]
           │
           ▼
       [Shutdown]  ◄─── stopped (cold); needs start
           │
  ─────────┴──────────────────────
  │                               │
  │ gh codespace start            │ idle-timeout
  │ (POST /user/codespaces/*/start) │
  ▼                               ▼
[Starting]               [Shutdown] ─► auto-delete after retention


Terminal-failure states (abort polling immediately):
  [Failed]      provisioning/build failed
  [Unavailable] billing/policy/region block
  [Unknown]     state indeterminate
  [Deleted]     object already gone
  [Moved]       infra migration
  [Archived]    long-term inactivity archive
```

---

## Realistic Timing

### Creation (cold start, no prebuild)

| Scenario                                | Approximate duration                  |
| --------------------------------------- | ------------------------------------- |
| Simple repo, default devcontainer image | 60–90 seconds                         |
| Complex repo with custom Dockerfile     | 2–5 minutes                           |
| Heavy repo (many deps, compile step)    | 5–10 minutes                          |
| Pathological case (build > 60 min)      | Fails; GitHub cancels container build |

From the GitHub docs: "If it currently takes **more than 2 minutes** to create
a codespace for a repository, you are likely to benefit from using prebuilds."
The maximum build time GitHub tolerates before cancelling is approximately
**1 hour**; the `Failed` state is set after that.

### Creation (with prebuild)

| Scenario                                              | Approximate duration |
| ----------------------------------------------------- | -------------------- |
| Prebuild available for exact branch + region          | 10–30 seconds        |
| Prebuild from different region (cross-region restore) | 30–60 seconds        |
| Prebuild expired or absent (fallback to cold)         | Same as cold start   |

The `Codespace.Prebuild` boolean field (returned by `gh codespace view --json
prebuild`) indicates whether the current Codespace was created from a prebuild.

### Starting a stopped Codespace

Resuming from `Shutdown` state takes approximately **10–40 seconds**. The
sequence is `Shutdown → Starting → Available`.

---

## Recommended Default Values

### `createTimeoutMs`

| Mode                            | Recommended default    | Rationale                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed` (no prebuild assumed) | `600_000` (10 minutes) | Covers p95 cold start for complex repos; the gh CLI's own internal create-polling timeout is 2 minutes (for the provisioning-complete check only, not full boot), but that is insufficient for the full `Available` wait. |
| `managed` (prebuild guaranteed) | `120_000` (2 minutes)  | Sub-30s typical; 2-minute budget covers region fallbacks.                                                                                                                                                                 |

**Use 10 minutes as the safe default.** Document that prebuild configurations
can halve or better this time. If the Codespace hits `Failed` or any other
terminal-failure state, abort immediately regardless of timeout remaining.

### `pollIntervalMs`

**Recommended default: `3_000` ms (3 seconds).**

Rationale:

- The gh CLI's own internal `CreateCodespace` polling loop runs at **1 second**
  intervals (verified in `api/api.go`), but that is calling the REST API
  directly without the overhead of spawning a gh subprocess each time.
- Sandcastle polls via `gh codespace view --json state -q .state`, which
  spawns a subprocess and makes an authenticated HTTPS request per call.
- At 3-second intervals over a 10-minute window, that is at most 200 polling
  requests. With the primary rate limit of 5,000 requests/hour for
  authenticated users, polling at 3 seconds uses ~720 requests/hour — well
  within limits.
- A 5-second interval (720 → 432 req/hr) is also safe and reduces subprocess
  overhead, but feels noticeably slower to observe.
- **Avoid sub-2-second polling** when using subprocess-based gh CLI polling, as
  each subprocess spawns a new TLS connection and adds ~100–300ms of overhead
  on top of the API round-trip.

### `stopOnClose`

**Recommended default: `false` for `mode: "managed"`.**

In managed mode, `close()` should call `gh codespace delete --force`
immediately. Stopping first and then deleting is redundant: delete works on
running codespaces directly (it issues a stop internally). Stopping before
deleting only adds latency.

For `mode: "existing"`, stopping is appropriate if the user wants to preserve
the Codespace in a known-good state after use, and the option should default
to `true` to respect the "existing" lifecycle.

### `deleteOnClose`

**Recommended default: `true` for `mode: "managed"`, `false` for
`mode: "existing"`.**

For managed mode: each run creates a fresh Codespace; always delete on close to
stop billing. If `keepOnFailure` is set and the run failed, respect that flag
and skip deletion.

---

## gh codespace argv Reference

All commands below assume the Codespace name is stored in `$NAME` and the
`gh` binary is on `PATH`. If `GH_TOKEN` is set in the environment, `gh` uses
it automatically; no `--auth-token` flag is needed.

### Create (managed mode)

```sh
gh codespace create \
  --repo <owner/repo> \
  --branch <branch> \
  --machine <machineType> \
  --location <EastUs|SouthEastAsia|WestEurope|WestUs2> \
  --devcontainer-path <path/to/.devcontainer.json> \
  --idle-timeout <duration> \
  --display-name <name-max-48-chars> \
  --default-permissions
```

- `--default-permissions` is **required** in non-interactive usage. Without
  it, `gh codespace create` blocks on stdin to prompt for additional
  permissions when the devcontainer requests OAuth scopes. In a spawned
  subprocess there is no TTY and the command will hang.
- `--machine` is optional; if omitted, the cheapest available machine is
  selected. For agent workloads, `standardLinux32gb` (4-core / 8 GB) is a
  reasonable default.
- Stdout on success: one line, the Codespace name (e.g.
  `urban-spork-abc123`). Capture with `stdout.trim()`.
- `--retention-period` is omitted in managed mode. Managed Codespaces are
  deleted on `close()`, so retention is moot.

### Poll for state

```sh
gh codespace view \
  --codespace <name> \
  --json state \
  --jq .state
```

Returns a bare string like `Available` or `Provisioning` (no surrounding
quotes). Exit code is `0` on success, non-zero on API error.

Alternative (returns more context for debugging):

```sh
gh codespace view \
  --codespace <name> \
  --json state,prebuild,location,machineName,gitStatus
```

### Start a stopped Codespace (mode: "existing" only)

The `gh` CLI has no `codespace start` top-level subcommand as of 2025.
The correct path is the REST API directly (which the gh CLI sources use
internally):

```sh
# Via the REST API using gh as the HTTP client:
gh api --method POST /user/codespaces/<name>/start
```

Or, as the investigation document notes, using `gh codespace ssh` which
implicitly starts a stopped Codespace as a side effect:

```sh
gh codespace ssh --codespace <name> -- true
```

The `gh api` form is preferable for `mode: "existing"` because it is
explicit, returns the updated Codespace object (including new state), and
does not require an SSH connection attempt. After calling it, poll
`gh codespace view --json state` until `Available`.

The underlying REST endpoint is `POST /user/codespaces/{codespace_name}/start`
(HTTP 200; HTTP 409 means already running — safe to ignore).

### Stop (for mode: "existing" close, or pre-delete)

```sh
gh codespace stop --codespace <name>
```

Underlying REST: `POST /user/codespaces/{codespace_name}/stop`

Transitions: `Available → ShuttingDown → Shutdown`.
Only CPU billing stops; storage billing continues until deletion.

### Delete (force, for mode: "managed" close)

```sh
gh codespace delete --codespace <name> --force
```

- `--force` skips the interactive "unsaved changes" confirmation prompt.
  Required for non-interactive usage.
- The underlying REST endpoint is
  `DELETE /user/codespaces/{codespace_name}` (HTTP 200 or 202 on success).
- Works on running, stopped, or transitional Codespaces. GitHub stops it
  internally before deleting.
- After the delete API call returns, the Codespace may briefly appear as
  `Deleted` or disappear entirely from `gh codespace list`.

### SSH into a running Codespace

```sh
gh codespace ssh --codespace <name> -- bash -c '<remote-command>'
```

Stdin is piped through transparently to the remote process. Use `-i` or
pipe input on the spawned child's stdin.

### Copy files

```sh
# Local → Codespace
gh codespace cp -r --codespace <name> <localPath> remote:<remotePath>

# Codespace → Local
gh codespace cp --codespace <name> remote:<remotePath> <localPath>
```

Never use `-e/--expand`; always pass absolute remote paths.

---

## Polling Loop Implementation Pattern

The following pseudocode matches the pattern used in the gh CLI's own
`CreateCodespace` implementation, adapted for Sandcastle's subprocess-based
approach:

```typescript
const TERMINAL_FAILURE_STATES = new Set([
  "Failed",
  "Unavailable",
  "Unknown",
  "Deleted",
  "Moved",
  "Archived",
]);

async function waitForAvailable(
  codespaceName: string,
  pollIntervalMs: number,
  timeoutMs: number,
  ghEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await runGh(
      [
        "codespace",
        "view",
        "--codespace",
        codespaceName,
        "--json",
        "state",
        "--jq",
        ".state",
      ],
      ghEnv,
    );

    if (state === "Available") {
      return;
    }

    if (TERMINAL_FAILURE_STATES.has(state)) {
      throw new CodespaceTerminalFailureError(codespaceName, state);
    }

    // All other states (Created, Queued, Provisioning, Awaiting,
    // Starting, ShuttingDown, Rebuilding, Updating) are transient.
    await sleep(pollIntervalMs);
  }

  throw new CodespaceTimeoutError(codespaceName, timeoutMs);
}
```

On timeout, the caller should attempt cleanup (`gh codespace delete --force`)
on a best-effort basis, then re-throw the timeout error.

---

## stop vs delete: When to Use Which

| Scenario                             | Command                       | Rationale                                                              |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| `mode: "managed"` normal close       | `gh codespace delete --force` | Terminates billing immediately. Stop is not needed; delete handles it. |
| `mode: "managed"` keepOnFailure=true | Skip both                     | Leave Codespace running for inspection.                                |
| `mode: "existing"` normal close      | `gh codespace stop`           | Preserves the Codespace for future use; user did not request deletion. |
| `mode: "existing"` explicit discard  | `gh codespace delete --force` | When the caller explicitly wants cleanup.                              |
| Pre-flight cleanup on timeout        | `gh codespace delete --force` | Prevents billing leak on orphaned Codespace.                           |
| Stopping before machine type change  | `gh codespace stop`           | Machine-type changes require a stopped Codespace.                      |

Key distinction: `stop` stops CPU billing but keeps storage billing and the
Codespace alive. `delete --force` terminates all billing and destroys all data.

---

## gh codespace create Flag Reference

All flags relevant to Sandcastle's managed-mode provider:

| Flag                    | Type          | Required | Notes                                                               |
| ----------------------- | ------------- | -------- | ------------------------------------------------------------------- |
| `-R`, `--repo`          | `string`      | Yes      | `owner/repo` format                                                 |
| `-b`, `--branch`        | `string`      | No       | Defaults to repo default branch                                     |
| `-m`, `--machine`       | `string`      | No       | Machine type name; see table below                                  |
| `-l`, `--location`      | `string`      | No       | `EastUs`, `SouthEastAsia`, `WestEurope`, `WestUs2`                  |
| `--devcontainer-path`   | `string`      | No       | Path to devcontainer.json inside repo                               |
| `--idle-timeout`        | `duration`    | No       | e.g. `30m`, `1h`; defaults to user setting (30 min)                 |
| `--retention-period`    | `duration`    | No       | Max 30 days; skip for managed mode                                  |
| `-d`, `--display-name`  | `string`      | No       | Max 48 chars                                                        |
| `--default-permissions` | `bool` (flag) | **Yes**  | Suppresses permissions prompt; required for non-interactive use     |
| `-s`, `--status`        | `bool` (flag) | No       | Shows post-create command and dotfile status on stderr; avoid in CI |

### Machine type names

Machine names are user-account and repository-plan dependent. Common names
(verify with `gh api /repositories/{id}/codespaces/machines`):

| Name                | Cores | RAM   | Storage | Notes                   |
| ------------------- | ----- | ----- | ------- | ----------------------- |
| `basicLinux32gb`    | 2     | 4 GB  | 32 GB   | Free-tier eligible      |
| `standardLinux32gb` | 4     | 8 GB  | 32 GB   | Standard workhorse      |
| `premiumLinux`      | 8     | 16 GB | 64 GB   | Heavy build workloads   |
| `largePremiumLinux` | 16    | 32 GB | 128 GB  | Largest general-purpose |

All machines run Linux x86_64. There is no ARM64 Codespace tier.

---

## REST API and Octokit Endpoint Reference

The `github-codespaces` provider uses `gh codespace` CLI commands rather than
`@octokit/*` directly (see investigation document; adding Octokit as a dep was
explicitly out-of-scope). However, for reference — and because the `gh api`
proxy form is a valid lightweight alternative for operations like `start` —
these are the underlying endpoints:

### REST endpoints

| Operation              | Method   | URL                                                 |
| ---------------------- | -------- | --------------------------------------------------- |
| Create Codespace       | `POST`   | `/user/codespaces`                                  |
| Get Codespace          | `GET`    | `/user/codespaces/{codespace_name}`                 |
| List Codespaces        | `GET`    | `/user/codespaces`                                  |
| Start Codespace        | `POST`   | `/user/codespaces/{codespace_name}/start`           |
| Stop Codespace         | `POST`   | `/user/codespaces/{codespace_name}/stop`            |
| Delete Codespace       | `DELETE` | `/user/codespaces/{codespace_name}`                 |
| List machines for repo | `GET`    | `/repositories/{repository_id}/codespaces/machines` |

All endpoints require a token with `codespace` scope. Fine-grained PATs do
not support Codespaces; use a classic PAT with `codespace` + `repo` scopes, or
an OAuth token from `gh auth login`.

### Octokit method names (if ever needed)

From `@octokit/plugin-rest-endpoint-methods`:

```typescript
octokit.rest.codespaces.createForAuthenticatedUser({ repository_id, ... })
octokit.rest.codespaces.getForAuthenticatedUser({ codespace_name })
octokit.rest.codespaces.listForAuthenticatedUser()
octokit.rest.codespaces.startForAuthenticatedUser({ codespace_name })
octokit.rest.codespaces.stopForAuthenticatedUser({ codespace_name })
octokit.rest.codespaces.deleteForAuthenticatedUser({ codespace_name })
octokit.rest.codespaces.codespaceMachinesForAuthenticatedUser({ repository_id, ... })
```

These are not used in the Sandcastle provider implementation (gh CLI is the
transport), but are listed here for completeness and potential future use.

---

## Rate Limits

### Primary rate limit

Authenticated users: **5,000 requests/hour**.

Polling at 3-second intervals for 10 minutes = 200 requests. At 5 seconds =
120 requests. Both are well inside the 5,000/hour primary limit.

### Secondary rate limits

GitHub enforces secondary rate limits relevant to Codespace operations:

| Rule                        | Limit                                   |
| --------------------------- | --------------------------------------- |
| Concurrent requests         | Max 100                                 |
| REST GET/HEAD/OPTIONS       | 1 point each (900 points/minute max)    |
| REST POST/PATCH/PUT/DELETE  | 5 points each (900 points/minute max)   |
| Content-generating requests | Max 80/minute, 500/hour                 |
| CPU time                    | 90 seconds CPU per 60 seconds wall time |

**Creating** a Codespace is a `POST` request (5 points). If creating many
Codespaces in rapid succession (e.g. parallel agent runs), space creations at
least 1 second apart. Polling GET requests (1 point each) are effectively free
at Sandcastle's cadence.

On `429` or `403` with secondary-rate-limit body, read the `retry-after`
header and wait that many seconds before retrying. If absent, wait 60 seconds
before the first retry and apply exponential backoff.

---

## Best Practices

1. **Always include `--default-permissions`** in `gh codespace create`. Without
   it, the command blocks on a TTY prompt when the devcontainer requests
   additional OAuth scopes. This flag suppresses the prompt and opts out of
   additional permissions, which is safe for Sandcastle's sandboxed workloads.

2. **Detect terminal-failure states immediately.** Do not continue polling
   when the state is `Failed`, `Unavailable`, `Unknown`, `Deleted`, `Moved`,
   or `Archived`. These states will not recover without external intervention.
   Attempt cleanup and throw a descriptive error.

3. **Use `delete --force` over `stop` + `delete` in managed mode.** The delete
   endpoint works on running Codespaces directly. Adding a stop step before
   delete only increases teardown latency and the window during which the
   Codespace can be missed by cleanup on process exit.

4. **Register signal handlers for cleanup.** In managed mode, a leaked
   Codespace incurs per-minute CPU charges. Register `process.on("exit")`,
   `process.on("SIGINT")`, and `process.on("SIGTERM")` handlers to call
   `gh codespace delete --force` synchronously (or schedule it for
   best-effort). Follow the `docker.ts` pattern.

5. **Use `GH_TOKEN` env var, not `--auth-token`.** The `gh` CLI reads
   `GH_TOKEN` automatically. Set it in `env: { ...process.env, GH_TOKEN:
options.token }` on spawned gh child processes. Never pass tokens as CLI
   arguments (they appear in `ps` output).

6. **Set an explicit `--idle-timeout` shorter than the run's expected
   duration.** The default is 30 minutes; if the agent run completes in
   2 minutes and `close()` fails, the Codespace will auto-stop after
   `idle-timeout` minutes of inactivity. A value of `10m` is a safe safety
   net. The provider option should pass through directly.

7. **Capture the Codespace name from stdout, not from an intermediate state
   poll.** `gh codespace create` prints exactly the Codespace name on stdout
   once the name is allocated (even while provisioning continues). Trim
   whitespace. All subsequent operations use this name.

8. **Do not rely on `gh codespace start` as a top-level CLI subcommand.** As
   of 2025, there is no `gh codespace start` CLI subcommand. Use
   `gh api --method POST /user/codespaces/<name>/start` or
   `gh codespace ssh -- true` to wake a stopped Codespace.

9. **Check the `prebuild` field for diagnostics.** The Codespace object
   returned by `gh codespace view --json prebuild` has a `prebuild` boolean.
   Log it during creation so timeout issues can be correlated with prebuild
   availability.

10. **Poll `state` only; do not rely on `pendingOperation`.** The REST API
    returns a `pending_operation` boolean and `pending_operation_disabled_reason`
    string. These are UI hints (shown in the GitHub web UI to grey-out action
    buttons). They do not reliably signal the same lifecycle transitions as
    `state` and should not be used in polling logic.

---

## Known Issues and Pitfalls

### `gh codespace create` may hang without `--default-permissions`

When a devcontainer's `customizations.codespaces.repositories` field requests
additional permissions, `gh codespace create` blocks on stdin for user
confirmation. In a non-TTY subprocess, this causes an indefinite hang. The fix
is to always pass `--default-permissions`. This opts the Codespace out of the
additional permissions rather than waiting for approval. If the target
devcontainer requires those permissions to function, the agent will still be
created but may have reduced access to other repos.

### Container build failures surface as `Failed` after the 202

The GitHub REST API returns HTTP 202 immediately when a Codespace create
request is accepted, before provisioning completes. The `state` at that point
is `Created` or `Provisioning`. Container build failures (e.g. broken
Dockerfile) are only detected when the VM build step runs, which can be
minutes later. The state transitions to `Failed`. The provider must continue
polling and not treat the initial 202 as "done".

### `gh codespace ssh -- true` as an implicit start

When `gh codespace ssh` targets a stopped Codespace, it calls
`POST /user/codespaces/{name}/start` internally, waits for `Available`, then
establishes the SSH tunnel. This is documented behavior used by the VS Code
extension. Sandcastle uses this for `mode: "existing"` when the Codespace is
in `Shutdown` state, but `gh api --method POST /user/codespaces/<name>/start`
is preferred for explicitness in production code.

### Symlink handling in `gh codespace cp`

`gh codespace cp` is backed by `scp`, which dereferences symlinks by default.
Monorepos using `pnpm` or similar tools that use symlinks for `node_modules`
linking may have symlinks silently converted to regular files. This affects
`copyIn` for directory trees; it does not affect `copyFileOut` of individual
files or the `exec`-based commit-extraction path in `syncOut.ts`.

### Codespace limit errors

GitHub caps the number of active and total Codespaces per user (plan-
dependent). If the limit is reached, `gh codespace create` returns a non-zero
exit code with an error message. The provider must surface this as a distinct
error type so the caller can take remediation action (delete old Codespaces).

### Region availability

Not all machine types are available in all regions. If `--machine` specifies
a type unavailable in `--location`, creation fails. If `--location` is
omitted, GitHub selects the nearest region automatically. For Sandcastle,
omitting `--location` is recommended unless the caller has a specific
latency requirement.

---

## Assumptions and Scope

| Assumption                                                    | Confidence | Impact if Wrong                                                                                                                            |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| State strings are PascalCase and stable                       | HIGH       | Polling logic would fail silently on state changes; mitigate with a catch-all "unknown state, keep polling" branch for unrecognized values |
| The gh CLI spawns a subprocess per poll call                  | HIGH       | If a native REST client were used, 1-second polling would be feasible                                                                      |
| No ARM64 Codespace tier exists                                | HIGH       | Architecture assumptions in Dockerfile would be wrong                                                                                      |
| `gh codespace create` stdout is exactly the Codespace name    | HIGH       | Parse would need adjustment if gh changes output format                                                                                    |
| Cold-start p95 is under 10 minutes                            | MEDIUM     | If creation exceeds 10 minutes regularly, `createTimeoutMs` default should be raised to 15 minutes                                         |
| Fine-grained PATs do not support Codespaces                   | MEDIUM     | GitHub could add support; the investigation noted this limitation as current as of the research date                                       |
| Secondary rate limits are not triggered by poll-at-3s cadence | HIGH       | If GitHub tightens limits, increase `pollIntervalMs` to 10 seconds                                                                         |
| `--default-permissions` opts out gracefully                   | HIGH       | If changed to block on absent TTY, the create call would still hang                                                                        |

### Scope exclusions

- Octokit-based implementation (out of scope per requirements doc; `gh` CLI is the transport)
- Prebuild management (creation and scheduling is a repository admin concern, not provider concern)
- Multi-region failover logic
- Organization-scoped Codespace creation (`/orgs/*/codespaces`)
- GitHub Enterprise Server Codespaces (different API base URL; scope-limited to github.com)

---

## Clarifying Questions for Follow-up

1. Should `createTimeoutMs` have a different default for repos known to have
   prebuilds configured? This could be detected from the machine-list API
   response (`prebuild_availability` field on each machine).
2. Should the provider expose a `region` option mapped to `--location`? Or is
   automatic region selection always preferable?
3. Is there a CI-specific concern where the GH_TOKEN in Actions workflows
   (`GITHUB_TOKEN`) lacks `codespace` scope by default, requiring a separate
   secret? The investigation says yes; should the error message be explicit
   about this?
4. Should the provider emit a structured warning when `prebuild: false` to
   indicate that the creation may be slow?
5. What is the intended behavior when `gh codespace create` hits the user's
   Codespace limit? Should Sandcastle attempt to delete the oldest Codespace
   automatically, or throw and let the caller decide?

---

## References

| #   | Source                                  | URL                                                                                                                 | What was learned                                                                                                                                                                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | gh codespace create manual              | https://cli.github.com/manual/gh_codespace_create                                                                   | All create flags; `--default-permissions` semantics; stdout format                                                                                                                             |
| 2   | gh codespace view manual                | https://cli.github.com/manual/gh_codespace_view                                                                     | JSON fields including `state`, `prebuild`, `pendingOperation`                                                                                                                                  |
| 3   | gh codespace stop manual                | https://cli.github.com/manual/gh_codespace_stop                                                                     | Stop semantics; `-c`, `-R`, `-u` flags                                                                                                                                                         |
| 4   | gh codespace delete manual              | https://cli.github.com/manual/gh_codespace_delete                                                                   | `--force` flag; `--days` for bulk cleanup                                                                                                                                                      |
| 5   | gh codespace root manual                | https://cli.github.com/manual/gh_codespace                                                                          | Confirmed: no `gh codespace start` subcommand exists                                                                                                                                           |
| 6   | GitHub Codespaces lifecycle docs        | https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle                        | Stop/delete/rebuild semantics; retention defaults; idle-timeout behavior                                                                                                                       |
| 7   | Stopping and starting a codespace       | https://docs.github.com/en/codespaces/developing-in-a-codespace/stopping-and-starting-a-codespace                   | No `gh codespace start` CLI command; `gh codespace code` / `ssh` as implicit start paths                                                                                                       |
| 8   | GitHub REST API rate limits             | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api                                     | Primary: 5,000/hr; secondary: 900 points/min, 80 content/min; point costs per method                                                                                                           |
| 9   | REST API best practices                 | https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api                            | `retry-after` header handling; exponential backoff; serial vs concurrent requests                                                                                                              |
| 10  | Codespaces REST API docs                | https://docs.github.com/en/rest/codespaces/codespaces?apiVersion=2022-11-28                                         | Endpoint URLs; HTTP status codes; Codespace object structure                                                                                                                                   |
| 11  | GitHub machine types docs               | https://docs.github.com/en/codespaces/customizing-your-codespace/changing-the-machine-type-for-your-codespace       | Machine type names; all are Linux x86_64                                                                                                                                                       |
| 12  | Prebuilds documentation                 | https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds                 | Prebuild timing: cold ~2–7 min, prebuild ~25 s                                                                                                                                                 |
| 13  | gh CLI source: api.go (state constants) | https://raw.githubusercontent.com/cli/cli/trunk/internal/codespaces/api/api.go                                      | Exact state string constants: `Available`, `Shutdown`, `ShuttingDown`, `Starting`, `Rebuilding`                                                                                                |
| 14  | gh CLI source: api.go (CreateCodespace) | https://raw.githubusercontent.com/cli/cli/trunk/internal/codespaces/api/api.go                                      | Internal polling: 1-second interval, 2-minute timeout for provisioning-complete; HTTP 202 means async                                                                                          |
| 15  | gh CLI source: api.go (StartCodespace)  | https://raw.githubusercontent.com/cli/cli/trunk/internal/codespaces/api/api.go                                      | `POST /user/codespaces/{name}/start`; HTTP 409 = already running (safe to ignore)                                                                                                              |
| 16  | gh CLI source: create.go                | https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/codespace/create.go                                         | `--default-permissions` maps to `PermissionsOptOut: true`; stdout is `fmt.Fprintln(a.io.Out, codespace.Name)`                                                                                  |
| 17  | GitHub REST API OpenAPI state enum      | https://github.com/github/rest-api-description                                                                      | Full state enum: Unknown, Created, Queued, Provisioning, Available, Awaiting, Unavailable, Deleted, Moved, Shutdown, Archived, Starting, ShuttingDown, Failed, Exporting, Updating, Rebuilding |
| 18  | Octokit endpoint methods                | https://github.com/octokit/plugin-rest-endpoint-methods.js                                                          | `startForAuthenticatedUser`, `stopForAuthenticatedUser`, `deleteForAuthenticatedUser`, etc.                                                                                                    |
| 19  | Codespace lifecycle: timing benchmarks  | https://www.sitepoint.com/github-codespaces-prebuilds-ci-cd-optimization/                                           | Cold: 7+ min for complex repo; prebuild: ~25 s                                                                                                                                                 |
| 20  | Investigation document                  | /Users/giorgosmarinos/aiwork/coding-platform/sandcastle/docs/reference/investigation-apple-containers-codespaces.md | Prior art: recommended `gh codespace view --json state` polling; `--default-permissions` requirement; `GH_TOKEN` injection                                                                     |

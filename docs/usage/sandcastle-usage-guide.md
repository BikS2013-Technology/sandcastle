# Sandcastle — Usage Guide

How to install, configure, and use `@ai-hero/sandcastle` (BikS2013-Technology fork, `biks-branch`) inside a consumer project.

This guide is the canonical reference for **consuming** sandcastle. For the architecture of sandcastle itself, see `docs/design/project-design.md`. For the language/glossary, see `CONTEXT.md`.

> **Mandatory install source**: this fork only — `https://github.com/BikS2013-Technology/sandcastle/tree/biks-branch`. See the project `CLAUDE.md` §"Installation source — MANDATORY" for the full rule and forbidden alternatives.

---

## 1. What sandcastle does

Sandcastle is a TypeScript library that orchestrates an **agent** (Claude Code, Codex, etc.) inside a **sandbox** (Docker, Podman, Apple Containers, Vercel, GitHub Codespaces, or no-sandbox). One call to `sandcastle.run()` does:

1. Creates a **worktree** on the host (or works in HEAD).
2. Creates the **sandbox** via the chosen **sandbox provider**.
3. Streams a fully-resolved **prompt** to the agent.
4. Captures any commits the agent makes.
5. Merges them back to the **target branch** according to the configured **branch strategy**.
6. Tears down the sandbox.

Every term above is defined in `CONTEXT.md` — use those terms exactly when filing issues or writing code.

---

## 2. Installation

### 2.1. Required commands

```bash
# Track the branch tip (auto-updates on `npm install`)
npm install --save-dev "BikS2013-Technology/sandcastle#biks-branch"

# Or, pin to a specific commit on biks-branch (recommended for reproducibility)
npm install --save-dev "BikS2013-Technology/sandcastle#<commit-sha>"

# SSH variant (only on machines with org write access — uses the github-biks-tech key alias)
npm install --save-dev "git+ssh://git@github.com/BikS2013-Technology/sandcastle.git#biks-branch"
```

### 2.2. Forbidden commands

```bash
# ❌ NEVER from public npm — missing apple-containers and github-codespaces providers
npm install --save-dev @ai-hero/sandcastle

# ❌ NEVER from upstream — missing the same providers
npm install --save-dev "mattpocock/sandcastle"

# ❌ NEVER from biks2013-technology main — missing the rollout
npm install --save-dev "BikS2013-Technology/sandcastle#main"
```

### 2.3. Build caveat for git-based installs

The fork's `package.json#prepare` runs `husky` only — it does **not** run `tsgo build`. A plain `npm install "BikS2013-Technology/sandcastle#biks-branch"` therefore pulls source without `dist/`.

Three workarounds, in order of preference:

1. **`npm pack` + tarball install** (most reliable):

   ```bash
   git clone -b biks-branch git@github-biks-tech:BikS2013-Technology/sandcastle.git
   cd sandcastle
   npm install
   npm run build
   npm pack
   # Copy the resulting ai-hero-sandcastle-<ver>.tgz into your consumer project, then:
   cd /path/to/your/consumer
   npm install --save-dev /path/to/sandcastle/ai-hero-sandcastle-0.5.7.tgz
   ```

2. **`npm link`** (best for active development):

   ```bash
   cd /path/to/sandcastle && npm install && npm run build && npm link
   cd /path/to/consumer && npm link @ai-hero/sandcastle
   ```

3. **Patch `prepare` upstream** (one-time fix to the fork):
   ```jsonc
   // package.json
   "prepare": "husky && npm run build"
   ```
   With this in place, plain git-installs work — but the install becomes slower and assumes consumers have the build toolchain.

### 2.4. Verify the install

This one-liner fails fast if the wrong source was used:

```bash
node --input-type=module -e "import {appleContainers} from '@ai-hero/sandcastle/sandboxes/apple-containers'; console.log(typeof appleContainers)"
# Expected: function
```

---

## 3. Initial project setup

```bash
# Scaffold .sandcastle/ in the consumer repo
npx sandcastle init
```

This prompts you to pick:

- A **sandbox provider** (`docker`, `podman`, `apple-containers`, `vercel`, `github-codespaces`).
- An **agent** (Claude Code, Codex, etc.).
- A **backlog manager** (GitHub Issues, Beads, etc.).

It creates:

```
.sandcastle/
├── .env.example
├── .gitignore
├── CODING_STANDARDS.md     # surfaced to the agent
├── Dockerfile              # bind-mount/isolated providers that need an image
├── implement-prompt.md     # default prompt template
├── plan-prompt.md          # orchestrator/planner prompt
├── review-prompt.md        # reviewer prompt
├── merge-prompt.md
├── main.ts                 # programmatic entry — edit this
└── logs/                   # written to in log-to-file mode
```

Then:

```bash
cp .sandcastle/.env.example .sandcastle/.env
# edit .sandcastle/.env — fill in ANTHROPIC_API_KEY (and any provider creds)
```

Build the sandbox image (if the chosen provider needs one):

```bash
npx sandcastle docker build-image                  # docker
npx sandcastle podman build-image                  # podman
npx sandcastle apple-containers build-image        # apple-containers (this fork only)
npx sandcastle github-codespaces verify            # codespaces — verifies gh auth, no image
```

Run the agent:

```bash
npx tsx .sandcastle/main.ts
```

---

## 4. Sandbox providers — when to use which

| Provider             | Type       | Strategies                  | Use case                                           | Prereqs                                                      |
| -------------------- | ---------- | --------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `docker()`           | bind-mount | head, merge-to-head, branch | Local dev on Linux/macOS/Windows                   | Docker Desktop running                                       |
| `podman()`           | bind-mount | head, merge-to-head, branch | Rootless local dev                                 | `podman` CLI + `podman machine start`                        |
| `appleContainers()`  | bind-mount | head, merge-to-head, branch | Native Apple Silicon, no Docker Desktop            | macOS-arm64, Apple `container` CLI, `container system start` |
| `vercel()`           | isolated   | merge-to-head, branch       | Cloud Firecracker microVMs, AFK runs               | `VERCEL_TOKEN`, `@vercel/sandbox` peer                       |
| `daytona()`          | isolated   | merge-to-head, branch       | Daytona cloud workspaces                           | `@daytona/sdk` peer                                          |
| `githubCodespaces()` | isolated   | merge-to-head, branch       | Long-running cloud envs already wired to GitHub    | `gh` CLI authenticated; `repo` + `codespace` token scopes    |
| `noSandbox()`        | none       | head, merge-to-head, branch | `interactive()` only — agent runs directly on host | None                                                         |

**Branch strategy reminder** (from `CONTEXT.md`):

- `head` — agent writes directly to host working dir.
- `merge-to-head` — agent works on a temp branch in a worktree, gets merged back to HEAD.
- `branch` — commits land on an explicitly named branch.

`head` is **not** valid on isolated providers — enforced at the type level.

---

## 5. Programmatic API — minimum viable usage

### 5.1. AFK run (no UI)

```ts
// .sandcastle/main.ts
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(), // bind-mount, head strategy = default
  promptFile: ".sandcastle/implement-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42 }, // substitutes {{ISSUE_NUMBER}}
});

console.log(result.stdout);
```

### 5.2. Interactive run (TUI on the host)

```ts
import { interactive, claudeCode } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: noSandbox(), // run agent directly on host
  prompt: "Refactor src/foo.ts to use Effect.gen",
  cwd: process.cwd(),
});
```

### 5.3. Reusable sandbox

```ts
import { createSandbox, claudeCode } from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

await using sandbox = await createSandbox({
  sandbox: podman({ branchStrategy: { type: "merge-to-head" } }),
});

const a = await sandbox.run({
  agent: claudeCode("claude-opus-4-7"),
  prompt: "Plan X",
});
const b = await sandbox.run({
  agent: claudeCode("claude-opus-4-7"),
  prompt: "Implement X",
});
const c = await sandbox.run({
  agent: claudeCode("claude-opus-4-7"),
  prompt: "Review X",
});
// `await using` triggers close() automatically; merges all three runs' commits to HEAD
```

### 5.4. Independent worktree

```ts
import { createWorktree, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const wt = await createWorktree({ branch: "feature/auth" });
await wt.run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  promptFile: ".sandcastle/implement-prompt.md",
});
await wt.close();
```

---

## 6. Per-provider examples

### 6.1. apple-containers (this fork only)

```ts
import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers";

const sandbox = appleContainers({
  imageName: "sandcastle-apple-containers", // optional, has a default
  branchStrategy: { type: "merge-to-head" }, // optional, default = head
});
```

Pre-flight checks (run automatically; fail loudly if any miss):

1. `darwin/arm64` — fails on Linux, Windows, or Intel macs.
2. `container --version` — Apple's `container` CLI must be installed.
3. `container system status` — runtime must be running (`container system start` first).
4. `container image inspect <imageName>` — image must exist (run `npx sandcastle apple-containers build-image`).

`copyFileIn` / `copyFileOut` use `node:fs/promises` against the bind-mount directly — no `container cp` shim is invoked.

### 6.2. github-codespaces (this fork only)

Two modes — pick one.

**Mode `existing`** — drive a Codespace you already created:

```ts
import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces";

const sandbox = githubCodespaces({
  mode: "existing",
  name: "my-codespace-name", // from `gh codespace list`
  token: process.env.GH_TOKEN, // optional; falls back to gh CLI auth
  branchStrategy: { type: "merge-to-head" },
});
```

**Mode `managed`** — create + tear down per run:

```ts
const sandbox = githubCodespaces({
  mode: "managed",
  repo: "owner/repo",
  branch: "main", // optional
  machine: "standardLinux32gb", // optional
  devcontainerPath: ".devcontainer/devcontainer.json", // optional
  idleTimeout: "30m", // optional
  retentionPeriod: "1d", // optional
  pollIntervalMs: 3_000, // default 3 s
  createTimeoutMs: 600_000, // default 10 min — covers cold start
  deleteOnClose: true, // default true — deletes on normal close
  stopOnClose: false, // default false — delete is faster
  keepOnFailure: false, // signal-only: skip delete on SIGINT/SIGTERM/SIGHUP
  token: process.env.GH_TOKEN,
  branchStrategy: { type: "merge-to-head" },
});
```

**Constraints**:

- All Codespaces are Linux x86_64 — no ARM tier exists.
- `gh codespace exec` does **not** exist — sandcastle uses `gh codespace ssh -c <name> -- <cmd>` exclusively.
- `--default-permissions` is always passed on `create` to avoid TTY prompts.
- The `head` branch strategy is rejected at the type level.

---

## 7. Prompts — three modes

### 7.1. Inline string

```ts
await run({ agent, sandbox, prompt: "Fix the typecheck errors in src/foo.ts" });
```

No substitution, no expansion. Cannot combine with `promptArgs`.

### 7.2. Prompt template file

```ts
await run({
  agent,
  sandbox,
  promptFile: "./.sandcastle/implement-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42 },
});
```

The template may contain:

- `{{KEY}}` placeholders → resolved by **prompt argument substitution** on the host before the sandbox starts.
- `` !`<cmd>` `` shell expressions → evaluated inside the sandbox before each iteration.

### 7.3. Built-in prompt arguments

These are injected automatically — never override them in `promptArgs`:

- `{{SOURCE_BRANCH}}` — the branch the agent works on.
- `{{TARGET_BRANCH}}` — the host's active branch at `run()` time.

Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` raises an error.

---

## 8. Hooks

```ts
await run({
  agent,
  sandbox,
  prompt: "...",
  hooks: {
    host: {
      onWorktreeReady: { command: "npm install" }, // host-side, after worktree is created
      onSandboxReady: { command: "echo 'sandbox up'" }, // host-side, after sandbox is up
    },
    sandbox: {
      onSandboxReady: { command: "apt-get update", sudo: true }, // inside sandbox; sudo allowed
    },
  },
});
```

Lifecycle order: `copyToWorktree` → `host.onWorktreeReady` (sequential) → sandbox created → `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel).

---

## 9. Logging modes

### 9.1. Log-to-file (default for `run()`)

```ts
await run({
  agent,
  sandbox,
  prompt: "...",
  logging: {
    type: "file",
    onAgentStreamEvent: (ev) => myObservability.send(ev), // optional forwarder
  },
});
```

Writes to `.sandcastle/logs/<run-id>.log`. The `onAgentStreamEvent` callback is sync, fire-and-forget — errors thrown in it are swallowed.

### 9.2. Terminal (interactive UI)

```ts
await run({ agent, sandbox, prompt: "...", logging: { type: "stdout" } });
```

Renders spinners, styled status, and summaries directly. Usually only used when `interactive()` is too heavyweight.

---

## 10. Common workflows (recipes)

### 10.1. Implement a single GitHub issue

```ts
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker({ branchStrategy: { type: "merge-to-head" } }),
  promptFile: "./.sandcastle/implement-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42 },
});
```

### 10.2. Plan → implement → review pipeline

```ts
await using sandbox = await createSandbox({ sandbox: docker() });
const plan = await sandbox.run({ agent, promptFile: "./plan.md" });
const impl = await sandbox.run({
  agent,
  promptFile: "./implement.md",
  promptArgs: { PLAN: plan.stdout },
});
const rev = await sandbox.run({ agent, promptFile: "./review.md" });
```

### 10.3. AFK on a Codespace, parallel issues

```ts
const issues = [101, 102, 103];
await Promise.all(
  issues.map((n) =>
    run({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: githubCodespaces({
        mode: "managed",
        repo: "owner/repo",
        branch: `auto/${n}`,
      }),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: { ISSUE_NUMBER: n },
    }),
  ),
);
```

### 10.4. Mac-native development without Docker Desktop

```ts
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: appleContainers({ branchStrategy: { type: "merge-to-head" } }),
  promptFile: "./.sandcastle/implement-prompt.md",
});
```

---

## 11. Troubleshooting

| Symptom                                                               | Likely cause                          | Fix                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Cannot find module '@ai-hero/sandcastle/sandboxes/apple-containers'` | Installed from npm or upstream        | Reinstall from `BikS2013-Technology/sandcastle#biks-branch` (§2.1).                                             |
| `apple-containers provider requires macOS on Apple Silicon`           | Wrong host arch                       | Use `docker()` or `podman()` instead.                                                                           |
| `container CLI not found`                                             | Apple `container` not installed       | Install Apple's container runtime; run `container system start`.                                                |
| `Image '<name>' not found` (apple-containers)                         | Skipped image build                   | `npx sandcastle apple-containers build-image`.                                                                  |
| `gh: command not found`                                               | `gh` CLI missing                      | `brew install gh && gh auth login`.                                                                             |
| Codespaces `create` hangs                                             | `--default-permissions` not passed    | Already handled by sandcastle; hang likely indicates stale auth — `gh auth refresh -h github.com -s codespace`. |
| Codespaces stays in `Provisioning` past 10 min                        | Cold start exceeded `createTimeoutMs` | Raise `createTimeoutMs` to e.g. `900_000`, or warm via prebuilds.                                               |
| `head` strategy rejected on `githubCodespaces()`                      | Type-level constraint                 | Use `merge-to-head` or `branch`.                                                                                |
| Build fails with `Cannot find module '@daytona/sdk'`                  | Optional peer not installed           | Either install `@daytona/sdk` or don't import `daytona.ts`.                                                     |
| `npm install` from git produces no `dist/`                            | `prepare` doesn't build               | Use `npm pack`, `npm link`, or patch `prepare` (§2.3).                                                          |

---

## 12. Reference

- Glossary / terminology: `CONTEXT.md` at repo root.
- Architecture and ADRs: `docs/design/project-design.md`.
- Functional requirements: `docs/design/project-functions.md`.
- Apple-containers and Codespaces requirements doc: `docs/design/requirements-001-apple-containers-and-codespaces-providers.md`.
- Apple-containers and Codespaces investigation: `docs/reference/investigation-apple-containers-codespaces.md`.
- Effect-shell-out research: `docs/research/effect-shell-out-patterns.md`.
- Codespaces lifecycle research: `docs/research/codespaces-lifecycle.md`.
- Outstanding issues: `Issues - Pending Items.md` at repo root.

---

## 13. Versioning rule

This fork uses pre-1.0 patch-level changesets (`patch`) for every user-facing change. When you bump the dependency in a consumer, **always re-run the verification one-liner** from §2.4 to confirm the install still resolves the fork-only providers. If it doesn't, the install lock has drifted to the public npm package — re-pin to the fork's commit SHA.

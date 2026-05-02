<structure-and-conventions>
## Structure & Conventions

- Every time you want to create a test script, you must create it in the test_scripts folder. If the folder doesn't exist, you must make it.

- All the plans must be kept under the docs/design folder inside the project's folder in separate files: Each plan file must be named according to the following pattern: plan-xxx-<indicative description>.md

- The complete project design must be maintained inside a file named docs/design/project-design.md under the project's folder. The file must be updated with each new design or design change.

- All the reference material used for the project must be collected and kept under the docs/reference folder.
- All the functional requirements and all the feature descriptions must be registered in the /docs/design/project-functions.MD document under the project's folder.

<configuration-guide>
- If the user ask you to create a configuration guide, you must create it under the docs/design folder, name it configuration-guide.md and be sure to explain the following:
  - if multiple configuration options exist (like config file, env variables, cli params, etc) you must explain the options and what is the priority of each one.
  - Which is the purpose and the use of each configuration variable
  - How the user can obtain such a configuration variable
  - What is the recomented approach of storing or managing this configuration variable
  - Which options exist for the variable and what each option means for the project
  - If there are any default value for the parameter you must present it.
  - For configuration parameters that expire (e.g., PAT keys, tokens), I want you to propose to the user adding a parameter to capture the parameter's expiration date, so the app or service can proactively warn users to renew.
</configuration-guide>

- Every time you create a prompt working in a project, the prompt must be placed inside a dedicated folder named prompts. If the folder doesn't exists you must create it. The prompt file name must have an sequential number prefix and must be representative to the prompt use and purpose.

- You must maintain a document at the root level of the project, named "Issues - Pending Items.md," where you must register any issue, pending item, inconsistency, or discrepancy you detect. Every time you fix a defect or an issue, you must check this file to see if there is an item to remove.
- The "Issues - Pending Items.md" content must be organized with the pending items on top and the completed items after. From the pending items the most critical and important must be first followed by the rest.

- When I ask you to create tools in the context of a project everything must be in Typescript.

- **Tool creation is MANDATORY via `/tool-conventions scaffold <tool-name>`.** Do NOT scaffold a tool's documentation file or its `~/.tool-agents/<tool-name>/` configuration folder by hand under any circumstances. Always invoke the slash command, which dispatches the `tool-doc-config-architect` subagent (`~/.claude/agents/tool-doc-config-architect.md`). The subagent owns the full specification — the documentation file format (the `<toolName>` XML block under `docs/tools/<tool-name>.md`), the configuration folder structure and modes (`~/.tool-agents/<tool-name>/` at `0700`, `.env` at `0600`), the four-tier env-var resolution chain (shell env → `~/.tool-agents/<name>/.env` → local `.env` → CLI flags, lowest to highest priority), the vendor-canonical LLM provider env-var names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_*`, `AZURE_AI_INFERENCE_*`, `OLLAMA_HOST`, `LITELLM_*`), and the required set of eight standard LLM providers every LLM-enabled tool must support out of the box. To inspect the full specification, read the subagent prompt directly. For existing tools, run `/tool-conventions audit <tool-name>` to verify conformance against the same specification.

- The project's CLAUDE.md file must NOT contain the full tool documentation. Instead, it must contain a "Tools" section with a concise reference entry for each tool that includes:
  - The tool's name
  - A high-level description of what the tool is capable of (one or two sentences)
  - The relative path to the tool's dedicated documentation file (e.g. `docs/tools/<tool-name>.md`) so that Claude can retrieve the full documentation any time it is needed.

  The slash command produces the recommended entry text after each scaffold for the user to review and apply.

- Every time I ask you to do something that requires the creation of a code script, I want you to examine the tools already implemented in the scope of the project (by consulting the "Tools" section of the project's CLAUDE.md and the corresponding documentation files under `docs/tools/`) to detect if the code you plan to write fits to the scope of an existing tool.
- If so, I want you to implement the code as an extension of the tool, otherwise I want you to build a generic and abstract version of the code as a tool, which will be part of the toolset of the project.
- Our goal is, while the project progressing, to develop the tools needed to test, evaluate, generate data, collect information, etc and reuse them in a consistent manner.
- All these tools must be referenced inside the project's CLAUDE.md (with their dedicated documentation files under `docs/tools/`) to allow their consistent reuse.

- When I ask you to locate code, I need to give me the folder, the file name, the class, and the line number together with the code extract.
- Don't perform any version control operation unless I explicitly request it.

- When you design databases you must align with the following table naming conventions:
  - Table names must be singular e.g. the table that keeps customers' data must be called "Customer"
  - Tables that are used to express references from one entity to another can by plural if the first entity is linked to many other entities.
  - So we have "Customer" and "Transaction" tables, we have CustomerTransactions.

- You must never create fallback solutions for configuration settings. In every case a configuration setting is not provided you must raise the appropriate exception. You must never substitute the missing config value with a default or a fallback value.
- If I ask you to make an exception to the configuration setting rule, you must write this exception in the projects memory file, before you implement it.

- Every time you are asked to solve an issue, you must resolve it AND thoroughly document both the issue and the solution.

</structure-and-conventions>

Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all changesets `patch` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Installation source — MANDATORY

**`@ai-hero/sandcastle` MUST always be installed from the BikS2013-Technology fork, `biks-branch`. NEVER install it from npm, from `mattpocock/sandcastle`, or from any other branch or fork.**

Canonical source: https://github.com/BikS2013-Technology/sandcastle/tree/biks-branch

This fork carries internal patches (notably the `apple-containers` and `github-codespaces` sandbox providers) that are not present in the upstream npm release or in the upstream `main` branch. Pulling sandcastle from anywhere else will silently lose those providers and any other internal customisation.

### Required install commands

For consumers (other projects that depend on sandcastle):

```bash
# Pin to the branch tip
npm install --save-dev "BikS2013-Technology/sandcastle#biks-branch"

# Or, if installing via SSH from a machine with org access:
npm install --save-dev "git+ssh://git@github.com/BikS2013-Technology/sandcastle.git#biks-branch"

# Or, pin to a specific commit on biks-branch (preferred for reproducibility):
npm install --save-dev "BikS2013-Technology/sandcastle#<commit-sha>"
```

### Forbidden install commands (never use these)

```bash
# ❌ Public npm — does NOT contain the apple-containers or github-codespaces providers
npm install --save-dev @ai-hero/sandcastle

# ❌ Upstream repo — does NOT contain BikS2013-Technology patches
npm install --save-dev "mattpocock/sandcastle"
npm install --save-dev "mattpocock/sandcastle#main"

# ❌ Any branch other than biks-branch on the BikS2013-Technology fork
npm install --save-dev "BikS2013-Technology/sandcastle#main"
```

### Build note for git-based installs

Because this fork's `package.json` does not run `tsgo build` in its `prepare` script, an `npm install` from git pulls source only — no `dist/`. Consumers must either:

1. Install from a `npm pack` tarball produced after `npm run build`, OR
2. Use `npm link` against a locally built checkout, OR
3. Patch the fork's `prepare` script to also build (one-line change, then re-push to `biks-branch`).

Verify a successful install by importing one of the fork-only providers — if the import resolves and the factory is a function, the install is correct:

```bash
node --input-type=module -e "import {appleContainers} from '@ai-hero/sandcastle/sandboxes/apple-containers'; console.log(typeof appleContainers)"
# Expected output: function
```

If this fails or prints `undefined`, sandcastle was installed from the wrong source — uninstall and reinstall from the BikS2013-Technology biks-branch.

## How to use sandcastle

The full **Sandcastle Usage Guide** lives at [`docs/usage/sandcastle-usage-guide.md`](./docs/usage/sandcastle-usage-guide.md).

Always consult that document when answering "how do I install / configure / run sandcastle in a consumer project". It is the canonical reference and covers:

- Mandatory install source (this fork, `biks-branch`) and forbidden alternatives
- Build caveat for git-based installs (no `dist/` from plain `npm install`) and the three workarounds (`npm pack`, `npm link`, `prepare` patch)
- A verification one-liner that fails fast if the wrong source was used
- `sandcastle init` flow and `.sandcastle/` directory layout
- Per-provider selection guide (docker, podman, apple-containers, vercel, daytona, github-codespaces, no-sandbox) with prerequisites and supported branch strategies
- Programmatic API (`run()`, `interactive()`, `createSandbox()`, `createWorktree()`) with minimum-viable examples
- Apple-containers and github-codespaces deep-dives (modes, defaults, constraints) — these providers exist only in this fork
- Prompt modes (inline, template file, built-in arguments) and prompt argument substitution rules
- Hooks lifecycle ordering
- Logging modes (log-to-file vs terminal) and the `onAgentStreamEvent` forwarder
- Workflow recipes (single issue, plan→implement→review, parallel Codespaces, mac-native)
- Troubleshooting matrix
- Versioning rule for pre-1.0 patch changesets

When the user asks anything about consuming sandcastle, read `docs/usage/sandcastle-usage-guide.md` first and base your answer on it instead of guessing from the README or older snippets.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

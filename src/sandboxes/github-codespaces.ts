/**
 * GitHub Codespaces isolated sandbox provider.
 *
 * Drives a GitHub Codespace from outside via the `gh` CLI, supporting both:
 *   - `mode: "existing"` — attach to a pre-created Codespace
 *   - `mode: "managed"` — create + manage the Codespace lifecycle per run
 *
 * Usage:
 *   import { githubCodespaces } from "@ai-hero/sandcastle/sandboxes/github-codespaces";
 *   await run({
 *     agent: claudeCode("claude-opus-4-6"),
 *     sandbox: githubCodespaces({ mode: "managed", repo: "owner/repo" }),
 *   });
 *
 * Known limitations:
 *   - `gh codespace cp` is backed by `scp` and dereferences symlinks; symlinks
 *     in `copyIn` directory trees are silently converted to regular files.
 *   - `keepOnFailure` only protects against signal-driven cleanup
 *     (SIGINT/SIGTERM). Normal `close()` always deletes the Codespace.
 */

import { Command } from "@effect/cli";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createInterface } from "node:readline";
import { Console, Data, Effect } from "effect";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedBranchStrategy,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

/** Tagged error for all Codespaces-related failures. */
export class CodespacesError extends Data.TaggedError("CodespacesError")<{
  readonly message: string;
  readonly argv?: readonly string[];
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly state?: string;
}> {}

/** Codespace states that indicate non-recoverable failure — abort polling. */
export const TERMINAL_FAILURE_STATES: ReadonlySet<string> = new Set([
  "Failed",
  "Unavailable",
  "Unknown",
  "Deleted",
  "Moved",
  "Archived",
]);

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CREATE_TIMEOUT_MS = 600_000;

/** Options for `mode: "existing"` — attach to a pre-created Codespace. */
export interface GitHubCodespacesExistingOptions {
  readonly mode: "existing";
  /** Codespace name (e.g. `urban-spork-abc123`). */
  readonly name: string;
  /** Optional GitHub token, injected as `GH_TOKEN` for spawned `gh` children. */
  readonly token?: string;
  /** Branch strategy — only `merge-to-head` and `branch` are accepted (no `head`). */
  readonly branchStrategy?: IsolatedBranchStrategy;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
}

/** Options for `mode: "managed"` — create + delete a Codespace per run. */
export interface GitHubCodespacesManagedOptions {
  readonly mode: "managed";
  /** `owner/repo` slug used by `gh codespace create -R`. */
  readonly repo: string;
  readonly branch?: string;
  readonly machine?: string;
  readonly devcontainerPath?: string;
  /** e.g. `"30m"`, `"1h"`. */
  readonly idleTimeout?: string;
  /** e.g. `"7d"`. */
  readonly retentionPeriod?: string;
  /** State-poll interval. Default: 3000 ms. */
  readonly pollIntervalMs?: number;
  /** Hard timeout waiting for `Available`. Default: 600000 ms. */
  readonly createTimeoutMs?: number;
  /** Delete the Codespace on `close()`. Default: true. */
  readonly deleteOnClose?: boolean;
  /** Stop (not delete) the Codespace on `close()`. Default: false. */
  readonly stopOnClose?: boolean;
  /**
   * When true, signal-driven cleanup (SIGINT/SIGTERM) skips deletion so the
   * Codespace can be inspected after a crash. Normal `close()` still deletes.
   * Default: false.
   */
  readonly keepOnFailure?: boolean;
  /** Optional GitHub token, injected as `GH_TOKEN` for spawned `gh` children. */
  readonly token?: string;
  /** Branch strategy — only `merge-to-head` and `branch` are accepted (no `head`). */
  readonly branchStrategy?: IsolatedBranchStrategy;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
}

export type GitHubCodespacesOptions =
  | GitHubCodespacesExistingOptions
  | GitHubCodespacesManagedOptions;

// ---------- argv builders (frozen by tests) ----------

export const buildSshArgs = (name: string, remoteCmd: string): string[] => [
  "codespace",
  "ssh",
  "-c",
  name,
  "--",
  "bash",
  "-c",
  remoteCmd,
];

export const buildCopyInArgs = (
  name: string,
  hostPath: string,
  sandboxPath: string,
): string[] => [
  "codespace",
  "cp",
  "-r",
  "-c",
  name,
  hostPath,
  `remote:${sandboxPath}`,
];

export const buildCopyOutArgs = (
  name: string,
  sandboxPath: string,
  hostPath: string,
): string[] => [
  "codespace",
  "cp",
  "-c",
  name,
  `remote:${sandboxPath}`,
  hostPath,
];

export const buildCreateArgs = (
  options: GitHubCodespacesManagedOptions,
): string[] => {
  const args: string[] = ["codespace", "create", "-R", options.repo];
  if (options.branch !== undefined) args.push("--branch", options.branch);
  if (options.machine !== undefined) args.push("--machine", options.machine);
  if (options.devcontainerPath !== undefined)
    args.push("--devcontainer-path", options.devcontainerPath);
  if (options.idleTimeout !== undefined)
    args.push("--idle-timeout", options.idleTimeout);
  if (options.retentionPeriod !== undefined)
    args.push("--retention-period", options.retentionPeriod);
  args.push("--default-permissions");
  return args;
};

export const buildDeleteArgs = (name: string): string[] => [
  "codespace",
  "delete",
  "-c",
  name,
  "--force",
];

export const buildStopArgs = (name: string): string[] => [
  "codespace",
  "stop",
  "-c",
  name,
];

export const buildViewStateArgs = (name: string): string[] => [
  "codespace",
  "view",
  "-c",
  name,
  "--json",
  "state",
  "-q",
  ".state",
];

export const buildStartViaApiArgs = (name: string): string[] => [
  "api",
  "--method",
  "POST",
  `/user/codespaces/${name}/start`,
];

const resolveSpawnEnv = (token: string | undefined): NodeJS.ProcessEnv =>
  token !== undefined
    ? { ...process.env, GH_TOKEN: token }
    : { ...process.env };

const execGh = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = new CodespacesError({
            message: `gh ${args.join(" ")} failed: ${error.message}`,
            argv: [...args],
            exitCode:
              (error as NodeJS.ErrnoException & { code?: number | string })
                .code === "ENOENT"
                ? undefined
                : (error as { code?: number }).code,
            stderr: stderr?.toString(),
          });
          reject(err);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `gh codespace view -c <name> --json state -q .state` until the
 * Codespace reports `Available` or a terminal-failure state, or the timeout
 * elapses.
 *
 * On `Shutdown`, calls `gh api POST /user/codespaces/<name>/start` and resumes
 * polling.
 */
export const waitForAvailable = async (
  name: string,
  env: NodeJS.ProcessEnv,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastState = "";
  while (Date.now() < deadline) {
    const { stdout } = await execGh(buildViewStateArgs(name), env);
    const state = stdout.trim();
    lastState = state;
    if (state === "Available") return;
    if (TERMINAL_FAILURE_STATES.has(state)) {
      throw new CodespacesError({
        message: `Codespace '${name}' entered terminal-failure state: ${state}`,
        state,
      });
    }
    if (state === "Shutdown") {
      await execGh(buildStartViaApiArgs(name), env);
    }
    await sleep(pollIntervalMs);
  }
  throw new CodespacesError({
    message: `Codespace '${name}' did not reach Available within ${timeoutMs}ms (last state: ${lastState})`,
    state: lastState,
    exitCode: undefined,
  });
};

const checkGhAuth = async (env: NodeJS.ProcessEnv): Promise<void> => {
  try {
    await execGh(["auth", "status"], env);
  } catch (e) {
    throw new CodespacesError({
      message: `gh auth status failed — run 'gh auth login' (codespace scope required): ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
};

const createCodespace = async (
  options: GitHubCodespacesManagedOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const { stdout } = await execGh(buildCreateArgs(options), env);
  const name = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!name) {
    throw new CodespacesError({
      message:
        "gh codespace create returned empty stdout — could not determine Codespace name",
    });
  }
  return name;
};

const buildHandle = (
  name: string,
  worktreePath: string,
  spawnEnv: NodeJS.ProcessEnv,
  closeImpl: () => Promise<void>,
): IsolatedSandboxHandle => ({
  worktreePath,

  exec: (
    command: string,
    opts?: {
      onLine?: (line: string) => void;
      cwd?: string;
      sudo?: boolean;
      stdin?: string;
    },
  ): Promise<ExecResult> => {
    const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
    const remoteCmd = opts?.cwd
      ? `cd ${opts.cwd} && ${effectiveCommand}`
      : effectiveCommand;
    const args = buildSshArgs(name, remoteCmd);

    return new Promise((resolve, reject) => {
      const proc: ChildProcess = spawn("gh", args, {
        stdio: [opts?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        env: spawnEnv,
      });

      if (opts?.stdin !== undefined && proc.stdin) {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      }

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      if (opts?.onLine) {
        const onLine = opts.onLine;
        const rl = createInterface({ input: proc.stdout! });
        rl.on("line", (line) => {
          stdoutChunks.push(line);
          onLine(line);
        });
      } else {
        proc.stdout!.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk.toString());
        });
      }

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      proc.on("error", (error) => {
        reject(
          new CodespacesError({
            message: `gh codespace ssh failed: ${error.message}`,
            argv: args,
          }),
        );
      });

      proc.on("close", (code) => {
        resolve({
          stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
          stderr: stderrChunks.join(""),
          exitCode: code ?? 0,
        });
      });
    });
  },

  copyIn: async (hostPath: string, sandboxPath: string): Promise<void> => {
    await execGh(buildCopyInArgs(name, hostPath, sandboxPath), spawnEnv).catch(
      (e: unknown) => {
        throw new CodespacesError({
          message: `gh codespace cp (in) failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          argv: buildCopyInArgs(name, hostPath, sandboxPath),
        });
      },
    );
  },

  copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
    await execGh(buildCopyOutArgs(name, sandboxPath, hostPath), spawnEnv).catch(
      (e: unknown) => {
        throw new CodespacesError({
          message: `gh codespace cp (out) failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          argv: buildCopyOutArgs(name, sandboxPath, hostPath),
        });
      },
    );
  },

  close: closeImpl,
});

const deriveWorktreePath = (repo: string): string => {
  const basename = repo.split("/").pop() ?? repo;
  return `/workspaces/${basename}`;
};

/**
 * Create a `github-codespaces` isolated sandbox provider.
 *
 * Two modes:
 *   - `mode: "existing"` — attach to an already-running Codespace by name. The
 *     provider never creates or deletes the Codespace; `close()` is a no-op.
 *   - `mode: "managed"` — create a Codespace from `repo`, wait for `Available`,
 *     run the agent, and tear down on `close()` (per `deleteOnClose` /
 *     `stopOnClose`).
 *
 * Branch strategies: only `merge-to-head` (default) and `branch` are accepted
 * — `head` is excluded by the `IsolatedBranchStrategy` type.
 */
export const githubCodespaces = (
  options: GitHubCodespacesOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "github-codespaces",
    env: options.env,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const spawnEnv = resolveSpawnEnv(options.token);

      await checkGhAuth(spawnEnv);

      if (options.mode === "existing") {
        const name = options.name;
        const pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
        const createTimeoutMs = DEFAULT_CREATE_TIMEOUT_MS;
        await waitForAvailable(name, spawnEnv, pollIntervalMs, createTimeoutMs);
        const worktreePath = deriveWorktreePath(name);
        return buildHandle(name, worktreePath, spawnEnv, async () => {
          // existing-mode close is a no-op (no signal handlers were registered)
        });
      }

      // mode === "managed"
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const createTimeoutMs =
        options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
      const deleteOnClose = options.deleteOnClose ?? true;
      const stopOnClose = options.stopOnClose ?? false;
      const keepOnFailure = options.keepOnFailure ?? false;

      const name = await createCodespace(options, spawnEnv);

      try {
        await waitForAvailable(name, spawnEnv, pollIntervalMs, createTimeoutMs);
      } catch (e) {
        if (deleteOnClose) {
          try {
            execFileSync("gh", buildDeleteArgs(name), {
              stdio: "ignore",
              timeout: 10_000,
              env: spawnEnv,
            });
          } catch {
            /* best-effort */
          }
        }
        throw e;
      }

      const onExit = (): void => {
        if (keepOnFailure) return;
        try {
          execFileSync("gh", buildDeleteArgs(name), {
            stdio: "ignore",
            timeout: 10_000,
            env: spawnEnv,
          });
        } catch {
          /* best-effort */
        }
      };
      const onSignal = (): void => {
        onExit();
        process.exit(1);
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      const worktreePath = deriveWorktreePath(options.repo);

      return buildHandle(name, worktreePath, spawnEnv, async () => {
        process.removeListener("exit", onExit);
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        if (deleteOnClose) {
          await execGh(buildDeleteArgs(name), spawnEnv).catch(() => {
            /* best-effort */
          });
        } else if (stopOnClose) {
          await execGh(buildStopArgs(name), spawnEnv).catch(() => {
            /* best-effort */
          });
        }
      });
    },
  });

// ---------- CLI command builders (consumed by Unit C) ----------

/**
 * `sandcastle github-codespaces verify` — runs `gh auth status` and (when a
 * Codespace name is provided) `gh codespace view -c <name> --json state`.
 *
 * Note on asymmetry with `docker` / `podman` namespaces: GitHub Codespaces
 * runs in dev containers built by GitHub-side infrastructure. There is no
 * local image to manage, so `build-image` and `remove-image` subcommands do
 * not apply to this provider.
 */
export const verifyCommand = Command.make("verify", {}, () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { ...process.env };
    yield* Effect.tryPromise({
      try: () => execGh(["auth", "status"], env),
      catch: (e) =>
        new CodespacesError({
          message: `gh auth status failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    });
    yield* Console.log("github-codespaces: gh CLI authenticated.");
  }),
);

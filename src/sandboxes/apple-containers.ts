/**
 * Apple Containers sandbox provider — drives Apple's native `container` CLI
 * on Apple-Silicon macOS hosts via bind-mounts. Mirrors the docker/podman shape.
 *
 * Usage:
 *   import { appleContainers } from "@ai-hero/sandcastle/sandboxes/apple-containers";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: appleContainers() });
 */

import { Command, Options } from "@effect/cli";
import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { platform as osPlatform, arch as osArch } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Data, Effect } from "effect";
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import {
  defaultImageName as defaultRepoImageName,
  resolveUserMounts,
} from "../mountUtils.js";

export class AppleContainerError extends Data.TaggedError(
  "AppleContainerError",
)<{
  readonly message: string;
  readonly argv?: readonly string[];
  readonly exitCode?: number;
  readonly stderr?: string;
}> {}

export interface AppleContainersOptions {
  /** Apple `container` image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /**
   * `container` network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   *
   * When omitted, the default `container` network is used.
   */
  readonly network?: string | readonly string[];
  /** UID to run the container as (default: host UID, falling back to 1000). */
  readonly containerUid?: number;
  /** GID to run the container as (default: host GID, falling back to 1000). */
  readonly containerGid?: number;
}

export const defaultImageName = defaultRepoImageName;

const SANDBOX_HOMEDIR = "/home/agent";
const APPLE_CONTAINER_INSTALL_URL = "https://github.com/apple/container";

interface BuildRunArgsInput {
  readonly containerName: string;
  readonly imageName: string;
  readonly hostWorktreePath: string;
  readonly sandboxWorktreePath: string;
  readonly uid: number;
  readonly gid: number;
  readonly mounts: ReadonlyArray<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }>;
  readonly env: Record<string, string>;
  readonly network?: string | readonly string[];
}

export const buildRunArgs = (input: BuildRunArgsInput): string[] => {
  const args: string[] = [
    "run",
    "-d",
    "--rm",
    "--name",
    input.containerName,
    "-w",
    input.sandboxWorktreePath,
    "-u",
    `${input.uid}:${input.gid}`,
  ];

  for (const m of input.mounts) {
    const value = m.readonly
      ? `${m.hostPath}:${m.sandboxPath}:ro`
      : `${m.hostPath}:${m.sandboxPath}`;
    args.push("-v", value);
  }

  for (const [k, v] of Object.entries(input.env)) {
    args.push("-e", `${k}=${v}`);
  }

  const networks = input.network
    ? Array.isArray(input.network)
      ? input.network
      : [input.network]
    : [];
  for (const n of networks) {
    args.push("--network", n);
  }

  args.push(input.imageName, "sleep", "infinity");
  return args;
};

const checkApplePlatform = (): void => {
  const p = osPlatform();
  const a = osArch();
  if (p !== "darwin" || a !== "arm64") {
    throw new AppleContainerError({
      message: `apple-containers provider requires macOS on Apple Silicon (darwin/arm64); got ${p}/${a}.`,
    });
  }
};

const checkContainerCli = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("container", ["--version"], (error) => {
      if (error) {
        reject(
          new AppleContainerError({
            message: `Apple 'container' CLI not found on PATH. Install it from ${APPLE_CONTAINER_INSTALL_URL}.`,
          }),
        );
      } else {
        resolve();
      }
    });
  });

const checkContainerSystem = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("container", ["system", "status"], (error, _stdout, stderr) => {
      if (error) {
        reject(
          new AppleContainerError({
            message: `Apple 'container' system is not running. Run 'container system start' first.`,
            stderr: stderr?.toString(),
          }),
        );
      } else {
        resolve();
      }
    });
  });

const checkContainerImageExists = (imageName: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("container", ["image", "inspect", imageName], (error) => {
      if (error) {
        reject(
          new AppleContainerError({
            message: `Image '${imageName}' not found locally. Run \`sandcastle apple-containers build-image\` first.`,
          }),
        );
      } else {
        resolve();
      }
    });
  });

const startContainer = (args: string[]): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("container", args, (error, _stdout, stderr) => {
      if (error) {
        reject(
          new AppleContainerError({
            message: `container run failed: ${stderr?.toString() || error.message}`,
            argv: args,
            stderr: stderr?.toString(),
          }),
        );
      } else {
        resolve();
      }
    });
  });

export const appleContainers = (
  options?: AppleContainersOptions,
): BindMountSandboxProvider => {
  const configuredImageName = options?.imageName;
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, SANDBOX_HOMEDIR)
    : [];
  const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
  const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;

  return createBindMountSandboxProvider({
    name: "apple-containers",
    env: options?.env,
    sandboxHomedir: SANDBOX_HOMEDIR,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const sandboxWorktreePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? `${SANDBOX_HOMEDIR}/workspace`;

      const allMounts = [...createOptions.mounts, ...userMounts];

      const imageName =
        configuredImageName ?? defaultRepoImageName(createOptions.hostRepoPath);

      checkApplePlatform();
      await checkContainerCli();
      await checkContainerSystem();
      await checkContainerImageExists(imageName);

      const env = { ...createOptions.env, HOME: SANDBOX_HOMEDIR };

      const runArgs = buildRunArgs({
        containerName,
        imageName,
        hostWorktreePath: createOptions.worktreePath,
        sandboxWorktreePath,
        uid: containerUid,
        gid: containerGid,
        mounts: allMounts,
        env,
        network: options?.network,
      });

      await startContainer(runArgs);

      const onExit = () => {
        try {
          execFileSync("container", ["delete", "-f", containerName], {
            stdio: "ignore",
            timeout: 5000,
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

      const handle: BindMountSandboxHandle = {
        worktreePath: sandboxWorktreePath,

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
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "bash", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("container", args, {
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
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
              reject(new Error(`container exec failed: ${error.message}`));
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

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> =>
          new Promise((resolve, reject) => {
            const containerArgs = ["exec"];
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              containerArgs.push("-it");
            } else {
              containerArgs.push("-i");
            }
            if (opts.cwd) containerArgs.push("-w", opts.cwd);
            containerArgs.push(containerName, ...args);

            const proc = spawn("container", containerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`container exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          }),

        copyFileIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const hostTarget = mapSandboxPathToHost(
            sandboxPath,
            sandboxWorktreePath,
            createOptions.worktreePath,
            allMounts,
          );
          await mkdir(dirname(hostTarget), { recursive: true });
          await copyFile(hostPath, hostTarget);
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const hostSource = mapSandboxPathToHost(
            sandboxPath,
            sandboxWorktreePath,
            createOptions.worktreePath,
            allMounts,
          );
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(hostSource, hostPath);
        },

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await new Promise<void>((resolve, reject) => {
            execFile(
              "container",
              ["delete", "-f", containerName],
              (error, _stdout, stderr) => {
                if (error) {
                  reject(
                    new AppleContainerError({
                      message: `container delete failed: ${stderr?.toString() || error.message}`,
                    }),
                  );
                } else {
                  resolve();
                }
              },
            );
          });
        },
      };

      return handle;
    },
  });
};

const mapSandboxPathToHost = (
  sandboxPath: string,
  sandboxWorktreePath: string,
  hostWorktreePath: string,
  mounts: ReadonlyArray<{ hostPath: string; sandboxPath: string }>,
): string => {
  for (const m of mounts) {
    if (sandboxPath === m.sandboxPath) return m.hostPath;
    const prefix = m.sandboxPath.endsWith("/")
      ? m.sandboxPath
      : `${m.sandboxPath}/`;
    if (sandboxPath.startsWith(prefix)) {
      const suffix = sandboxPath.slice(m.sandboxPath.length);
      return `${m.hostPath}${suffix}`;
    }
  }
  if (sandboxPath === sandboxWorktreePath) return hostWorktreePath;
  const wtPrefix = sandboxWorktreePath.endsWith("/")
    ? sandboxWorktreePath
    : `${sandboxWorktreePath}/`;
  if (sandboxPath.startsWith(wtPrefix)) {
    return `${hostWorktreePath}${sandboxPath.slice(sandboxWorktreePath.length)}`;
  }
  throw new AppleContainerError({
    message: `copy: sandbox path '${sandboxPath}' is outside any bind-mount. Add a host mount for the directory or use a path under '${sandboxWorktreePath}'.`,
  });
};

const containerExec = (
  args: string[],
): Effect.Effect<string, AppleContainerError> =>
  Effect.async((resume) => {
    execFile(
      "container",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new AppleContainerError({
                message: `container ${args[0]} failed: ${stderr?.toString() || error.message}`,
                argv: args,
                stderr: stderr?.toString(),
              }),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

/**
 * Build the sandcastle Apple container image.
 *
 * When `dockerfile` is provided, runs
 * `container images build -t <name> -f <dockerfile> <cwd>` so COPY instructions
 * resolve relative to the current working directory. Otherwise, runs
 * `container images build -t <name> <contextDir>`.
 */
export const buildImage = (
  imageName: string,
  contextDir: string,
  options?: { readonly dockerfile?: string },
): Effect.Effect<void, AppleContainerError> =>
  Effect.gen(function* () {
    if (options?.dockerfile) {
      yield* containerExec([
        "images",
        "build",
        "-t",
        imageName,
        "-f",
        options.dockerfile,
        process.cwd(),
      ]);
    } else {
      yield* containerExec(["images", "build", "-t", imageName, contextDir]);
    }
  });

/**
 * Remove an Apple container image.
 */
export const removeImage = (
  imageName: string,
): Effect.Effect<void, AppleContainerError> =>
  Effect.gen(function* () {
    yield* containerExec(["images", "delete", imageName]);
  });

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Apple container image name"),
  Options.optional,
);

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

export const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
      const resolvedImageName =
        imageNameFlag._tag === "Some"
          ? imageNameFlag.value
          : defaultRepoImageName(cwd);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;
      yield* buildImage(resolvedImageName, cwd, {
        dockerfile: dockerfilePath,
      });
    }),
);

export const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
      const resolvedImageName =
        imageNameFlag._tag === "Some"
          ? imageNameFlag.value
          : defaultRepoImageName(cwd);
      yield* removeImage(resolvedImageName);
    }),
);

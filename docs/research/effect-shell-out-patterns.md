# Effect.ts Shell-Out Patterns — Long-Lived Child Processes with Streaming I/O

**Research topic**: How `@ai-hero/sandcastle` shells out to external CLIs today, and the
correct patterns for the two new providers (`apple-containers` and `github-codespaces`).

**Project versions pinned**:

- `effect`: `^3.20.0`
- `@effect/platform`: `^0.95.0`
- `@effect/platform-node`: `^0.105.0`

---

## Overview

Sandcastle mixes two execution contexts that must never be confused:

| Context                                         | Where code runs                                           | Effect boundary                                        |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| **Lifecycle / infrastructure**                  | Inside an Effect pipeline, called via `Effect.runPromise` | Uses `Effect.gen`, `Effect.async`, `Effect.tryPromise` |
| **Handle methods** (`exec`, `copyFileIn`, etc.) | Inside a plain `async` function returned by `create()`    | Pure Promise — no Effect primitives inside             |

The existing providers (`docker.ts`, `podman.ts`, `no-sandbox.ts`) all follow this split.
Understanding it is the single most important insight for new provider authors.

---

## Part 1 — The Project's Existing Pattern

### 1.1 The Architectural Seam

`docker.ts` and `podman.ts` both follow the same structure:

```
docker() / podman()
  └── createBindMountSandboxProvider({ create: async (...) => handle })
        │
        ├── LIFECYCLE: Effect.runPromise(startContainer(...))   ← Effect context
        │
        └── HANDLE METHODS: new Promise((resolve, reject) => { ... })  ← Promise context
              exec()         ← spawn() wrapped in plain Promise
              interactiveExec()  ← spawn() wrapped in plain Promise
              copyFileIn()   ← execFile() wrapped in plain Promise
              copyFileOut()  ← execFile() wrapped in plain Promise
              close()        ← Effect.runPromise(removeContainer(...))  ← back to Effect
```

The key rule: **the `create()` function itself is `async`; everything inside
`create()` is plain Promise or callback code, except for lifecycle operations
(start / stop container) which are `await Effect.runPromise(someEffect)`.**

For `close()`, docker delegates back to Effect (`await Effect.runPromise(removeContainer(...))`),
while podman wraps `execFile` in a plain Promise directly. Both approaches are acceptable —
the important constraint is that the returned `handle` object's methods are all `Promise`-returning
functions, never Effect-returning functions, because `SandboxProvider.ts` types them as
`(...) => Promise<...>`.

### 1.2 `DockerLifecycle.ts` — the Effect layer

`src/DockerLifecycle.ts` is the only file that uses Effect internally for the subprocess
machinery. It defines a private `dockerExec` helper built on `Effect.async`:

```typescript
const dockerExec = (args: string[]): Effect.Effect<string, DockerError> =>
  Effect.async((resume) => {
    execFile(
      "docker",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(Effect.fail(new DockerError({ message: `...` })));
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });
```

This is the **canonical Effect wrapping for a one-shot `execFile` call**:

- `Effect.async` receives a `resume` callback.
- The Node.js callback fires `resume(Effect.succeed(...))` on success or
  `resume(Effect.fail(...))` on error.
- No cleanup is needed (the process is already done by the time the callback fires).
- Errors become typed `DockerError` values — never thrown.

`startContainer` and `removeContainer` are then `Effect.gen` pipelines that sequence
multiple `dockerExec` calls with `yield*`.

### 1.3 `exec` — streaming stdout with stdin piping (the core pattern)

All four local providers (`docker`, `podman`, `no-sandbox`, and the Vercel pattern for
reference) implement `exec` as a `new Promise(...)` wrapping `child_process.spawn`. The
canonical form, extracted from `docker.ts` lines 133–193 and confirmed identical in
`podman.ts` and `no-sandbox.ts`, is:

```typescript
exec: (command, opts): Promise<ExecResult> => {
  // 1. Build argv
  const args = ["exec"];
  if (opts?.stdin !== undefined) args.push("-i");   // stdin pipe requires -i
  if (opts?.cwd) args.push("-w", opts.cwd);
  args.push(containerName, "sh", "-c", effectiveCommand);

  return new Promise((resolve, reject) => {
    // 2. Spawn with appropriate stdio
    const proc = spawn("docker", args, {
      stdio: [
        opts?.stdin !== undefined ? "pipe" : "ignore",  // stdin
        "pipe",                                          // stdout (always piped for streaming)
        "pipe",                                          // stderr (always piped for collection)
      ],
    });

    // 3. Pipe stdin if provided
    if (opts?.stdin !== undefined) {
      proc.stdin!.write(opts.stdin);
      proc.stdin!.end();     // MUST close stdin so the child process sees EOF
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    // 4a. Streaming path: use readline to fire onLine per newline
    if (opts?.onLine) {
      const onLine = opts.onLine;
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutChunks.push(line);   // collect for ExecResult.stdout
        onLine(line);              // deliver live to caller
      });
    } else {
      // 4b. Buffered path: collect raw chunks
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });
    }

    // 5. Collect stderr (always buffered)
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // 6. Process error (ENOENT, permission denied, etc.)
    proc.on("error", (error) => {
      reject(new Error(`docker exec failed: ${error.message}`));
    });

    // 7. Resolve on close with ExecResult
    proc.on("close", (code) => {
      resolve({
        stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,    // null (killed by signal) maps to 0 — see Pitfalls §3.2
      });
    });
  });
},
```

Key observations:

- **`readline.createInterface`** is used for line-streaming (not a manual split-on-newline).
  It handles partial chunks correctly, buffers across chunk boundaries, and strips `\r`.
- **Stdout is always collected** into `stdoutChunks` even in the `onLine` path, so
  `ExecResult.stdout` is available to the caller.
- In the `onLine` path, chunks are joined with `"\n"` (since `rl` strips newlines); in the
  buffered path, chunks are joined with `""` (raw bytes, may include newlines).
- `exitCode: code ?? 0` — the `close` event provides `null` when the process was killed
  by a signal. The current code maps that to `0`, which is a known limitation (see §3.2).

### 1.4 `interactiveExec` — TTY detection and inherited stdio

```typescript
interactiveExec: (args, opts): Promise<{ exitCode: number }> => {
  return new Promise((resolve, reject) => {
    const dockerArgs = ["exec"];
    // TTY detection: allocate -it when stdin is a TTY
    if ("isTTY" in opts.stdin && (opts.stdin as { isTTY?: boolean }).isTTY) {
      dockerArgs.push("-it");
    } else {
      dockerArgs.push("-i");
    }
    if (opts.cwd) dockerArgs.push("-w", opts.cwd);
    dockerArgs.push(containerName, ...args);

    const proc = spawn("docker", dockerArgs, {
      stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
      // stdio is wired to the caller-provided streams — not "pipe"
    });

    proc.on("error", reject);
    proc.on("close", (code) => resolve({ exitCode: code ?? 0 }));
  });
},
```

The pattern for interactive exec: pass the streams from `InteractiveExecOptions` directly
to `spawn`'s `stdio` option. This delegates I/O fully to the caller.

### 1.5 `copyFileIn` / `copyFileOut` — `execFile` in a Promise

```typescript
copyFileIn: (hostPath, sandboxPath): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("docker", ["cp", hostPath, `${containerName}:${sandboxPath}`], (error) => {
      if (error) reject(new Error(`docker cp (in) failed: ${error.message}`));
      else resolve();
    });
  }),
```

`execFile` (not `spawn`) is used here because `cp` is a one-shot command with no streaming
requirement and `execFile` has a simpler callback API.

### 1.6 Signal handlers for cleanup

Both `docker.ts` and `podman.ts` register process-level handlers immediately after the
container starts:

```typescript
const onExit = () => {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
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

And they are removed in `close()`:

```typescript
process.removeListener("exit", onExit);
process.removeListener("SIGINT", onSignal);
process.removeListener("SIGTERM", onSignal);
```

`execFileSync` (synchronous) is used deliberately in the `"exit"` handler because async
operations are not guaranteed to complete in the `process.on("exit")` callback — by that
point the event loop is draining.

**Important**: `vercel.ts` and `daytona.ts` do NOT register these handlers. The investigation
document notes this as a gap for `github-codespaces` (where a leaked managed Codespace incurs
cost). New providers must follow the `docker.ts` pattern.

### 1.7 Vercel's `onLine` streaming via a `Writable`

`vercel.ts` cannot use `readline` (it does not have a raw child process) so it uses a
`Writable` stream with a partial-line buffer. This pattern is the correct approach when
wrapping an SDK that exposes a `Writable` target rather than a raw `ReadableStream`:

```typescript
let partial = "";
const stdoutWritable = new Writable({
  write(chunk, _encoding, callback) {
    const text = partial + chunk.toString();
    const lines = text.split("\n");
    partial = lines.pop() ?? ""; // last fragment may be incomplete
    for (const line of lines) {
      stdoutLines.push(line);
      onLine(line);
    }
    callback();
  },
  final(callback) {
    if (partial) {
      // flush the last line on stream end
      stdoutLines.push(partial);
      onLine(partial);
      partial = "";
    }
    callback();
  },
});
```

The `final` hook ensures the last line (if it has no trailing `\n`) is delivered. The
`readline` approach used by `docker.ts` handles this automatically.

### 1.8 `syncOut.ts` — Effect wrapping around Promise handle methods

`syncOut.ts` is the orchestrator that calls handle methods inside an Effect pipeline.
The bridge pattern it uses is `Effect.tryPromise`:

```typescript
const execOk = (handle, command, options): Effect.Effect<..., SyncError> =>
  Effect.tryPromise({
    try: () => handle.exec(command, options),   // returns Promise<ExecResult>
    catch: (e) => new SyncError({ message: `...` }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(new SyncError({ ... }))
        : Effect.succeed(result),
    ),
  );
```

This is the standard recipe for lifting a `Promise<T>` into `Effect<T, E>`:
`Effect.tryPromise({ try: () => promiseFn(), catch: (e) => new TypedError(...) })`.

---

## Part 2 — `@effect/platform` `Command` API (the library approach)

The project does **not** use `@effect/platform`'s `Command` module in its providers — it
uses `node:child_process` directly. The following documents the library API for completeness
and explains why the direct approach is preferred here.

### 2.1 Core API (`@effect/platform` `^0.95.x`)

```typescript
import { Command } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Stream, String } from "effect";

// 1. Declare a command
const cmd = Command.make("ls", "-al");

// 2a. Run to completion and collect string output
const result = yield * Command.string(cmd); // Effect<string, PlatformError, CommandExecutor>

// 2b. Run and get lines as a Stream
const lines = Command.lines(cmd); // Stream<string, PlatformError, CommandExecutor>

// 2c. Start and access process handle (streaming stdout/stderr + exitCode)
const process = yield * Command.start(cmd); // needs Effect.scoped
const [exitCode, stdout, stderr] =
  yield *
  Effect.all(
    [
      process.exitCode,
      Stream.decodeText()(process.stdout).pipe(Stream.runCollect),
      Stream.decodeText()(process.stderr).pipe(Stream.runCollect),
    ],
    { concurrency: 3 },
  );

// 3. Provide the node executor layer
Effect.scoped(program).pipe(Effect.provide(NodeContext.layer));
```

Key notes:

- `Command.start` returns a scoped resource (the process) — it must be inside
  `Effect.scoped` or `Effect.acquireUseRelease`.
- `stdout` and `stderr` are `Stream<Uint8Array, PlatformError, never>` — use
  `Stream.decodeText()` to get strings.
- `process.exitCode` is an `Effect<ExitCode, PlatformError>` that waits for the process
  to finish.
- Setting stdin: `Command.stdin(cmd, Stream.fromIterable([Uint8Array.from(Buffer.from("my input"))]))`.
- Setting env: `Command.env(cmd, { MY_VAR: "value" })`.
- Setting cwd: `Command.workingDirectory(cmd, "/some/path")`.
- The `CommandExecutor` service is automatically satisfied by `NodeContext.layer`.

### 2.2 Why the project uses raw `node:child_process` instead

The existing providers predate the current `@effect/platform` API and were written to avoid
requiring the `NodeContext.layer` at call sites inside `create()`. Using `Command.start`
would require either:

1. Threading a `CommandExecutor` dependency through every `handle.exec` call (which would
   change the `SandboxProvider` interface from `Promise`-based to Effect-based), or
2. Calling `Effect.runPromise(Command.start(cmd).pipe(Effect.provide(NodeContext.layer)))`
   inside each `exec` call — which works but adds overhead per call.

For the new providers, **continuing to use `child_process.spawn` directly is the right
choice**. It keeps the handle methods pure Promise, avoids adding `NodeContext.layer`
as a concern inside provider files, and directly mirrors the existing providers that
the tests are already written against.

---

## Part 3 — Patterns for the New Providers

### 3.1 `apple-containers` provider (bind-mount, mirrors `docker.ts`)

The `apple-containers` provider replaces `docker` with `container` in argv construction
but is otherwise identical in structure. Copy the `exec` block from `docker.ts` and
change:

1. `spawn("docker", args, ...)` → `spawn("container", args, ...)`
2. `execFile("docker", ["cp", ...], ...)` → not needed (bind-mount: use host filesystem)
3. `execFileSync("docker", ["rm", "-f", containerName], ...)` → `execFileSync("container", ["delete", "-f", containerName], ...)`
4. `Effect.runPromise(startContainer(...))` → inline `execFile` Promise (no `DockerLifecycle` equivalent exists for `container`)
5. `Effect.runPromise(removeContainer(...))` → inline `execFile` Promise in `close()`

Pre-flight checks belong in `create()` before the container starts, wrapped as plain
`Promise`-returning helpers (same as `checkPodmanMachine` and `checkImageExists` in
`podman.ts`).

Template for the `apple-containers` pre-flight:

```typescript
// In create():
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    "apple-containers provider requires an Apple Silicon Mac (darwin/arm64).",
  );
}
await checkContainerCli(); // execFile("container", ["--version"], ...)
await checkContainerSystem(); // execFile("container", ["system", "status", "--format", "json"], ...)
await checkContainerImageExists(imageName); // execFile("container", ["image", "inspect", imageName], ...)
```

Each helper follows the `checkImageExists` pattern from `podman.ts`:

```typescript
const checkContainerCli = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    execFile("container", ["--version"], (error) => {
      if (error?.code === "ENOENT") {
        reject(
          new Error(
            "Apple 'container' CLI not found. Install from https://github.com/apple/container",
          ),
        );
      } else if (error) {
        reject(new Error(`container --version failed: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
```

The `exec` method for `apple-containers` (identical structure to `docker.ts`):

```typescript
exec: (command, opts): Promise<ExecResult> => {
  const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
  const args = ["exec"];
  if (opts?.stdin !== undefined) args.push("-i");
  if (opts?.cwd) args.push("-w", opts.cwd);
  args.push(containerName, "bash", "-c", effectiveCommand);  // bash, not sh

  return new Promise((resolve, reject) => {
    const proc = spawn("container", args, {
      stdio: [opts?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
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
      rl.on("line", (line) => { stdoutChunks.push(line); onLine(line); });
    } else {
      proc.stdout!.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk.toString()); });
    }

    proc.stderr!.on("data", (chunk: Buffer) => { stderrChunks.push(chunk.toString()); });
    proc.on("error", (error) => reject(new Error(`container exec failed: ${error.message}`)));
    proc.on("close", (code) => resolve({
      stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
      stderr: stderrChunks.join(""),
      exitCode: code ?? 0,
    }));
  });
},
```

`copyFileIn` / `copyFileOut` for `apple-containers` (bind-mount: host filesystem only):

```typescript
// Since the worktree is bind-mounted, file I/O goes directly through the host filesystem.
// Import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises"

copyFileIn: async (hostPath: string, sandboxPath: string): Promise<void> => {
  // sandboxPath is inside the bind-mount — it IS the host path
  await mkdir(dirname(sandboxPath), { recursive: true });
  await copyFile(hostPath, sandboxPath);
},

copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
  await mkdir(dirname(hostPath), { recursive: true });
  await copyFile(sandboxPath, hostPath);
},
```

### 3.2 `github-codespaces` provider (isolated, mirrors spawn pattern)

The `github-codespaces` provider uses `gh codespace ssh -c <name> -- bash -c <cmd>`
as the exec transport. The key difference from `docker exec` is that `gh codespace ssh`
is itself a child process — the `exec` implementation is structurally identical.

Template for `github-codespaces` `exec`:

```typescript
exec: (command, opts): Promise<ExecResult> => {
  const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
  // Wrap in cd+command so cwd is honoured on the remote
  const remoteCmd = opts?.cwd
    ? `cd ${opts.cwd} && ${effectiveCommand}`
    : effectiveCommand;

  const args = ["codespace", "ssh", "-c", codespaceName, "--"];
  args.push("bash", "-c", remoteCmd);

  return new Promise((resolve, reject) => {
    const spawnEnv = options?.token
      ? { ...process.env, GH_TOKEN: options.token }
      : process.env;

    const proc = spawn("gh", args, {
      stdio: [opts?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: spawnEnv,
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
      rl.on("line", (line) => { stdoutChunks.push(line); onLine(line); });
    } else {
      proc.stdout!.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk.toString()); });
    }

    proc.stderr!.on("data", (chunk: Buffer) => { stderrChunks.push(chunk.toString()); });
    proc.on("error", (error) => reject(new Error(`gh codespace ssh failed: ${error.message}`)));
    proc.on("close", (code) => resolve({
      stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
      stderr: stderrChunks.join(""),
      exitCode: code ?? 0,
    }));
  });
},
```

For `copyIn` and `copyFileOut` using `gh codespace cp`:

```typescript
copyIn: (hostPath, sandboxPath): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = ["codespace", "cp", "-r", "-c", codespaceName, hostPath, `remote:${sandboxPath}`];
    execFile("gh", args, { env: spawnEnv }, (error) => {
      if (error) reject(new Error(`gh codespace cp (in) failed: ${error.message}`));
      else resolve();
    });
  }),

copyFileOut: (sandboxPath, hostPath): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = ["codespace", "cp", "-c", codespaceName, `remote:${sandboxPath}`, hostPath];
    execFile("gh", args, { env: spawnEnv }, (error) => {
      if (error) reject(new Error(`gh codespace cp (out) failed: ${error.message}`));
      else resolve();
    });
  }),
```

For the managed-mode `close()` with signal handler registration:

```typescript
// In create(), after the codespace is confirmed Available:
const onExit = () => {
  try {
    execFileSync(
      "gh",
      ["codespace", "delete", "-c", codespaceName, "--force"],
      { stdio: "ignore", timeout: 10_000, env: spawnEnv },
    );
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

// In handle.close():
process.removeListener("exit", onExit);
process.removeListener("SIGINT", onSignal);
process.removeListener("SIGTERM", onSignal);
if (mode === "managed") {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "gh",
      ["codespace", "delete", "-c", codespaceName, "--force"],
      { env: spawnEnv },
      (error) => {
        if (error)
          reject(new Error(`gh codespace delete failed: ${error.message}`));
        else resolve();
      },
    );
  });
}
```

For polling `gh codespace view` until `Available`:

```typescript
const waitForAvailable = (
  codespaceName: string,
  spawnEnv: NodeJS.ProcessEnv,
  timeoutMs = 600_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const poll = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      execFile(
        "gh",
        [
          "codespace",
          "view",
          "-c",
          codespaceName,
          "--json",
          "state",
          "-q",
          ".state",
        ],
        { env: spawnEnv },
        (error, stdout) => {
          if (error) {
            reject(new Error(`gh codespace view failed: ${error.message}`));
            return;
          }
          const state = stdout.toString().trim();
          if (state === "Available") {
            resolve();
            return;
          }
          if (state === "Failed" || state === "Unavailable") {
            reject(new Error(`Codespace entered terminal state: ${state}`));
            return;
          }
          if (Date.now() >= deadline) {
            reject(
              new Error(
                `Codespace did not reach Available within ${timeoutMs}ms (last state: ${state})`,
              ),
            );
            return;
          }
          setTimeout(() => poll().then(resolve, reject), 5_000);
        },
      );
    });
  return poll();
};
```

---

## Part 4 — `Effect.async` for One-Shot Shell Calls (the Effect-native approach)

When implementing pre-flight helpers that belong inside Effect pipelines (like
`DockerLifecycle.ts`'s `dockerExec`), use `Effect.async`:

```typescript
// Pattern: wrap execFile in Effect.async with typed error
const execFileEffect = <E>(
  cmd: string,
  args: string[],
  onError: (error: Error) => E,
): Effect.Effect<string, E> =>
  Effect.async((resume) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              onError(new Error(stderr?.toString() || error.message)),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
    // Optional: return cleanup Effect for interruption
    // return Effect.sync(() => { /* kill process if needed */ });
  });
```

**Interruption support** — `Effect.async` accepts a second parameter `signal: AbortSignal`
that fires when the fiber is interrupted. For a child process:

```typescript
const spawnEffect = (cmd: string, args: string[]): Effect.Effect<void, Error> =>
  Effect.async<void, Error>((resume, signal) => {
    const proc = spawn(cmd, args);
    signal.addEventListener("abort", () => proc.kill("SIGTERM"));
    proc.on("close", (code) => {
      if (code === 0) resume(Effect.void);
      else resume(Effect.fail(new Error(`${cmd} exited with ${code}`)));
    });
    proc.on("error", (err) => resume(Effect.fail(err)));
  });
```

However, the project currently does **not** use this pattern in providers — it is only
present in `DockerLifecycle.ts` without the `signal` parameter (because lifecycle
operations are not expected to be interrupted).

---

## Part 5 — Error Handling Patterns

### 5.1 Inside handle methods (Promise context)

All existing providers reject with a plain `Error` on process/spawn failures:

```typescript
proc.on("error", (error) =>
  reject(new Error(`docker exec failed: ${error.message}`)),
);
```

Non-zero exit codes are **not** rejected — they are resolved with `exitCode` in the
`ExecResult`. It is the caller's responsibility to check `exitCode`. See `syncOut.ts`'s
`execOk` helper for the standard caller-side pattern.

### 5.2 Inside Effect pipelines (Effect context)

`syncOut.ts` bridges Promise-based handle methods into Effect using `Effect.tryPromise`:

```typescript
Effect.tryPromise({
  try: () => handle.exec(command, options),
  catch: (e) => new SyncError({ message: `Sandbox exec failed: ...` }),
});
```

`Effect.tryPromise` catches both rejected Promises and thrown exceptions, mapping them
to the typed error. This is the correct bridge — not `Effect.promise` (which does not
model failures) and not `Effect.async` (which is for callback-based APIs).

### 5.3 Error class conventions

New providers should define a typed `Data.TaggedError` class following `errors.ts`:

```typescript
import { Data } from "effect";

export class AppleContainerError extends Data.TaggedError(
  "AppleContainerError",
)<{
  readonly message: string;
}> {}

export class CodespacesError extends Data.TaggedError("CodespacesError")<{
  readonly message: string;
}> {}
```

These should be added to `errors.ts`'s `SandboxError` union, not defined locally in the
provider file, to keep the error surface unified.

---

## Part 6 — Testing Patterns (vitest)

### 6.1 The `docker.test.ts` mock pattern

`docker.test.ts` mocks the entire `node:child_process` module at the top of the file:

```typescript
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual, // keep real implementations (so readline etc. still work)
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});
```

The mock is reset between tests with `afterEach(() => { mockExecFile.mockReset(); })`.

Tests that call `provider.create(...)` must mock `execFile` (used by DockerLifecycle's
`dockerExec`) to return success for the container startup calls:

```typescript
mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
  const callback = rest[rest.length - 1];
  callback(null, "", ""); // success with empty stdout/stderr
  return undefined as any;
});
```

### 6.2 Mock pattern for `spawn`-based `exec` tests

For testing `exec` directly, you need a mock spawn that emits events. The pattern is to
return a fake `ChildProcess`-like object:

```typescript
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

it("exec streams onLine correctly", async () => {
  const fakeProc = new EventEmitter() as any;
  fakeProc.stdout = new EventEmitter();
  fakeProc.stderr = new EventEmitter();
  fakeProc.stdin = { write: vi.fn(), end: vi.fn() };

  mockSpawn.mockReturnValueOnce(fakeProc);

  const lines: string[] = [];
  const execPromise = handle.exec("echo hello", {
    onLine: (l) => lines.push(l),
  });

  // Simulate output from the child process
  fakeProc.stdout.emit("data", Buffer.from("line1\nline2\n"));
  fakeProc.emit("close", 0);

  const result = await execPromise;
  expect(lines).toEqual(["line1", "line2"]);
  expect(result.exitCode).toBe(0);
});
```

Note: because `readline.createInterface` is used (not a raw `.on("data")` listener in the
`onLine` path), the stdout mock must be an `EventEmitter` with a `.pipe`-compatible interface,
or you can use the buffered path (no `onLine`) for simpler assertion tests.

### 6.3 Testing argv construction

The most reliable approach (used by `docker.test.ts` for `copyFileIn`/`copyFileOut`) is to
inspect `mockExecFile.mock.calls` or `mockSpawn.mock.calls` for the exact arguments:

```typescript
const execCall = mockExecFile.mock.calls.find(
  ([cmd, args]) =>
    cmd === "container" && Array.isArray(args) && args[0] === "exec",
);
expect(execCall).toBeDefined();
const [, args] = execCall!;
expect(args).toContain("-i"); // stdin pipe
expect(args).toContain("-w"); // cwd
expect(args[args.indexOf("-w") + 1]).toBe("/expected/cwd");
```

---

## Part 7 — Best Practices

### 7.1 Always use the "close" event, not "exit"

```typescript
// CORRECT: fires after all I/O is flushed
proc.on("close", (code) => resolve({ ... }));

// AVOID: "exit" fires before stdio streams are drained
proc.on("exit", (code) => resolve({ ... }));
```

### 7.2 Always collect stderr even when not streaming stdout

Even if `onLine` is not set, always pipe `stderr` and collect it. Callers depend on
`ExecResult.stderr` for diagnostics and error messages.

### 7.3 Always `end()` stdin after writing

```typescript
proc.stdin!.write(opts.stdin);
proc.stdin!.end(); // WITHOUT this, some CLIs (gh, bash -c) will hang waiting for more input
```

### 7.4 `null` exit code on signal-killed processes

When a process is killed by a signal, `close` fires with `code = null`. The current
codebase maps this to `0` via `code ?? 0`. This is technically incorrect (a SIGKILL'd
process should be treated as an error) but matches the existing pattern. New providers
should mirror this behavior for consistency unless there is a specific reason to handle
it differently.

### 7.5 `execFile` vs `spawn` selection

| Use case                                            | Preferred API                                  | Why                                    |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| One-shot command, collect stdout/stderr             | `execFile`                                     | Simpler callback, built-in buffering   |
| Long-lived / streaming stdout                       | `spawn`                                        | Required for streaming; can pipe stdin |
| Synchronous best-effort cleanup in `"exit"` handler | `execFileSync`                                 | Event loop may be draining             |
| Interactive with inherited stdio                    | `spawn` with `stdio: [stream, stream, stream]` | Direct stream pass-through             |

### 7.6 GH_TOKEN injection for `github-codespaces`

Never mutate `process.env` directly. Always construct a new env object:

```typescript
const spawnEnv = options?.token
  ? { ...process.env, GH_TOKEN: options.token }
  : process.env;
// Pass to spawn/execFile as: { env: spawnEnv }
```

### 7.7 `readline.createInterface` is the canonical line-splitter

Do not reimplement line splitting. `readline.createInterface({ input: proc.stdout! })`
handles `\r\n` and `\r` as well as `\n`, handles multi-chunk lines, and does not fire
`line` for empty trailing newlines. It is the same utility used across all existing
providers.

---

## Part 8 — Common Pitfalls

### 8.1 Forgetting to pipe stderr

If `stdio[2]` is `"ignore"`, `proc.stderr` is `null` and `result.stderr` will be empty.
Always set `stdio[2]` to `"pipe"` so stderr is available for diagnostics.

### 8.2 `readline` with `"ignore"` stdin

When `opts.stdin` is undefined, `stdio[0]` is set to `"ignore"`. The child process
receives a closed stdin immediately. For `container exec` and `gh codespace ssh`, this
means the remote `bash -c <cmd>` receives no terminal. This is correct behavior — `-i`
(stdin pipe) is only added when `opts.stdin !== undefined`.

### 8.3 The `Effect.runPromise` inside `create()` boundary

`Effect.runPromise` can only be called with effects that have no unresolved dependencies
(i.e., `Effect<A, E, never>`). `startContainer` in `DockerLifecycle.ts` satisfies this
because it only uses `Effect.async(execFile(...))` which has no services. If you
accidentally try to `Effect.runPromise` an effect that requires `NodeContext.layer` or
`CommandExecutor`, you will get a TypeScript error about `R` not being `never`.

### 8.4 Do not share the `onExit` closure between multiple containers

Each call to `create()` must create new `onExit` / `onSignal` closures that capture
the specific `containerName` for that run. Never share these closures across instances.

### 8.5 Writable stream `final` vs `close` vs `finish`

In the Vercel pattern using a `Writable`, always implement `final(callback)` (not `finish`)
to flush the partial-line buffer. `finish` is an event fired after the stream ends, not a
lifecycle hook.

### 8.6 `gh codespace ssh` stderr contains SSH banner noise

`gh codespace ssh` emits SSH connection banner lines (e.g. `Warning: Permanently added ...`)
to stderr. The provider should not treat all non-empty stderr as an error — only non-zero
exit codes indicate failure.

---

## Part 9 — Findings Affecting the Investigation Recommendation

1. **The project does not use `@effect/platform`'s `Command` module in providers.** The
   recommendation in the investigation to "mirror `docker.ts`" means mirroring its
   `child_process.spawn` usage, not introducing `CommandExecutor`. New providers should
   continue with raw `spawn`/`execFile`.

2. **The "Effect vs Promise" boundary is `create()`**. Everything inside a handle method
   is plain Promise. Lifecycle (pre-flight, start, stop) is either plain Promise (podman
   pattern) or `Effect.runPromise(effect)` (docker pattern). Both are valid. For new
   providers that have no existing `DockerLifecycle`-equivalent module, the simpler
   plain-Promise pre-flight helpers (podman pattern) are recommended.

3. **`readline.createInterface` is used, not manual chunk splitting.** This is important
   for test mock design — the mock `proc.stdout` must be a proper `EventEmitter` that
   `readline` can consume, not just a raw emitter.

4. **Signal cleanup is mandatory for managed Codespaces.** The `docker.ts` three-listener
   pattern (`exit`, `SIGINT`, `SIGTERM`) with `execFileSync` in the `exit` handler is the
   correct approach. The `process.on("exit")` handler uses `execFileSync` specifically
   because by that point the Node event loop may be draining and async calls may not fire.

5. **`Effect.tryPromise` is the bridge from handle methods into Effect pipelines.** When
   the orchestrator (e.g., `syncOut.ts`) calls handle methods inside an Effect pipeline,
   it uses `Effect.tryPromise`. New provider handle methods do not need to change — the
   bridge is always on the caller side.

---

## Assumptions and Scope

| Assumption                                                                        | Confidence | Impact if Wrong                                                               |
| --------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| The `SandboxProvider` handle methods will remain Promise-based (not Effect-based) | HIGH       | Would require changing the interface and all callers                          |
| `readline.createInterface` is the intended line-splitter (not `split("\n")`)      | HIGH       | Tests would still pass but partial-chunk behavior would differ                |
| `execFileSync` in `"exit"` handler is intentional for synchronous cleanup         | HIGH       | An async alternative would be silently dropped on process exit                |
| `@effect/platform`'s `Command` module is not used in provider files               | HIGH       | Confirmed by reading all provider files — none import it                      |
| `null` exit code (signal-killed) maps to `0` is the intended behavior             | MEDIUM     | The investigation notes this as a known limitation; may change in a future PR |

### Explicitly Out of Scope

- `@effect/platform`'s `HttpClient` or other platform modules.
- Effect `Stream` usage in provider files (the project uses Node's `readline` instead).
- Effect fiber / `Effect.fork` patterns in providers (providers are single-threaded Promises).
- Testing with `@effect/vitest` — provider tests use plain `vitest`.
- `Effect.acquireUseRelease` for resource management (providers use manual registration).

### Uncertainties

- **`Command.start` vs `Command.spawn`**: Context7 documentation shows both
  `Command.start` and `Command.spawn` — these may be different API versions. The project
  pins `@effect/platform ^0.95.0`; the stable API in that version is `Command.start` inside
  `Effect.scoped`. This is moot since the project does not use the `Command` module in
  providers.
- **`gh codespace ssh` stderr noise in tests**: The volume and format of SSH banner output
  may affect test assertions on `result.stderr`. Tests should not assert exact stderr content.

---

## References

| #   | Source                                       | URL                    | Information Gathered                                                                          |
| --- | -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| 1   | `src/sandboxes/docker.ts`                    | (local)                | Canonical `exec`/`interactiveExec`/`copy*`/`close` patterns; signal handler registration      |
| 2   | `src/sandboxes/podman.ts`                    | (local)                | Confirms identical pattern to docker; pre-flight helpers as plain Promise                     |
| 3   | `src/sandboxes/vercel.ts`                    | (local)                | `Writable`-based `onLine` streaming; no signal handlers in isolated providers                 |
| 4   | `src/sandboxes/no-sandbox.ts`                | (local)                | Confirms spawn/readline pattern; plain Promise throughout                                     |
| 5   | `src/sandboxes/daytona.ts`                   | (local)                | SDK-based exec — no child_process; confirms stdin gap in daytona (no stdin support)           |
| 6   | `src/DockerLifecycle.ts`                     | (local)                | `Effect.async` wrapping of `execFile`; `Effect.gen` for sequencing; `DockerError` typed error |
| 7   | `src/syncOut.ts`                             | (local)                | `Effect.tryPromise` as the bridge; `execOk` pattern for exit-code checking in Effect          |
| 8   | `src/SandboxProvider.ts`                     | (local)                | `IsolatedSandboxHandle.exec` includes `stdin?: string`; all handle methods are Promise-based  |
| 9   | `src/sandboxes/docker.test.ts`               | (local)                | `vi.mock("node:child_process")` pattern; `mockExecFile.mock.calls` argv inspection            |
| 10  | `src/errors.ts`                              | (local)                | `Data.TaggedError` pattern; `withTimeout` helper                                              |
| 11  | `package.json`                               | (local)                | Pinned versions: effect 3.20, @effect/platform 0.95, @effect/platform-node 0.105              |
| 12  | Effect website docs (Context7)               | https://effect.website | `Command.start`, `Command.string`, `Command.lines` API; `Effect.async` with AbortSignal       |
| 13  | investigation-apple-containers-codespaces.md | (local)                | Architecture context; recommendation to mirror docker.ts                                      |

### Recommended for Deep Reading

- **`src/sandboxes/docker.ts`**: The single most important reference — every new provider
  should have this file open while writing.
- **`src/DockerLifecycle.ts`**: Shows the correct `Effect.async` + `execFile` bridge pattern
  for when Effect-native code is needed.
- **`src/syncOut.ts`**: Shows how the orchestrator uses `Effect.tryPromise` to bridge
  Promise handle methods into Effect — useful for understanding the caller-side contract.

---

## Clarifying Questions for Follow-up

1. Should `apple-containers` have its own `ContainerLifecycle.ts` module (mirroring
   `DockerLifecycle.ts`) or implement container start/stop inline as plain Promises (the
   podman pattern)? The investigation recommends a single-file implementation, which
   suggests the podman pattern.

2. Should the `null` exit code (signal-killed process) continue to map to `0` in new
   providers, or should the new providers introduce explicit signal-kill detection
   (e.g., map to `130` for SIGINT, `143` for SIGTERM)?

3. For `github-codespaces`, should the `waitForAvailable` polling use `setInterval` /
   `setTimeout` (current pattern above) or be implemented as an Effect with
   `Effect.repeat` and `Schedule`? The investigation scope says "intermediate" depth,
   suggesting the plain Promise approach is sufficient.

4. Should `AppleContainerError` and `CodespacesError` be added to `errors.ts`'s
   `SandboxError` union immediately, or deferred until the providers are merged?

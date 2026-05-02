import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile, execFileSync, spawn } from "node:child_process";
import {
  buildCopyInArgs,
  buildCopyOutArgs,
  buildCreateArgs,
  buildDeleteArgs,
  buildSshArgs,
  buildStartViaApiArgs,
  buildStopArgs,
  buildViewStateArgs,
  CodespacesError,
  githubCodespaces,
  TERMINAL_FAILURE_STATES,
  waitForAvailable,
  type GitHubCodespacesManagedOptions,
} from "./github-codespaces.js";
import type {
  IsolatedSandboxHandle,
  IsolatedSandboxProvider,
} from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

const makeFakeProc = (): FakeProc => {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  return proc;
};

/**
 * Configure mockExecFile with a sequence of `gh` responses. Each entry is
 * matched in call order: `{ match: (args) => boolean, stdout, stderr, error? }`.
 * If no entry matches, an error is returned.
 */
const programExecFile = (
  responders: Array<{
    match: (args: readonly string[]) => boolean;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }>,
) => {
  const queue = [...responders];
  mockExecFile.mockImplementation(
    (_command: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      const idx = queue.findIndex((r) => r.match(argList));
      if (idx === -1) {
        callback?.(
          new Error(`unexpected gh call: ${argList.join(" ")}`),
          "",
          "",
        );
        return undefined as any;
      }
      const resp = queue.splice(idx, 1)[0]!;
      if (resp.error) {
        callback?.(resp.error, resp.stdout ?? "", resp.stderr ?? "");
      } else {
        callback?.(null, resp.stdout ?? "", resp.stderr ?? "");
      }
      return undefined as any;
    },
  );
};

const sequenceExecFile = (
  responders: Array<{
    stdout?: string;
    stderr?: string;
    error?: Error;
  }>,
) => {
  const queue = [...responders];
  mockExecFile.mockImplementation(
    (_command: any, _args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const resp = queue.shift();
      if (!resp) {
        callback?.(new Error("no more responses queued"), "", "");
        return undefined as any;
      }
      if (resp.error) {
        callback?.(resp.error, resp.stdout ?? "", resp.stderr ?? "");
      } else {
        callback?.(null, resp.stdout ?? "", resp.stderr ?? "");
      }
      return undefined as any;
    },
  );
};

afterEach(() => {
  mockExecFile.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset();
});

describe("githubCodespaces() — basics", () => {
  it("returns an isolated provider named 'github-codespaces'", () => {
    const provider = githubCodespaces({
      mode: "existing",
      name: "test-codespace",
    });
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("github-codespaces");
    expect(typeof provider.create).toBe("function");
  });

  it("env defaults to empty object when not provided", () => {
    const provider = githubCodespaces({
      mode: "existing",
      name: "test-codespace",
    });
    expect(provider.env).toEqual({});
  });

  it("passes through provider env", () => {
    const provider = githubCodespaces({
      mode: "existing",
      name: "test-codespace",
      env: { CUSTOM: "value" },
    });
    expect(provider.env).toEqual({ CUSTOM: "value" });
  });
});

describe("argv builders", () => {
  it("buildSshArgs", () => {
    expect(buildSshArgs("cs-1", "echo hi")).toEqual([
      "codespace",
      "ssh",
      "-c",
      "cs-1",
      "--",
      "bash",
      "-c",
      "echo hi",
    ]);
  });

  it("buildCopyInArgs uses -r and never -e", () => {
    const args = buildCopyInArgs("cs-1", "/host/dir", "/sandbox/dir");
    expect(args).toEqual([
      "codespace",
      "cp",
      "-r",
      "-c",
      "cs-1",
      "/host/dir",
      "remote:/sandbox/dir",
    ]);
    expect(args).not.toContain("-e");
  });

  it("buildCopyOutArgs does not include -r", () => {
    const args = buildCopyOutArgs("cs-1", "/sandbox/file", "/host/file");
    expect(args).toEqual([
      "codespace",
      "cp",
      "-c",
      "cs-1",
      "remote:/sandbox/file",
      "/host/file",
    ]);
    expect(args).not.toContain("-r");
    expect(args).not.toContain("-e");
  });

  it("buildCreateArgs always appends --default-permissions", () => {
    const minimal = buildCreateArgs({
      mode: "managed",
      repo: "owner/repo",
    });
    expect(minimal).toEqual([
      "codespace",
      "create",
      "-R",
      "owner/repo",
      "--default-permissions",
    ]);

    const full = buildCreateArgs({
      mode: "managed",
      repo: "owner/repo",
      branch: "main",
      machine: "standardLinux32gb",
      devcontainerPath: ".devcontainer/dev.json",
      idleTimeout: "30m",
      retentionPeriod: "7d",
    });
    expect(full).toEqual([
      "codespace",
      "create",
      "-R",
      "owner/repo",
      "--branch",
      "main",
      "--machine",
      "standardLinux32gb",
      "--devcontainer-path",
      ".devcontainer/dev.json",
      "--idle-timeout",
      "30m",
      "--retention-period",
      "7d",
      "--default-permissions",
    ]);
    expect(full[full.length - 1]).toBe("--default-permissions");
  });

  it("buildDeleteArgs uses --force", () => {
    expect(buildDeleteArgs("cs-1")).toEqual([
      "codespace",
      "delete",
      "-c",
      "cs-1",
      "--force",
    ]);
  });

  it("buildStopArgs", () => {
    expect(buildStopArgs("cs-1")).toEqual(["codespace", "stop", "-c", "cs-1"]);
  });

  it("buildViewStateArgs", () => {
    expect(buildViewStateArgs("cs-1")).toEqual([
      "codespace",
      "view",
      "-c",
      "cs-1",
      "--json",
      "state",
      "-q",
      ".state",
    ]);
  });

  it("buildStartViaApiArgs", () => {
    expect(buildStartViaApiArgs("cs-1")).toEqual([
      "api",
      "--method",
      "POST",
      "/user/codespaces/cs-1/start",
    ]);
  });
});

describe("waitForAvailable — state machine", () => {
  it("returns immediately when state is Available", async () => {
    sequenceExecFile([{ stdout: "Available\n" }]);
    await expect(
      waitForAvailable("cs-1", process.env, 5, 5000),
    ).resolves.toBeUndefined();
  });

  it("polls through transient states until Available", async () => {
    sequenceExecFile([
      { stdout: "Created\n" },
      { stdout: "Provisioning\n" },
      { stdout: "Starting\n" },
      { stdout: "Available\n" },
    ]);
    await expect(
      waitForAvailable("cs-1", process.env, 1, 5000),
    ).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it("throws CodespacesError on terminal-failure state Failed", async () => {
    sequenceExecFile([{ stdout: "Failed\n" }]);
    await expect(
      waitForAvailable("cs-1", process.env, 1, 5000),
    ).rejects.toBeInstanceOf(CodespacesError);
  });

  for (const failed of [
    "Failed",
    "Unavailable",
    "Unknown",
    "Deleted",
    "Moved",
    "Archived",
  ]) {
    it(`throws on terminal-failure state '${failed}'`, async () => {
      sequenceExecFile([{ stdout: `${failed}\n` }]);
      await expect(
        waitForAvailable("cs-1", process.env, 1, 5000),
      ).rejects.toThrow(/terminal-failure/);
    });
  }

  it("on Shutdown, calls gh api start then resumes polling", async () => {
    const argLog: string[][] = [];
    mockExecFile.mockImplementation(
      (_command: any, args: any, ...rest: any[]) => {
        const callback = rest[rest.length - 1];
        const argList: string[] = Array.isArray(args) ? args : [];
        argLog.push([...argList]);
        const callIdx = argLog.length;
        if (callIdx === 1) {
          callback?.(null, "Shutdown\n", "");
        } else if (callIdx === 2) {
          // start via api call
          callback?.(null, "", "");
        } else {
          callback?.(null, "Available\n", "");
        }
        return undefined as any;
      },
    );

    await expect(
      waitForAvailable("cs-1", process.env, 1, 5000),
    ).resolves.toBeUndefined();

    expect(argLog[0]).toEqual(buildViewStateArgs("cs-1"));
    expect(argLog[1]).toEqual(buildStartViaApiArgs("cs-1"));
  });

  it("rejects with timeout when deadline elapses", async () => {
    sequenceExecFile(
      Array.from({ length: 50 }, () => ({ stdout: "Provisioning\n" })),
    );
    await expect(waitForAvailable("cs-1", process.env, 5, 20)).rejects.toThrow(
      /did not reach Available/,
    );
  });
});

describe("TERMINAL_FAILURE_STATES set", () => {
  it("contains the documented terminal-failure states", () => {
    expect(TERMINAL_FAILURE_STATES.has("Failed")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Unavailable")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Unknown")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Deleted")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Moved")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Archived")).toBe(true);
    expect(TERMINAL_FAILURE_STATES.has("Available")).toBe(false);
    expect(TERMINAL_FAILURE_STATES.has("Provisioning")).toBe(false);
    expect(TERMINAL_FAILURE_STATES.has("Shutdown")).toBe(false);
  });
});

describe("mode: 'existing' lifecycle", () => {
  it("attaches without invoking codespace create or delete", async () => {
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) =>
          a[0] === "codespace" && a[1] === "view" && a[3] === "cs-existing",
        stdout: "Available\n",
      },
    ]);

    const provider = githubCodespaces({
      mode: "existing",
      name: "cs-existing",
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    const calls = mockExecFile.mock.calls as unknown as Array<[any, any]>;
    const hasCreate = calls.some(
      ([cmd, args]) =>
        cmd === "gh" &&
        Array.isArray(args) &&
        args[0] === "codespace" &&
        args[1] === "create",
    );
    const hasDelete = calls.some(
      ([cmd, args]) =>
        cmd === "gh" &&
        Array.isArray(args) &&
        args[0] === "codespace" &&
        args[1] === "delete",
    );
    expect(hasCreate).toBe(false);
    expect(hasDelete).toBe(false);
  });

  it("worktreePath defaults to /workspaces/<name>", async () => {
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) => a[0] === "codespace" && a[1] === "view",
        stdout: "Available\n",
      },
    ]);

    const provider = githubCodespaces({
      mode: "existing",
      name: "my-cs",
    });
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/workspaces/my-cs");
    await handle.close();
  });

  it("on Shutdown, calls gh api start and continues polling", async () => {
    const log: string[][] = [];
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      log.push([...argList]);
      if (argList[0] === "auth") {
        callback?.(null, "", "");
      } else if (argList[0] === "codespace" && argList[1] === "view") {
        // first view: Shutdown; second view: Available
        const viewCalls = log.filter(
          (a) => a[0] === "codespace" && a[1] === "view",
        ).length;
        callback?.(null, viewCalls === 1 ? "Shutdown\n" : "Available\n", "");
      } else if (argList[0] === "api") {
        callback?.(null, "", "");
      } else {
        callback?.(null, "", "");
      }
      return undefined as any;
    });

    const provider = githubCodespaces({
      mode: "existing",
      name: "cs-stopped",
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    const startCall = log.find(
      (a) => a[0] === "api" && a[1] === "--method" && a[2] === "POST",
    );
    expect(startCall).toBeDefined();
    expect(startCall![3]).toBe("/user/codespaces/cs-stopped/start");
  });
});

describe("mode: 'managed' lifecycle", () => {
  it("invokes gh codespace create with --default-permissions and captures name", async () => {
    const argLog: string[][] = [];
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      argLog.push([...argList]);
      if (argList[0] === "auth") {
        callback?.(null, "", "");
      } else if (argList[0] === "codespace" && argList[1] === "create") {
        callback?.(null, "stunning-spork-xyz\n", "");
      } else if (argList[0] === "codespace" && argList[1] === "view") {
        callback?.(null, "Available\n", "");
      } else if (argList[0] === "codespace" && argList[1] === "delete") {
        callback?.(null, "", "");
      } else {
        callback?.(null, "", "");
      }
      return undefined as any;
    });

    const provider = githubCodespaces({
      mode: "managed",
      repo: "owner/repo",
      branch: "main",
      machine: "standardLinux32gb",
      devcontainerPath: ".devcontainer/dev.json",
      idleTimeout: "30m",
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    const createCall = argLog.find(
      (a) => a[0] === "codespace" && a[1] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall).toContain("--default-permissions");
    expect(createCall).toContain("-R");
    expect(createCall![createCall!.indexOf("-R") + 1]).toBe("owner/repo");
    expect(createCall![createCall!.indexOf("--branch") + 1]).toBe("main");
    expect(createCall![createCall!.indexOf("--machine") + 1]).toBe(
      "standardLinux32gb",
    );

    const deleteCall = argLog.find(
      (a) => a[0] === "codespace" && a[1] === "delete",
    );
    expect(deleteCall).toEqual(buildDeleteArgs("stunning-spork-xyz"));
  });

  it("worktreePath derives from repo basename", async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      if (argList[0] === "codespace" && argList[1] === "create") {
        callback?.(null, "cs-managed\n", "");
      } else if (argList[0] === "codespace" && argList[1] === "view") {
        callback?.(null, "Available\n", "");
      } else {
        callback?.(null, "", "");
      }
      return undefined as any;
    });

    const provider = githubCodespaces({
      mode: "managed",
      repo: "octocat/hello-world",
    });
    const handle = await provider.create({ env: {} });
    expect(handle.worktreePath).toBe("/workspaces/hello-world");
    await handle.close();
  });

  it("close calls gh codespace stop when stopOnClose is true and deleteOnClose is false", async () => {
    const argLog: string[][] = [];
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      argLog.push([...argList]);
      if (argList[0] === "codespace" && argList[1] === "create") {
        callback?.(null, "cs-stop-test\n", "");
      } else if (argList[0] === "codespace" && argList[1] === "view") {
        callback?.(null, "Available\n", "");
      } else {
        callback?.(null, "", "");
      }
      return undefined as any;
    });

    const provider = githubCodespaces({
      mode: "managed",
      repo: "owner/repo",
      deleteOnClose: false,
      stopOnClose: true,
    });
    const handle = await provider.create({ env: {} });
    await handle.close();

    const stopCall = argLog.find(
      (a) => a[0] === "codespace" && a[1] === "stop",
    );
    expect(stopCall).toEqual(buildStopArgs("cs-stop-test"));
    const deleteCall = argLog.find(
      (a) => a[0] === "codespace" && a[1] === "delete",
    );
    expect(deleteCall).toBeUndefined();
  });

  it("respects createTimeoutMs and rejects with timeout error", async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      const argList: string[] = Array.isArray(args) ? args : [];
      if (argList[0] === "codespace" && argList[1] === "create") {
        callback?.(null, "cs-slow\n", "");
      } else if (argList[0] === "codespace" && argList[1] === "view") {
        callback?.(null, "Provisioning\n", "");
      } else {
        callback?.(null, "", "");
      }
      return undefined as any;
    });

    const provider = githubCodespaces({
      mode: "managed",
      repo: "owner/repo",
      pollIntervalMs: 5,
      createTimeoutMs: 30,
    });
    await expect(provider.create({ env: {} })).rejects.toThrow(
      /did not reach Available/,
    );
  });
});

describe("handle.exec — argv and streaming", () => {
  const setupHandle = async (
    options: Parameters<typeof githubCodespaces>[0] = {
      mode: "existing",
      name: "cs-1",
    },
  ): Promise<IsolatedSandboxHandle> => {
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) => a[0] === "codespace" && a[1] === "view",
        stdout: "Available\n",
      },
    ]);
    const provider = githubCodespaces(options);
    return provider.create({ env: {} });
  };

  it("builds correct argv with cwd", async () => {
    const handle = await setupHandle();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValueOnce(fakeProc as any);

    const promise = handle.exec("ls -la", { cwd: "/workspaces/r" });
    fakeProc.stdout.emit("data", Buffer.from("output"));
    fakeProc.emit("close", 0);
    await promise;

    const call = mockSpawn.mock.calls[0]!;
    expect(call[0]).toBe("gh");
    expect(call[1]).toEqual(buildSshArgs("cs-1", "cd /workspaces/r && ls -la"));
  });

  it("builds correct argv without cwd", async () => {
    const handle = await setupHandle();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValueOnce(fakeProc as any);

    const promise = handle.exec("echo hi");
    fakeProc.emit("close", 0);
    await promise;

    const call = mockSpawn.mock.calls[0]!;
    expect(call[1]).toEqual(buildSshArgs("cs-1", "echo hi"));
  });

  it("prepends sudo when sudo option is set", async () => {
    const handle = await setupHandle();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValueOnce(fakeProc as any);

    const promise = handle.exec("rm -rf /tmp/x", { sudo: true });
    fakeProc.emit("close", 0);
    await promise;

    const call = mockSpawn.mock.calls[0]!;
    expect(call[1]).toEqual(buildSshArgs("cs-1", "sudo rm -rf /tmp/x"));
  });

  it("pipes stdin and ends the stream", async () => {
    const handle = await setupHandle();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValueOnce(fakeProc as any);

    const promise = handle.exec("cat", { stdin: "payload" });
    expect(fakeProc.stdin.write).toHaveBeenCalledWith("payload");
    expect(fakeProc.stdin.end).toHaveBeenCalled();
    fakeProc.emit("close", 0);
    await promise;

    const opts = mockSpawn.mock.calls[0]![2] as any;
    expect(opts.stdio[0]).toBe("pipe");
  });

  it("streams onLine via readline", async () => {
    const handle = await setupHandle();
    const proc = new EventEmitter() as FakeProc;
    const stdoutStream = Readable.from(["line1\nline2\n"]);
    proc.stdout = stdoutStream as unknown as EventEmitter;
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    mockSpawn.mockReturnValueOnce(proc as any);

    const lines: string[] = [];
    const promise = handle.exec("ls", {
      onLine: (line: string) => lines.push(line),
    });
    // Allow readline interface to consume the readable stream
    await new Promise((r) => setImmediate(r));
    proc.emit("close", 0);
    const result = await promise;

    expect(lines).toEqual(["line1", "line2"]);
    expect(result.exitCode).toBe(0);
  });

  it("returns ExecResult with collected stdout/stderr/exitCode", async () => {
    const handle = await setupHandle();
    const fakeProc = makeFakeProc();
    mockSpawn.mockReturnValueOnce(fakeProc as any);

    const promise = handle.exec("ls");
    fakeProc.stdout.emit("data", Buffer.from("hello"));
    fakeProc.stderr.emit("data", Buffer.from("warning"));
    fakeProc.emit("close", 42);
    const result = await promise;

    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warning");
    expect(result.exitCode).toBe(42);
  });
});

describe("handle.copyIn / handle.copyFileOut", () => {
  const setup = async () => {
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) => a[0] === "codespace" && a[1] === "view",
        stdout: "Available\n",
      },
    ]);
    const provider = githubCodespaces({ mode: "existing", name: "cs-1" });
    return provider.create({ env: {} });
  };

  it("copyIn argv uses gh codespace cp -r and never -e", async () => {
    const handle = await setup();
    let observedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "codespace" && args[1] === "cp") {
        observedArgs = [...args];
      }
      callback?.(null, "", "");
      return undefined as any;
    });

    await handle.copyIn("/host/dir", "/sandbox/dir");
    expect(observedArgs).toEqual(
      buildCopyInArgs("cs-1", "/host/dir", "/sandbox/dir"),
    );
    expect(observedArgs).not.toContain("-e");
  });

  it("copyFileOut argv has no -r and uses remote: prefix", async () => {
    const handle = await setup();
    let observedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "codespace" && args[1] === "cp") {
        observedArgs = [...args];
      }
      callback?.(null, "", "");
      return undefined as any;
    });

    await handle.copyFileOut("/sandbox/file", "/host/file");
    expect(observedArgs).toEqual(
      buildCopyOutArgs("cs-1", "/sandbox/file", "/host/file"),
    );
    expect(observedArgs).not.toContain("-r");
    expect(observedArgs).not.toContain("-e");
  });
});

describe("token injection", () => {
  beforeEach(() => {
    delete process.env.GH_TOKEN;
  });

  it("injects GH_TOKEN into spawned gh children when token option is provided", async () => {
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) => a[0] === "codespace" && a[1] === "view",
        stdout: "Available\n",
      },
    ]);

    const provider = githubCodespaces({
      mode: "existing",
      name: "cs-token",
      token: "ghp_secret123",
    });
    await provider.create({ env: {} });

    for (const call of mockExecFile.mock.calls) {
      const opts = call[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env?.GH_TOKEN).toBe("ghp_secret123");
    }
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("does not mutate process.env when token is set", async () => {
    process.env.OTHER_VAR = "preserved";
    programExecFile([
      { match: (a) => a[0] === "auth" && a[1] === "status", stdout: "" },
      {
        match: (a) => a[0] === "codespace" && a[1] === "view",
        stdout: "Available\n",
      },
    ]);

    const provider = githubCodespaces({
      mode: "existing",
      name: "cs-1",
      token: "ghp_x",
    });
    await provider.create({ env: {} });
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.OTHER_VAR).toBe("preserved");
    delete process.env.OTHER_VAR;
  });
});

describe("type-level constraints", () => {
  it("rejects branchStrategy { type: 'head' } at compile time (existing mode)", () => {
    const _bad = githubCodespaces({
      mode: "existing",
      name: "cs-1",
      // @ts-expect-error - 'head' is excluded by IsolatedBranchStrategy
      branchStrategy: { type: "head" },
    });
    void _bad;
  });

  it("rejects branchStrategy { type: 'head' } at compile time (managed mode)", () => {
    const _bad = githubCodespaces({
      mode: "managed",
      repo: "owner/repo",
      // @ts-expect-error - 'head' is excluded by IsolatedBranchStrategy
      branchStrategy: { type: "head" },
    });
    void _bad;
  });

  it("accepts merge-to-head and branch strategies in both modes", () => {
    const a: IsolatedSandboxProvider = githubCodespaces({
      mode: "existing",
      name: "cs-1",
      branchStrategy: { type: "merge-to-head" },
    });
    const b: IsolatedSandboxProvider = githubCodespaces({
      mode: "managed",
      repo: "owner/repo",
      branchStrategy: { type: "branch", branch: "feature" },
    });
    void a;
    void b;
  });

  it("type-narrows on mode discriminant", () => {
    const opts: GitHubCodespacesManagedOptions = {
      mode: "managed",
      repo: "owner/repo",
    };
    expect(opts.repo).toBe("owner/repo");
  });
});

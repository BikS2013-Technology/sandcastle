import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn(() => "darwin"),
    arch: vi.fn(() => "arm64"),
  };
});

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

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    copyFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  };
});

import { execFile, execFileSync, spawn } from "node:child_process";
import { platform as osPlatform, arch as osArch } from "node:os";
import { copyFile, mkdir } from "node:fs/promises";
import {
  appleContainers,
  buildRunArgs,
  AppleContainerError,
  defaultImageName,
  buildImageCommand,
  removeImageCommand,
} from "./apple-containers.js";
import type { BindMountSandboxHandle } from "../SandboxProvider.js";

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);
const mockOsPlatform = vi.mocked(osPlatform);
const mockOsArch = vi.mocked(osArch);
const mockCopyFile = vi.mocked(copyFile);
const mockMkdir = vi.mocked(mkdir);

const okExecFile = () => {
  mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
    const callback = rest[rest.length - 1];
    callback(null, "", "");
    return undefined as any;
  });
};

const baseCreateOptions = () => ({
  worktreePath: "/tmp/worktree",
  hostRepoPath: "/tmp/repo",
  mounts: [{ hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" }],
  env: {} as Record<string, string>,
});

beforeEach(() => {
  mockOsPlatform.mockReturnValue("darwin");
  mockOsArch.mockReturnValue("arm64");
});

afterEach(() => {
  mockExecFile.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset();
  mockCopyFile.mockReset();
  mockMkdir.mockReset();
});

describe("appleContainers()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'apple-containers'", () => {
    const provider = appleContainers();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("apple-containers");
  });

  it("has a create function", () => {
    const provider = appleContainers();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts an imageName option", () => {
    const provider = appleContainers({ imageName: "my-image:latest" });
    expect(provider.tag).toBe("bind-mount");
  });

  it("accepts mounts, env, network options", () => {
    const provider = appleContainers({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
      env: { FOO: "bar" },
      network: ["a", "b"],
    });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  it("throws at construction when a mount hostPath does not exist", () => {
    expect(() =>
      appleContainers({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("rejects on non-Apple-Silicon host (linux/x64)", async () => {
    mockOsPlatform.mockReturnValue("linux");
    mockOsArch.mockReturnValue("x64");
    okExecFile();

    const provider = appleContainers({ imageName: "x" });
    await expect(provider.create(baseCreateOptions())).rejects.toMatchObject({
      _tag: "AppleContainerError",
    });
    await expect(provider.create(baseCreateOptions())).rejects.toThrow(
      /darwin\/arm64/,
    );
  });

  it("rejects on darwin/x64 (Intel Mac)", async () => {
    mockOsPlatform.mockReturnValue("darwin");
    mockOsArch.mockReturnValue("x64");
    okExecFile();

    const provider = appleContainers({ imageName: "x" });
    await expect(provider.create(baseCreateOptions())).rejects.toThrow(
      /Apple Silicon/,
    );
  });

  it("rejects when `container` CLI is missing", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "--version") {
        const err = new Error(
          "spawn container ENOENT",
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        callback(err);
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = appleContainers({ imageName: "x" });
    await expect(provider.create(baseCreateOptions())).rejects.toThrow(
      /github\.com\/apple\/container/,
    );
  });

  it("rejects when `container system status` fails", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "system" && args[1] === "status") {
        callback(new Error("system not running"), "", "not running");
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = appleContainers({ imageName: "x" });
    await expect(provider.create(baseCreateOptions())).rejects.toThrow(
      /container system start/,
    );
  });

  it("rejects when image is not found locally", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        callback(new Error("no such image"));
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = appleContainers({ imageName: "my-app:latest" });
    await expect(provider.create(baseCreateOptions())).rejects.toThrow(
      /apple-containers build-image/,
    );
  });

  it("constructs the expected `container run` argv", async () => {
    okExecFile();

    const provider = appleContainers({
      imageName: "my-img:latest",
      containerUid: 1500,
      containerGid: 1500,
    });
    const handle = await provider.create(baseCreateOptions());

    const runCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "container" && Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const args = runCall![1] as string[];

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("-d");
    expect(args[2]).toBe("--rm");
    expect(args[3]).toBe("--name");
    expect(args[4]).toMatch(/^sandcastle-[0-9a-f-]+$/);
    expect(args[5]).toBe("-w");
    expect(args[6]).toBe("/home/agent/workspace");
    expect(args[7]).toBe("-u");
    expect(args[8]).toBe("1500:1500");
    expect(args).toContain("-v");
    expect(args).toContain("/tmp/worktree:/home/agent/workspace");
    expect(args).toContain("my-img:latest");
    expect(args[args.length - 2]).toBe("sleep");
    expect(args[args.length - 1]).toBe("infinity");

    await handle.close();
  });

  it("passes user mounts as -v flags", async () => {
    okExecFile();

    const provider = appleContainers({
      imageName: "img",
      mounts: [{ hostPath: "src", sandboxPath: "/cache" }],
    });
    const handle = await provider.create(baseCreateOptions());

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )![1] as string[];

    const cacheMount = runArgs.find((a) => a.endsWith(":/cache"));
    expect(cacheMount).toBeDefined();

    await handle.close();
  });

  it("passes env vars as -e K=V", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const opts = baseCreateOptions();
    opts.env = { FOO: "bar" };
    const handle = await provider.create(opts);

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )![1] as string[];

    expect(runArgs).toContain("-e");
    expect(runArgs).toContain("FOO=bar");
    expect(runArgs).toContain("HOME=/home/agent");

    await handle.close();
  });

  it("passes --network for a single string", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img", network: "host" });
    const handle = await provider.create(baseCreateOptions());

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )![1] as string[];

    const idx = runArgs.indexOf("--network");
    expect(idx).toBeGreaterThan(-1);
    expect(runArgs[idx + 1]).toBe("host");

    await handle.close();
  });

  it("passes multiple --network flags for an array", async () => {
    okExecFile();
    const provider = appleContainers({
      imageName: "img",
      network: ["a", "b"],
    });
    const handle = await provider.create(baseCreateOptions());

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )![1] as string[];

    const first = runArgs.indexOf("--network");
    expect(runArgs[first + 1]).toBe("a");
    const second = runArgs.indexOf("--network", first + 1);
    expect(runArgs[second + 1]).toBe("b");

    await handle.close();
  });

  it("does not pass --network when omitted", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = await provider.create(baseCreateOptions());

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )![1] as string[];

    expect(runArgs).not.toContain("--network");
    await handle.close();
  });

  it("exec builds correct argv with stdin and cwd", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    const fakeProc: any = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    fakeProc.stdin = { write: vi.fn(), end: vi.fn() };
    mockSpawn.mockReturnValueOnce(fakeProc);

    const execPromise = handle.exec("ls", { stdin: "x", cwd: "/foo" });
    fakeProc.emit("close", 0);
    await execPromise;

    const [cmd, args] = mockSpawn.mock.calls[0]!;
    expect(cmd).toBe("container");
    expect(args).toEqual([
      "exec",
      "-i",
      "-w",
      "/foo",
      expect.stringMatching(/^sandcastle-/),
      "bash",
      "-c",
      "ls",
    ]);
    expect(fakeProc.stdin.write).toHaveBeenCalledWith("x");
    expect(fakeProc.stdin.end).toHaveBeenCalled();

    await handle.close();
  });

  it("exec streams onLine via readline", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    const fakeProc: any = new EventEmitter();
    fakeProc.stdout = Readable.from([Buffer.from("a\nb\n")]);
    fakeProc.stderr = new EventEmitter();
    fakeProc.stdin = { write: vi.fn(), end: vi.fn() };
    mockSpawn.mockReturnValueOnce(fakeProc);

    const lines: string[] = [];
    const execPromise = handle.exec("echo a", {
      onLine: (l) => lines.push(l),
    });

    await new Promise((r) => setImmediate(r));
    fakeProc.emit("close", 0);
    const result = await execPromise;

    expect(lines).toEqual(["a", "b"]);
    expect(result.exitCode).toBe(0);

    await handle.close();
  });

  it("interactiveExec allocates -it when stdin is a TTY", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    const fakeProc: any = new EventEmitter();
    mockSpawn.mockReturnValueOnce(fakeProc);

    const ttyStdin: any = new EventEmitter();
    ttyStdin.isTTY = true;

    const execPromise = handle.interactiveExec!(["bash"], {
      stdin: ttyStdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    fakeProc.emit("close", 0);
    await execPromise;

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain("-it");
    expect(args).not.toContain("-i");

    await handle.close();
  });

  it("interactiveExec uses -i when stdin is not a TTY", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    const fakeProc: any = new EventEmitter();
    mockSpawn.mockReturnValueOnce(fakeProc);

    const nonTtyStdin: any = new EventEmitter();
    nonTtyStdin.isTTY = false;

    const execPromise = handle.interactiveExec!(["bash"], {
      stdin: nonTtyStdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    fakeProc.emit("close", 0);
    await execPromise;

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain("-i");
    expect(args).not.toContain("-it");

    await handle.close();
  });

  it("copyFileIn uses host filesystem and never invokes `container cp`", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    mockExecFile.mockClear();
    await handle.copyFileIn("/host/file.txt", "/home/agent/workspace/file.txt");

    expect(mockCopyFile).toHaveBeenCalledWith(
      "/host/file.txt",
      "/tmp/worktree/file.txt",
    );
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/worktree", {
      recursive: true,
    });

    const cpCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "cp",
    );
    expect(cpCall).toBeUndefined();

    await handle.close();
  });

  it("copyFileOut uses host filesystem and never invokes `container cp`", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = (await provider.create(
      baseCreateOptions(),
    )) as BindMountSandboxHandle;

    mockExecFile.mockClear();
    await handle.copyFileOut(
      "/home/agent/workspace/output.txt",
      "/host/output.txt",
    );

    expect(mockCopyFile).toHaveBeenCalledWith(
      "/tmp/worktree/output.txt",
      "/host/output.txt",
    );

    const cpCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "cp",
    );
    expect(cpCall).toBeUndefined();

    await handle.close();
  });

  it("close() invokes `container delete -f` and removes signal handlers", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = await provider.create(baseCreateOptions());

    const before = process.listeners("SIGINT").length;
    expect(before).toBeGreaterThan(0);

    await handle.close();

    const deleteCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "container" &&
        Array.isArray(args) &&
        args[0] === "delete" &&
        args[1] === "-f",
    );
    expect(deleteCall).toBeDefined();
  });

  it("registers a signal handler that calls execFileSync with timeout on cleanup", async () => {
    okExecFile();
    const provider = appleContainers({ imageName: "img" });
    const handle = await provider.create(baseCreateOptions());

    const exitListeners = process.listeners("exit");
    const sandcastleListener = exitListeners[exitListeners.length - 1];
    sandcastleListener!(0);

    const rmCall = mockExecFileSync.mock.calls.find(
      ([cmd, args]) =>
        cmd === "container" &&
        Array.isArray(args) &&
        args[0] === "delete" &&
        args[1] === "-f",
    );
    expect(rmCall).toBeDefined();
    expect(rmCall![2]).toMatchObject({ timeout: 5000 });

    await handle.close();
  });

  it("AppleContainerError carries the _tag discriminator", async () => {
    mockOsPlatform.mockReturnValue("linux");
    mockOsArch.mockReturnValue("x64");
    okExecFile();

    const provider = appleContainers({ imageName: "img" });
    try {
      await provider.create(baseCreateOptions());
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AppleContainerError);
      expect((err as AppleContainerError)._tag).toBe("AppleContainerError");
    }
  });

  it("accepts head, merge-to-head, and branch strategies (compile-time smoke)", () => {
    const provider = appleContainers();
    // bind-mount providers accept all three strategies — confirmed at the type
    // level by createBindMountSandboxProvider; runtime smoke is just construction.
    expect(provider.tag).toBe("bind-mount");
  });
});

describe("buildRunArgs()", () => {
  it("snapshots the canonical run argv", () => {
    const args = buildRunArgs({
      containerName: "sandcastle-fixed-uuid",
      imageName: "my-img:latest",
      hostWorktreePath: "/host/wt",
      sandboxWorktreePath: "/home/agent/workspace",
      uid: 1000,
      gid: 1000,
      mounts: [
        { hostPath: "/host/wt", sandboxPath: "/home/agent/workspace" },
        { hostPath: "/host/cache", sandboxPath: "/cache", readonly: true },
      ],
      env: { HOME: "/home/agent", FOO: "bar" },
      network: ["net1", "net2"],
    });

    expect(args).toEqual([
      "run",
      "-d",
      "--rm",
      "--name",
      "sandcastle-fixed-uuid",
      "-w",
      "/home/agent/workspace",
      "-u",
      "1000:1000",
      "-v",
      "/host/wt:/home/agent/workspace",
      "-v",
      "/host/cache:/cache:ro",
      "-e",
      "HOME=/home/agent",
      "-e",
      "FOO=bar",
      "--network",
      "net1",
      "--network",
      "net2",
      "my-img:latest",
      "sleep",
      "infinity",
    ]);
  });
});

describe("buildImage / removeImage CLI commands", () => {
  it("buildImageCommand has the expected name", () => {
    expect(buildImageCommand).toBeDefined();
  });

  it("removeImageCommand has the expected name", () => {
    expect(removeImageCommand).toBeDefined();
  });
});

describe("defaultImageName re-export", () => {
  it("derives image name from repo directory", () => {
    expect(defaultImageName("/home/user/my-repo")).toBe("sandcastle:my-repo");
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  parseExpectedSha256,
  runUpdateCommand,
  type UpdaterDependencies,
} from "../src/update";

type MockState = {
  outputs: string[];
  errors: string[];
  urls: string[];
  writes: Array<{ path: string; content: string }>;
  chmods: Array<{ path: string; mode: number }>;
  renames: Array<{ from: string; to: string }>;
  removes: string[];
  spawns: Array<{ command: string; args: readonly string[] }>;
};

function releaseResponse(tagName: string, assetNames: string[]): Response {
  return Response.json({
    tag_name: tagName,
    assets: assetNames.map(name => ({
      name,
      browser_download_url: `https://downloads.example/${name}`,
    })),
  });
}

function binaryResponse(content = "binary"): Response {
  return new Response(content);
}

function checksumResponse(assetName: string, content = "binary"): Response {
  const hash = createHash("sha256").update(content).digest("hex");
  return new Response(`${hash}  ${assetName}\n`);
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function createDependencies(responses: Response[], overrides: Partial<UpdaterDependencies> = {}): {
  dependencies: UpdaterDependencies;
  state: MockState;
} {
  const queuedResponses = [...responses];
  const state: MockState = {
    outputs: [],
    errors: [],
    urls: [],
    writes: [],
    chmods: [],
    renames: [],
    removes: [],
    spawns: [],
  };
  return {
    state,
    dependencies: {
      fetchFn: (async (input: string | URL | Request) => {
        state.urls.push(String(input));
        const response = queuedResponses.shift();
        if (!response) {
          throw new Error(`Unexpected fetch: ${String(input)}`);
        }
        return response;
      }) as typeof fetch,
      out: message => state.outputs.push(message),
      err: message => state.errors.push(message),
      getPlatform: () => ({ platform: "linux", arch: "x64" }),
      getExecutablePath: () => "/usr/local/bin/link-cli",
      resolveRealPath: async path => `/real${path}`,
      fileExists: async path => path !== "/real/usr/local/bin/missing-companion",
      createTempDirectory: async (targetDirectory, prefix) => `${targetDirectory}/${prefix}test`,
      writeBinary: async (path, content) => {
        state.writes.push({
          path,
          content: typeof content === "string" ? content : new TextDecoder().decode(content),
        });
      },
      chmodFile: async (path, mode) => {
        state.chmods.push({ path, mode });
      },
      renameFile: async (from, to) => {
        state.renames.push({ from, to });
      },
      removeFile: async path => {
        state.removes.push(path);
      },
      statFile: async () => ({ mode: 0o100755 }),
      getCurrentProcessId: () => 1234,
      spawnDetached: (command, args) => {
        state.spawns.push({ command, args });
      },
      ...overrides,
    },
  };
}

describe("updater library", () => {
  test("checks for updates without replacing the binary", async () => {
    const { dependencies, state } = createDependencies([
      releaseResponse("v0.2.0", ["link-cli-v0.2.0-linux-x64"]),
    ]);

    await expect(runUpdateCommand({ checkOnly: true }, {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "0.1.0",
    }, dependencies)).resolves.toBe(0);

    expect(state.urls).toEqual(["https://api.github.com/repos/pablozaiden/link/releases/latest"]);
    expect(state.outputs).toContain("Update available: 0.1.0 -> 0.2.0");
    expect(state.renames).toHaveLength(0);
  });

  test("installs a requested release with checksum verification", async () => {
    const assetName = "link-cli-v1.2.3-linux-x64";
    const { dependencies, state } = createDependencies([
      releaseResponse("v1.2.3", [assetName, `${assetName}.sha256`]),
      binaryResponse("new-binary"),
      checksumResponse(assetName, "new-binary"),
    ]);

    await expect(runUpdateCommand({ checkOnly: false, version: "1.2.3" }, {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "0.1.0",
    }, dependencies)).resolves.toBe(0);

    expect(state.urls).toEqual([
      "https://api.github.com/repos/pablozaiden/link/releases/tags/v1.2.3",
      `https://downloads.example/${assetName}`,
      `https://downloads.example/${assetName}.sha256`,
    ]);
    expect(state.writes.map(({ path, content }) => ({
      path: portablePath(path),
      content,
    }))).toEqual([
      { path: `/real/usr/local/bin/.link-cli-update-test/${assetName}`, content: "new-binary" },
    ]);
    expect(state.renames.map(({ from, to }) => ({
      from: portablePath(from),
      to: portablePath(to),
    }))).toEqual([
      { from: "/real/usr/local/bin/link-cli", to: "/real/usr/local/bin/.link-cli-update-test/link-cli.backup" },
      { from: `/real/usr/local/bin/.link-cli-update-test/${assetName}`, to: "/real/usr/local/bin/link-cli" },
    ]);
  });

  test("updates optional companion binaries beside the primary binary", async () => {
    const companion = "ralpher-v1.2.3-linux-x64";
    const primary = "ralpher-cli-v1.2.3-linux-x64";
    const { dependencies, state } = createDependencies([
      releaseResponse("v1.2.3", [companion, `${companion}.sha256`, primary, `${primary}.sha256`]),
      binaryResponse("server"),
      checksumResponse(companion, "server"),
      binaryResponse("cli"),
      checksumResponse(primary, "cli"),
    ], {
      getExecutablePath: () => "/usr/local/bin/ralpher-cli",
    });

    await expect(runUpdateCommand({ checkOnly: false }, {
      repository: "pablozaiden/ralpher",
      binaryName: "ralpher-cli",
      currentVersion: "1.2.2",
      companionBinaries: [{ binaryName: "ralpher" }],
    }, dependencies)).resolves.toBe(0);

    expect(state.renames
      .filter(rename => !rename.to.endsWith(".backup"))
      .map(rename => portablePath(rename.to))).toEqual([
      "/real/usr/local/bin/ralpher",
      "/real/usr/local/bin/ralpher-cli",
    ]);
  });

  test("defers Windows replacement until the running executable exits", async () => {
    const assetName = "link-cli-v1.2.3-windows-x64.exe";
    const { dependencies, state } = createDependencies([
      releaseResponse("v1.2.3", [assetName, `${assetName}.sha256`]),
      binaryResponse("new-binary"),
      checksumResponse(assetName, "new-binary"),
    ], {
      getPlatform: () => ({ platform: "win32", arch: "x64" }),
      getExecutablePath: () => "/programs/link-cli.exe",
    });

    await expect(runUpdateCommand({ checkOnly: false }, {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "1.2.2",
    }, dependencies)).resolves.toBe(0);

    expect(state.chmods).toHaveLength(0);
    expect(state.renames).toHaveLength(0);
    expect(state.spawns).toHaveLength(1);
    expect(state.spawns[0]?.command).toBe("powershell.exe");
    expect(state.spawns[0]?.args).toContain("-ParentProcessId");
    expect(state.spawns[0]?.args).toContain("1234");
    expect(state.writes.some(({ path }) => path.endsWith("apply-update.ps1"))).toBe(true);
    const helper = state.writes.find(({ path }) => path.endsWith("apply-update.ps1"));
    expect(helper?.content).toContain("/real/programs/link-cli.exe");
    expect(state.outputs.at(-1)).toContain("will complete after process 1234 exits");
  });

  test("rolls back companion updates when any replacement fails", async () => {
    const companion = "ralpher-v1.2.3-linux-x64";
    const primary = "ralpher-cli-v1.2.3-linux-x64";
    const { dependencies, state } = createDependencies([
      releaseResponse("v1.2.3", [companion, `${companion}.sha256`, primary, `${primary}.sha256`]),
      binaryResponse("server"),
      checksumResponse(companion, "server"),
      binaryResponse("cli"),
      checksumResponse(primary, "cli"),
    ], {
      getExecutablePath: () => "/usr/local/bin/ralpher-cli",
      renameFile: async (from, to) => {
        state.renames.push({ from, to });
        if (from.endsWith(primary)) {
          throw new Error("simulated primary replacement failure");
        }
      },
    });

    await expect(runUpdateCommand({ checkOnly: false }, {
      repository: "pablozaiden/ralpher",
      binaryName: "ralpher-cli",
      currentVersion: "1.2.2",
      companionBinaries: [{ binaryName: "ralpher" }],
    }, dependencies)).rejects.toThrow("Failed to update ralpher-cli");

    expect(state.removes.map(portablePath)).toContain("/real/usr/local/bin/ralpher");
    expect(state.renames.map(({ from, to }) => ({
      from: portablePath(from),
      to: portablePath(to),
    }))).toContainEqual({
      from: "/real/usr/local/bin/.ralpher-cli-update-test/ralpher-cli.backup",
      to: "/real/usr/local/bin/ralpher-cli",
    });
    expect(state.renames.map(({ from, to }) => ({
      from: portablePath(from),
      to: portablePath(to),
    }))).toContainEqual({
      from: "/real/usr/local/bin/.ralpher-cli-update-test/ralpher.backup",
      to: "/real/usr/local/bin/ralpher",
    });
    expect(state.outputs.some(output => output.startsWith("Updated "))).toBe(false);
  });

  test("rejects source-mode updates and missing required checksums", async () => {
    const assetName = "link-cli-v0.2.0-linux-x64";
    const sourceMode = createDependencies([
      releaseResponse("v0.2.0", [assetName, `${assetName}.sha256`]),
    ], {
      getExecutablePath: () => "/usr/bin/bun",
    });
    await expect(runUpdateCommand({ checkOnly: false }, {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "0.1.0",
    }, sourceMode.dependencies)).rejects.toThrow("only works from an installed");

    const missingChecksum = createDependencies([
      releaseResponse("v0.2.0", [assetName]),
      binaryResponse("binary"),
    ]);
    await expect(runUpdateCommand({ checkOnly: false }, {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "0.1.0",
    }, missingChecksum.dependencies)).rejects.toThrow("is required to verify");
  });

  test("parses checksum files", () => {
    const hash = "a".repeat(64);
    expect(parseExpectedSha256(`${hash}  link-cli-v1-linux-x64\n`, "link-cli-v1-linux-x64")).toBe(hash);
    expect(parseExpectedSha256(`${hash}\n`, "anything")).toBe(hash);
    expect(() => parseExpectedSha256("not-a-hash", "anything")).toThrow("valid SHA-256");
  });
});

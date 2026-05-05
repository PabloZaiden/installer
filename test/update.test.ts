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
    expect(state.writes).toEqual([
      { path: `/real/usr/local/bin/.link-cli-update-test/${assetName}`, content: "new-binary" },
    ]);
    expect(state.renames).toEqual([
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

    expect(state.renames.filter(rename => !rename.to.endsWith(".backup")).map(rename => rename.to)).toEqual([
      "/real/usr/local/bin/ralpher",
      "/real/usr/local/bin/ralpher-cli",
    ]);
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

    expect(state.removes).toContain("/real/usr/local/bin/ralpher");
    expect(state.renames).toContainEqual({
      from: "/real/usr/local/bin/.ralpher-cli-update-test/ralpher-cli.backup",
      to: "/real/usr/local/bin/ralpher-cli",
    });
    expect(state.renames).toContainEqual({
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

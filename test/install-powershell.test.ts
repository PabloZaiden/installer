import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { runUpdateCommand } from "../src/update";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installScript = join(repositoryRoot, "install.ps1");
const windowsTest = process.platform === "win32" ? test : test.skip;

async function runPowerShellInstaller(
  baseUrl: string,
  installDir: string,
  extraArgs: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installScript,
    "example/tool",
    "-InstallDir",
    installDir,
    "-NoModifyPath",
    ...extraArgs,
  ], {
    env: {
      ...process.env,
      RAW_BASE_URL: `${baseUrl}/raw`,
      GITHUB_API_BASE_URL: `${baseUrl}/api`,
      GITHUB_RELEASE_BASE_URL: `${baseUrl}/release`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : "",
    child.stderr ? new Response(child.stderr).text() : "",
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForFileText(
  path: string,
  predicate: (content: string) => boolean,
  description: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  let observed = "<missing>";
  while (Date.now() <= deadline) {
    try {
      observed = await Bun.file(path).text();
    } catch {
      observed = "<missing>";
    }
    if (predicate(observed)) return observed;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}; last observed: ${observed}`);
}

windowsTest("install.ps1 installs and verifies a manifest-defined binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "installer-powershell-"));
  const installDir = join(root, "bin");
  const architecture = (process.env["PROCESSOR_ARCHITEW6432"] ?? process.env["PROCESSOR_ARCHITECTURE"])
    ?.toUpperCase() === "ARM64"
    ? "arm64"
    : "x64";
  const assetName = `tool-cli-v1.2.3-windows-${architecture}.exe`;
  const binary = new TextEncoder().encode("windows-binary");
  const checksum = createHash("sha256").update(binary).digest("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/raw/example/tool/main/.github/installer.json") {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          binaries: [{ name: "tool-cli" }],
          checksums: { required: true },
          platforms: { windows: [architecture] },
        }), {
          headers: { "content-type": "text/plain" },
        });
      }
      if (path === "/api/repos/example/tool/releases/latest") {
        return Response.json({ tag_name: "v1.2.3" });
      }
      if (path === `/release/example/tool/releases/download/v1.2.3/${assetName}`) {
        return new Response(binary);
      }
      if (path === `/release/example/tool/releases/download/v1.2.3/${assetName}.sha256`) {
        return new Response(`${checksum}  ${assetName}\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const { exitCode, stdout, stderr } = await runPowerShellInstaller(baseUrl, installDir);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Detected platform: windows-${architecture}`);
    expect(await Bun.file(join(installDir, "tool-cli.exe")).bytes()).toEqual(binary);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

windowsTest("the updater helper replaces staged Windows executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "installer-windows-update-"));
  const targetPath = join(root, "tool.exe");
  const architecture = (process.env["PROCESSOR_ARCHITEW6432"] ?? process.env["PROCESSOR_ARCHITECTURE"])
    ?.toUpperCase() === "ARM64"
    ? "arm64"
    : "x64";
  const assetName = `tool-v1.2.3-windows-${architecture}.exe`;
  const nextBinary = new TextEncoder().encode("new-binary");
  const checksum = createHash("sha256").update(nextBinary).digest("hex");
  const responses = [
    Response.json({
      tag_name: "v1.2.3",
      assets: [
        { name: assetName, browser_download_url: `https://downloads.example/${assetName}` },
        { name: `${assetName}.sha256`, browser_download_url: `https://downloads.example/${assetName}.sha256` },
      ],
    }),
    new Response(nextBinary),
    new Response(`${checksum}  ${assetName}\n`),
  ];
  let blockingProcess: ReturnType<typeof Bun.spawn> | undefined;

  try {
    await Bun.write(targetPath, "old-binary");
    blockingProcess = Bun.spawn([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Threading.Thread]::Sleep(30000)",
    ], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    await runUpdateCommand({
      checkOnly: false,
    }, {
      repository: "example/tool",
      binaryName: "tool",
      currentVersion: "1.2.2",
    }, {
      getPlatform: () => ({ platform: "win32", arch: architecture }),
      getExecutablePath: () => targetPath,
      getCurrentProcessId: () => blockingProcess!.pid,
      fetchFn: (async (_input: string | URL | Request) => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected updater request");
        return response;
      }) as typeof fetch,
      out: () => undefined,
      err: () => undefined,
    });

    const errorPath = `${targetPath}.update-error.log`;
    await waitForFileText(
      errorPath,
      content => content === "Update helper started.",
      "the updater helper to start",
    );
    expect(blockingProcess.exitCode).toBeNull();
    expect(await Bun.file(targetPath).text()).toBe("old-binary");

    blockingProcess.kill();
    await blockingProcess.exited;
    const observed = await waitForFileText(
      targetPath,
      content => content === "new-binary",
      "the deferred executable replacement",
    );
    expect(observed).toBe("new-binary");
    expect(await Bun.file(errorPath).exists()).toBe(false);
  } finally {
    if (blockingProcess?.exitCode === null) {
      blockingProcess.kill();
      await blockingProcess.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

windowsTest("install.ps1 rejects a malformed optional checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "installer-powershell-checksum-"));
  const installDir = join(root, "bin");
  const architecture = (process.env["PROCESSOR_ARCHITEW6432"] ?? process.env["PROCESSOR_ARCHITECTURE"])
    ?.toUpperCase() === "ARM64"
    ? "arm64"
    : "x64";
  const assetName = `tool-cli-v1.2.3-windows-${architecture}.exe`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/raw/example/tool/main/.github/installer.json") {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          binaries: [{ name: "tool-cli" }],
          checksums: { required: false },
          platforms: { windows: [architecture] },
        }), {
          headers: { "content-type": "text/plain" },
        });
      }
      if (path === "/api/repos/example/tool/releases/latest") {
        return Response.json({ tag_name: "v1.2.3" });
      }
      if (path === `/release/example/tool/releases/download/v1.2.3/${assetName}`) {
        return new Response("windows-binary");
      }
      if (path === `/release/example/tool/releases/download/v1.2.3/${assetName}.sha256`) {
        return new Response("not-a-checksum\n");
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const { exitCode, stderr } = await runPowerShellInstaller(baseUrl, installDir);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Checksum for ${assetName} did not contain a valid SHA-256 entry.`);
    expect(await Bun.file(join(installDir, "tool-cli.exe")).exists()).toBe(false);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

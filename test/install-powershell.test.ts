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
        return Response.json({
          schemaVersion: 1,
          binaries: [{ name: "tool-cli" }],
          checksums: { required: true },
          platforms: { windows: [architecture] },
        }, 15_000);
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

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Detected platform: windows-${architecture}`);
    expect(await Bun.file(join(installDir, "tool-cli.exe")).bytes()).toEqual(binary);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

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

  try {
    await Bun.write(targetPath, "old-binary");
    await runUpdateCommand({
      checkOnly: false,
    }, {
      repository: "example/tool",
      binaryName: "tool",
      currentVersion: "1.2.2",
    }, {
      getPlatform: () => ({ platform: "win32", arch: architecture }),
      getExecutablePath: () => targetPath,
      getCurrentProcessId: () => 0,
      fetchFn: (async (_input: string | URL | Request) => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected updater request");
        return response;
      }) as typeof fetch,
      out: () => undefined,
      err: () => undefined,
    });

    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() <= deadline) {
      try {
        observed = await Bun.file(targetPath).text();
      } catch {
        observed = "<replacement in progress>";
      }
      if (observed === "new-binary") break;
      await Bun.sleep(50);
    }
    const errorPath = `${targetPath}.update-error.log`;
    if (observed !== "new-binary" && await Bun.file(errorPath).exists()) {
      throw new Error(`Deferred updater failed: ${await Bun.file(errorPath).text()}`);
    }
    expect(observed).toBe("new-binary");
    expect(await Bun.file(`${targetPath}.update-error.log`).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

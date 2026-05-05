import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const installScript = join(repositoryRoot, "install.sh");

describe("install.sh", () => {
  test("installs a manifest-defined binary from a local release fixture", async () => {
    const tempDir = await Bun.$`mktemp -d`.text().then(value => value.trim());
    const rawRoot = join(tempDir, "raw");
    const apiRoot = join(tempDir, "api");
    const releaseRoot = join(tempDir, "release");
    const installDir = join(tempDir, "bin");
    const repo = "example/tool";
    const tag = "v1.2.3";
    const assetName = `${repo}/releases/download/${tag}/tool-cli-${tag}-linux-x64`;
    const assetPath = join(releaseRoot, assetName);

    await mkdir(join(rawRoot, repo, "main", ".github"), { recursive: true });
    await mkdir(join(apiRoot, "repos", repo, "releases"), { recursive: true });
    await mkdir(join(releaseRoot, repo, "releases", "download", tag), { recursive: true });
    await writeFile(join(rawRoot, repo, "main", ".github", "installer.json"), JSON.stringify({
      schemaVersion: 1,
      binaries: [{ name: "tool-cli" }],
      checksums: { required: true },
    }));
    await writeFile(join(apiRoot, "repos", repo, "releases", "latest"), JSON.stringify({ tag_name: tag }));
    await writeFile(assetPath, "binary");
    await writeFile(`${assetPath}.sha256`, `${createHash("sha256").update("binary").digest("hex")}  tool-cli-${tag}-linux-x64\n`);

    const result = await Bun.$`RAW_BASE_URL=${`file://${rawRoot}`} GITHUB_API_BASE_URL=${`file://${apiRoot}`} GITHUB_RELEASE_BASE_URL=${`file://${releaseRoot}`} sh ${installScript} ${repo} --install-dir ${installDir}`.quiet();

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(installDir, "tool-cli")).text()).toBe("binary");
  });

  test("passes shell syntax validation", async () => {
    const result = await Bun.$`sh -n ${installScript}`.quiet();
    expect(result.exitCode).toBe(0);
  });

  test("rejects manifests that do not include the current platform", async () => {
    const tempDir = await Bun.$`mktemp -d`.text().then(value => value.trim());
    const rawRoot = join(tempDir, "raw");
    const repo = "example/tool";

    await mkdir(join(rawRoot, repo, "main", ".github"), { recursive: true });
    await writeFile(join(rawRoot, repo, "main", ".github", "installer.json"), JSON.stringify({
      schemaVersion: 1,
      binaries: [{ name: "tool-cli" }],
      platforms: { darwin: ["arm64"] },
    }));

    const result = await Bun.$`RAW_BASE_URL=${`file://${rawRoot}`} sh ${installScript} ${repo} --install-dir ${join(tempDir, "bin")}`.nothrow().quiet();

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Manifest does not support platform linux-x64");
  });

  test("skips checksum download and verification when checksum policy is none", async () => {
    const tempDir = await Bun.$`mktemp -d`.text().then(value => value.trim());
    const rawRoot = join(tempDir, "raw");
    const apiRoot = join(tempDir, "api");
    const releaseRoot = join(tempDir, "release");
    const installDir = join(tempDir, "bin");
    const repo = "example/tool";
    const tag = "v1.2.3";
    const assetName = `${repo}/releases/download/${tag}/tool-cli-${tag}-linux-x64`;
    const assetPath = join(releaseRoot, assetName);

    await mkdir(join(rawRoot, repo, "main", ".github"), { recursive: true });
    await mkdir(join(apiRoot, "repos", repo, "releases"), { recursive: true });
    await mkdir(join(releaseRoot, repo, "releases", "download", tag), { recursive: true });
    await writeFile(join(rawRoot, repo, "main", ".github", "installer.json"), JSON.stringify({
      schemaVersion: 1,
      binaries: [{ name: "tool-cli" }],
      checksums: { required: true },
    }));
    await writeFile(join(apiRoot, "repos", repo, "releases", "latest"), JSON.stringify({ tag_name: tag }));
    await writeFile(assetPath, "binary");
    await writeFile(`${assetPath}.sha256`, `${"0".repeat(64)}  tool-cli-${tag}-linux-x64\n`);

    const result = await Bun.$`RAW_BASE_URL=${`file://${rawRoot}`} GITHUB_API_BASE_URL=${`file://${apiRoot}`} GITHUB_RELEASE_BASE_URL=${`file://${releaseRoot}`} sh ${installScript} ${repo} --install-dir ${installDir} --checksum none`.quiet();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("checksum policy is none");
    expect(await Bun.file(join(installDir, "tool-cli")).text()).toBe("binary");
  });

  test("rejects unsupported installer manifest schema versions before reading fields", async () => {
    const tempDir = await Bun.$`mktemp -d`.text().then(value => value.trim());
    const rawRoot = join(tempDir, "raw");
    const repo = "example/tool";

    await mkdir(join(rawRoot, repo, "main", ".github"), { recursive: true });
    await writeFile(join(rawRoot, repo, "main", ".github", "installer.json"), JSON.stringify({
      schemaVersion: 2,
      repo: "example/other-tool",
      binaries: [{ name: "tool-cli" }],
    }));

    const result = await Bun.$`RAW_BASE_URL=${`file://${rawRoot}`} sh ${installScript} ${repo} --install-dir ${join(tempDir, "bin")}`.nothrow().quiet();

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unsupported installer manifest schemaVersion: 2");
  });
});

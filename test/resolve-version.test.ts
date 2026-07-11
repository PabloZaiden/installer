import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const resolverScript = join(repositoryRoot, ".github/actions/resolve-version/resolve-version.sh");

type ResolverOptions = {
  mode: "release" | "main";
  releaseTag?: string;
  latestReleaseTag?: string;
  updatePackageVersion?: boolean;
};

async function runResolver(options: ResolverOptions) {
  const tempDir = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const outputPath = join(tempDir, "github-output");
  const packagePath = join(tempDir, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "example", version: "0.0.0-development" }));

  const result = await Bun.$`MODE=${options.mode} RELEASE_TAG=${options.releaseTag ?? ""} LATEST_RELEASE_TAG=${options.latestReleaseTag ?? ""} UPDATE_PACKAGE_VERSION=${options.updatePackageVersion ? "true" : "false"} PACKAGE_JSON=${packagePath} GITHUB_OUTPUT=${outputPath} GITHUB_SHA=abcdef1234567890 BUILD_TIMESTAMP=2026-07-11-14-48 bash ${resolverScript}`.nothrow().quiet();

  return {
    result,
    output: await Bun.file(outputPath).text().catch(() => ""),
    packageVersion: JSON.parse(await Bun.file(packagePath).text()).version as string,
  };
}

function outputValue(output: string, name: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe("resolve-version action", () => {
  test("passes shell syntax validation", async () => {
    const result = await Bun.$`bash -n ${resolverScript}`.quiet();
    expect(result.exitCode).toBe(0);
  });

  test("resolves release tags without the leading v", async () => {
    const { result, output, packageVersion } = await runResolver({
      mode: "release",
      releaseTag: "v1.2.3",
    });

    expect(result.exitCode).toBe(0);
    expect(outputValue(output, "version")).toBe("1.2.3");
    expect(outputValue(output, "base_version")).toBe("1.2.3");
    expect(packageVersion).toBe("0.0.0-development");
  });

  test("increments the latest release patch for main snapshots", async () => {
    const { result, output, packageVersion } = await runResolver({
      mode: "main",
      latestReleaseTag: "v8.5.9",
      updatePackageVersion: true,
    });

    expect(result.exitCode).toBe(0);
    expect(outputValue(output, "version")).toBe("8.5.10-main-2026-07-11-14-48-abcdef1");
    expect(outputValue(output, "base_version")).toBe("8.5.9");
    expect(packageVersion).toBe("8.5.10-main-2026-07-11-14-48-abcdef1");
  });

  test("drops prerelease metadata before incrementing the main patch", async () => {
    const { result, output } = await runResolver({
      mode: "main",
      latestReleaseTag: "v8.5.9-rc.1",
    });

    expect(result.exitCode).toBe(0);
    expect(outputValue(output, "version")).toBe("8.5.10-main-2026-07-11-14-48-abcdef1");
    expect(outputValue(output, "base_version")).toBe("8.5.9");
  });

  test("rejects a non-semver latest release", async () => {
    const { result } = await runResolver({
      mode: "main",
      latestReleaseTag: "v8.5",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("latest release version is not valid semver");
  });
});

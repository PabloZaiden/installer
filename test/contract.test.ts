import { describe, expect, test } from "bun:test";
import {
  buildReleaseAssetName,
  compareReleaseVersions,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  resolveReleasePlatform,
} from "../src/contract";

describe("release contract", () => {
  test("normalizes release versions and tags", () => {
    expect(normalizeReleaseVersion(" v1.2.3 ")).toBe("1.2.3");
    expect(normalizeReleaseTag("1.2.3")).toBe("v1.2.3");
    expect(normalizeReleaseTag("v1.2.3")).toBe("v1.2.3");
    expect(() => normalizeReleaseVersion(" ")).toThrow("Missing release version");
  });

  test("compares semantic versions including prereleases", () => {
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });

  test("resolves supported platforms and asset names", () => {
    expect(resolveReleasePlatform("linux", "amd64")).toEqual({ os: "linux", arch: "x64" });
    expect(resolveReleasePlatform("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(buildReleaseAssetName("link-cli", "1.2.3", { os: "linux", arch: "x64" })).toBe("link-cli-v1.2.3-linux-x64");
    expect(() => resolveReleasePlatform("win32", "x64")).toThrow("Unsupported platform");
  });
});

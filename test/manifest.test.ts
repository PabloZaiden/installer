import { describe, expect, test } from "bun:test";
import {
  createSingleBinaryManifest,
  normalizeInstallerManifest,
  parseInstallerManifestJson,
} from "../src/manifest";

describe("installer manifest", () => {
  test("parses and normalizes a multi-binary manifest", () => {
    const manifest = parseInstallerManifestJson(JSON.stringify({
      schemaVersion: 1,
      repo: "pablozaiden/ralpher",
      installDir: "$HOME/bin",
      binaries: [
        { name: "ralpher", assetPrefix: "ralpher", required: false },
        { name: "ralpher-cli" },
      ],
      checksums: { required: false },
      platforms: { linux: ["x64"], darwin: ["arm64"] },
    }));

    expect(normalizeInstallerManifest(manifest, "pablozaiden/fallback")).toEqual({
      schemaVersion: 1,
      repo: "pablozaiden/ralpher",
      installDir: "$HOME/bin",
      binaries: [
        { name: "ralpher", assetPrefix: "ralpher", required: false, postInstallMessage: undefined },
        { name: "ralpher-cli", assetPrefix: "ralpher-cli", required: true, postInstallMessage: undefined },
      ],
      checksums: { required: false, extension: ".sha256" },
      targets: ["linux-x64", "darwin-arm64"],
      postInstallMessage: undefined,
    });
  });

  test("creates a default single-binary manifest", () => {
    expect(createSingleBinaryManifest("pablozaiden/link", "link-cli").binaries).toEqual([
      { name: "link-cli", assetPrefix: "link-cli", required: true, postInstallMessage: undefined },
    ]);
  });

  test("rejects invalid manifests", () => {
    expect(() => parseInstallerManifestJson("{}")).toThrow("schemaVersion");
    expect(() => parseInstallerManifestJson(JSON.stringify({
      schemaVersion: 1,
      binaries: [],
    }))).toThrow("binaries must be a non-empty array");
  });
});

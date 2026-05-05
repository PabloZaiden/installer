# @pablozaiden/installer

Reusable installer, updater, and release tooling for GitHub-hosted Bun binaries.

This package factors out the shared behavior used by projects like `pablozaiden/link` and `pablozaiden/ralpher`:

- a generic one-line shell installer that can target a GitHub repository,
- a TypeScript updater library for installed CLI binaries,
- a reusable GitHub Actions workflow for release binary assets,
- an npm publishing workflow for this TypeScript-only package.

## Install this package

```bash
bun add @pablozaiden/installer
```

The package exports TypeScript source directly, following the same style as `@pablozaiden/terminatui`.

## Binary asset contract

All tools use the same release asset naming convention:

```text
<assetPrefix>-<tag>-<os>-<arch>
<assetPrefix>-<tag>-<os>-<arch>.sha256
```

Supported targets are:

| OS | Architectures |
| --- | --- |
| `linux` | `x64`, `arm64` |
| `darwin` | `x64`, `arm64` |

Tags may be provided as `1.2.3` or `v1.2.3`; release assets are always resolved with the `v` tag form published by GitHub releases.

## Generic one-line installer

Use the installer directly from this repository:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh | sh -s -- pablozaiden/link
```

The target repository should publish an installer manifest at either:

- `.github/installer.json`
- `.installer.json`

The installer:

1. Detects Linux/macOS and x64/arm64.
2. Loads the target repository's manifest.
3. Fetches the latest GitHub release.
4. Downloads each configured binary asset.
5. Verifies `.sha256` checksums by default.
6. Installs binaries into `$HOME/.local/bin` unless overridden.
7. Prints PATH guidance if the install directory is not on `PATH`.

### Manifest schema

Single-binary example for Link:

```json
{
  "schemaVersion": 1,
  "repo": "pablozaiden/link",
  "installDir": "$HOME/.local/bin",
  "binaries": [
    {
      "name": "link-cli",
      "assetPrefix": "link-cli",
      "postInstallMessage": "Run 'link-cli web' to start Link."
    }
  ],
  "checksums": {
    "required": true,
    "extension": ".sha256"
  },
  "platforms": {
    "linux": ["x64", "arm64"],
    "darwin": ["x64", "arm64"]
  }
}
```

Multi-binary example for Ralpher:

```json
{
  "schemaVersion": 1,
  "repo": "pablozaiden/ralpher",
  "installDir": "$HOME/.local/bin",
  "binaries": [
    {
      "name": "ralpher",
      "assetPrefix": "ralpher",
      "postInstallMessage": "Run 'ralpher' to start the local server."
    },
    {
      "name": "ralpher-cli",
      "assetPrefix": "ralpher-cli",
      "postInstallMessage": "Run 'ralpher-cli --help' to use the API client."
    }
  ],
  "checksums": {
    "required": false,
    "extension": ".sha256"
  }
}
```

`checksums.required` should be `true` for new projects. Use `false` only while migrating existing projects that do not yet publish checksum assets.

### Installer fallback options

For projects without a manifest, pass binaries explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/link --binary link-cli
```

Useful options:

```text
--ref <ref>                  Repository ref to read manifests from
--binary <name>              Binary name when no manifest is available
--asset-prefix <prefix>      Asset prefix for the most recent --binary
--install-dir <dir>          Install directory
--checksum required|optional|none
```

## TypeScript updater library

Use `runUpdateCommand` from an installed binary's `update` command.

```ts
import { runUpdateCommand } from "@pablozaiden/installer";
import { LINK_VERSION } from "./version";

export async function runCliCommand(command: { kind: string; checkOnly?: boolean; version?: string }) {
  if (command.kind === "update") {
    return await runUpdateCommand(
      {
        checkOnly: command.checkOnly ?? false,
        version: command.version,
      },
      {
        repository: "pablozaiden/link",
        binaryName: "link-cli",
        currentVersion: LINK_VERSION,
        productName: "Link",
        checksum: { required: true },
      },
    );
  }
}
```

For a CLI with a companion binary installed beside it:

```ts
import { runUpdateCommand } from "@pablozaiden/installer";
import { RALPHER_VERSION } from "./version";

await runUpdateCommand(
  {
    checkOnly: false,
    version: undefined,
  },
  {
    repository: "pablozaiden/ralpher",
    binaryName: "ralpher-cli",
    currentVersion: RALPHER_VERSION,
    productName: "Ralpher",
    checksum: { required: false },
    companionBinaries: [
      {
        binaryName: "ralpher",
        assetPrefix: "ralpher",
        required: false
      }
    ],
  },
);
```

The updater supports:

- latest release checks,
- explicit version installs,
- semver comparison including prereleases,
- GitHub release metadata validation,
- Linux/macOS x64/arm64 target resolution,
- checksum verification before replacement,
- source-mode rejection when running from `bun`,
- atomic temp-file replacement with executable permission preservation,
- optional companion binary updates.

Exported helpers include:

```ts
import {
  buildReleaseAssetName,
  compareReleaseVersions,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  parseInstallerManifestJson,
  resolveReleasePlatform,
  runUpdateCommand,
} from "@pablozaiden/installer";
```

## Reusable binary release workflow

In a consuming repository, add a workflow like:

```yaml
name: Build and Release Binaries

on:
  release:
    types: [published]

jobs:
  binaries:
    uses: pablozaiden/installer/.github/workflows/reusable-binary-release.yml@main
    permissions:
      contents: write
    with:
      prebuild_command: bun run build
      binaries: |
        [
          {
            "name": "link-cli",
            "asset_prefix": "link-cli",
            "build_command": "bun run build-binary.ts --target=$BUN_TARGET --outfile=$ASSET_PATH",
            "output_path": "$ASSET_PATH"
          }
        ]
```

For a project with multiple binaries:

```yaml
jobs:
  binaries:
    uses: pablozaiden/installer/.github/workflows/reusable-binary-release.yml@main
    permissions:
      contents: write
    with:
      prebuild_command: bun run build
      binaries: |
        [
          {
            "name": "ralpher",
            "asset_prefix": "ralpher",
            "build_command": "cd apps/server && bun src/build.ts --target=$BUN_TARGET",
            "output_path": "apps/server/dist/ralpher-$RELEASE_TARGET"
          },
          {
            "name": "ralpher-cli",
            "asset_prefix": "ralpher-cli",
            "build_command": "cd apps/cli && bun src/build.ts --target=$BUN_TARGET",
            "output_path": "apps/cli/dist/ralpher-cli-$RELEASE_TARGET"
          }
        ]
```

The workflow:

- runs on GitHub release publication,
- builds `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`,
- exports `TAG`, `VERSION`, `RELEASE_TARGET`, `BUN_TARGET`, `BINARY_NAME`, `ASSET_PREFIX`, and `ASSET_PATH` to each build command,
- stages release assets using the shared naming convention,
- generates `.sha256` files by default,
- uploads workflow artifacts and GitHub release assets.

## Publishing this package to npm

This repository includes `.github/workflows/release-npm-package.yml`.

On a published GitHub release, it:

1. Derives the npm version from the release tag.
2. Updates `package.json`.
3. Verifies the version.
4. Runs `bun install --frozen-lockfile`.
5. Runs `bun run build`.
6. Runs `bun test`.
7. Publishes `@pablozaiden/installer` with npm provenance.

Manual `workflow_dispatch` publishes with the `unstable` tag.

## Migration guide: Link

1. Add `.github/installer.json` using the single-binary manifest above.
2. Replace `src/server/update.ts` logic with a thin wrapper around `runUpdateCommand`.
3. Keep Link's command parser and `LINK_VERSION`; pass them into the updater config.
4. Replace `.github/workflows/binary-release.yml` with a caller workflow that uses `reusable-binary-release.yml`.
5. Keep checksum publication enabled.
6. Optionally update the README one-liner to point at `pablozaiden/installer`.

## Migration guide: Ralpher

1. Add `.github/installer.json` using the multi-binary manifest above.
2. Decide whether to publish checksums immediately. If not, use `checksums.required: false` temporarily.
3. Replace `src/cli/update.ts` logic with `runUpdateCommand` configured with `binaryName: "ralpher-cli"` and `companionBinaries: [{ binaryName: "ralpher" }]`.
4. Replace `.github/workflows/binary-release.yml` with a caller workflow that builds both server and CLI binaries.
5. Once checksum assets are published, switch installer/updater checksum policy to required.
6. Optionally update the README one-liner to point at `pablozaiden/installer`.

## Development

```bash
bun install
bun run build
bun test
```

Shell syntax for the installer is covered by tests and can be checked directly:

```bash
sh -n install.sh
```

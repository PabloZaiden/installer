# @pablozaiden/installer

Reusable installer, updater, and release tooling for GitHub-hosted Bun binaries.

## Install this package

```bash
bun add @pablozaiden/installer
```

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

Single-binary example:

```json
{
  "schemaVersion": 1,
  "repo": "pablozaiden/myproject",
  "installDir": "$HOME/.local/bin",
  "binaries": [
    {
      "name": "myproject-cli",
      "assetPrefix": "myproject-cli",
      "postInstallMessage": "Run 'myproject-cli' to start MyProject."
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

Multi-binary example:

```json
{
  "schemaVersion": 1,
  "repo": "pablozaiden/myproject",
  "installDir": "$HOME/.local/bin",
  "binaries": [
    {
      "name": "myproject",
      "assetPrefix": "myproject",
      "postInstallMessage": "Run 'myproject' to start the local server."
    },
    {
      "name": "myproject-cli",
      "assetPrefix": "myproject-cli",
      "postInstallMessage": "Run 'myproject-cli --help' to use the API client."
    }
  ],
  "checksums": {
    "required": true,
    "extension": ".sha256"
  }
}
```

`checksums.required` should be `true` for new projects. Use `false` only while migrating existing projects that do not yet publish checksum assets.
The shell installer supports manifest `schemaVersion: 1` and fails before reading other manifest fields if a future schema version is provided.

### Installer fallback options

For projects without a manifest, pass binaries explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/myproject --binary myproject-cli
```

Useful options:

```text
--ref <ref>                  Repository ref to read manifests from
--binary <name>              Binary name when no manifest is available
--asset-prefix <prefix>      Asset prefix for the most recent --binary
--install-dir <dir>          Install directory
--checksum required|optional|none
```

`--checksum none` disables checksum downloads and verification entirely. `optional` attempts checksum verification when the checksum asset exists, while `required` fails if the checksum cannot be downloaded or verified.

## TypeScript updater library

Use `runUpdateCommand` from an installed binary's `update` command.

```ts
import { runUpdateCommand } from "@pablozaiden/installer";
import { MYPROJECT_VERSION } from "./version";

export async function runCliCommand(command: { kind: string; checkOnly?: boolean; version?: string }) {
  if (command.kind === "update") {
    return await runUpdateCommand(
      {
        checkOnly: command.checkOnly ?? false,
        version: command.version,
      },
      {
        repository: "pablozaiden/myproject",
        binaryName: "myproject-cli",
        currentVersion: MYPROJECT_VERSION,
        productName: "MyProject",
        checksum: { required: true },
      },
    );
  }
}
```

For a CLI with a companion binary installed beside it:

```ts
import { runUpdateCommand } from "@pablozaiden/installer";
import { MYPROJECT_VERSION } from "./version";

await runUpdateCommand(
  {
    checkOnly: false,
    version: undefined,
  },
  {
    repository: "pablozaiden/myproject",
    binaryName: "myproject-cli",
    currentVersion: MYPROJECT_VERSION,
    productName: "MyProject",
    checksum: { required: false },
    companionBinaries: [
      {
        binaryName: "myproject",
        assetPrefix: "myproject",
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
- staged temp-file replacement with executable permission preservation,
- companion binary updates that are committed together with the primary binary and rolled back on replacement failure.

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
            "name": "myproject-cli",
            "asset_prefix": "myproject-cli",
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
            "name": "myproject",
            "asset_prefix": "myproject",
            "build_command": "cd apps/server && bun src/build.ts --target=$BUN_TARGET",
            "output_path": "apps/server/dist/myproject-$RELEASE_TARGET"
          },
          {
            "name": "myproject-cli",
            "asset_prefix": "myproject-cli",
            "build_command": "cd apps/cli && bun src/build.ts --target=$BUN_TARGET",
            "output_path": "apps/cli/dist/myproject-cli-$RELEASE_TARGET"
          }
        ]
```

The workflow:

- runs on GitHub release publication,
- builds `linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`,
- exports `TAG`, `VERSION`, `RELEASE_TARGET`, `BUN_TARGET`, `BINARY_NAME`, `ASSET_PREFIX`, and `ASSET_PATH` to each build command,
- stages release assets using the shared naming convention,
- generates `.sha256` files by default,
- uploads matrix artifacts first, then publishes GitHub release assets only after all matrix builds succeed.

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

## Development

```bash
bun install
bun run build
bun test
```

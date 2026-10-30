# Release channels

New installations default to the latest **stable** GitHub release. Opt in to
the rolling main build with `install.sh owner/repo --channel latest`.

Applications using the updater expose `update --channel latest` and
`update --channel stable` to change channels. Plain `update` and `update --check`
follow latest when the installed version contains `-main-`; stable builds
continue to use stable. `UpdaterConfig.channel` can set an application default,
and `UpdateCommandOptions.channel` explicitly overrides it. A channel cannot
be combined with an exact version or prerelease selection.

## Application workflows

Call `reusable-binary-release.yml` on published versioned releases and pushes
to main. Pass `release_channel: latest` for main builds and `stable` for
versioned releases. Pin the reusable workflow to an installer commit.

The workflow resolves one version for the whole target matrix, updates the
application package version before building, and retains signing/checksums.
Targets sharing the same `os` runner label are compiled sequentially in one
job. Checkout, dependency installation, package-version update and
`prebuild_command` run once per runner, not once per target. The default targets
use one `ubuntu-latest` job for Linux x64 and arm64 and one
`macos-latest` job for Darwin x64 and arm64. The macOS default runner is ARM64;
cross-compilation produces the x64 binary on that same host. Custom target
lists keep the existing `{os, target, bun_target}` format; `os` identifies the
execution host, not necessarily the binary's target OS.

Each target build receives its own `RELEASE_TARGET` and `BUN_TARGET`.
Use `dist/myproject-$RELEASE_TARGET` in `output_path`, or compile directly to
`$ASSET_PATH`. Release
assets are staged under the runner's temporary directory so later target
builds can clean their output directories without deleting earlier assets.
Both Darwin binaries retain optional certificate signing, with one signing
keychain setup and cleanup per macOS job. Metadata resolution and publication
remain separate jobs; this grouping does not replace native OS testing.

Main builds use `<next-patch>-main-<UTC-date-and-minute>-<short-sha>`, sharing
the existing build-version action with Docker builds. Do not disable
`update_package_version` for rolling builds: the embedded identity determines
their default update channel.

After all targets succeed, publication is serialized per channel with
`queue: max` so later completions do not replace pending publishers.
Superseded main commits are skipped. The single prerelease tagged `latest` is never
marked as GitHub's latest stable release. Its uniquely versioned binaries and
checksums are uploaded first, followed by `release.json`:

```json
{
  "schemaVersion": 1,
  "channel": "latest",
  "version": "1.2.4-main-2026-10-25-18-01-abcdef1",
  "revision": "abcdef1234567890123456789012345678901234"
}
```

Readers resolve that build version, rather than comparing the literal tag
`latest`. Old rolling assets are removed after the metadata switches.
Workflow artifacts used to transfer binaries between jobs expire after one
day; GitHub releases remain the distribution boundary.
Downloads already in flight may fail safely during replacement and can be
rerun; checksum verification must remain enabled. Versioned releases are not
deleted. This adds no unattended background updates or process restarts.

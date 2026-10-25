# Release channels

New installations default to the latest **stable** GitHub release. Opt in to
the rolling main build with `install.sh owner/repo --channel latest`, or
`install.ps1 owner/repo -Channel latest` on Windows.

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
Main builds use `<next-patch>-main-<UTC-date-and-minute>-<short-sha>`, sharing
the existing build-version action with Docker builds. Do not disable
`update_package_version` for rolling builds: the embedded identity determines
their default update channel.

After all targets succeed, publication is serialized per channel. Superseded
main commits are skipped. The single prerelease tagged `latest` is never
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

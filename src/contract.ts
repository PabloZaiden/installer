export const DEFAULT_INSTALL_DIR = "$HOME/.local/bin";
export const DEFAULT_CHECKSUM_EXTENSION = ".sha256";
export const DEFAULT_INSTALLER_MANIFEST_PATHS = [
  ".github/installer.json",
  ".installer.json",
] as const;
export const DEFAULT_GITHUB_API_VERSION = "2022-11-28";

export const SUPPORTED_RELEASE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;

export type ReleaseOs = "linux" | "darwin";
export type ReleaseArch = "x64" | "arm64";
export type ReleaseTarget = `${ReleaseOs}-${ReleaseArch}`;

export type ReleasePlatform = {
  os: ReleaseOs;
  arch: ReleaseArch;
};

export type GitHubRepository = `${string}/${string}`;

export function normalizeReleaseVersion(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Missing release version.");
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function normalizeReleaseTag(rawValue: string): string {
  return `v${normalizeReleaseVersion(rawValue)}`;
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion | null {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalizeReleaseVersion(value));
  if (!parsed) {
    return null;
  }

  return {
    major: Number(parsed[1]),
    minor: Number(parsed[2]),
    patch: Number(parsed[3]),
    prerelease: parsed[4]?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    return normalizeReleaseVersion(left).localeCompare(normalizeReleaseVersion(right));
  }

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }

  const leftHasPrerelease = leftVersion.prerelease.length > 0;
  const rightHasPrerelease = rightVersion.prerelease.length > 0;
  if (!leftHasPrerelease && !rightHasPrerelease) {
    return 0;
  }
  if (!leftHasPrerelease) {
    return 1;
  }
  if (!rightHasPrerelease) {
    return -1;
  }
  return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease);
}

export function releasePlatformToTarget(platform: ReleasePlatform): ReleaseTarget {
  return `${platform.os}-${platform.arch}`;
}

export function parseReleaseTarget(target: string): ReleasePlatform {
  const [os, arch] = target.split("-");
  if (!os || !arch) {
    throw new Error(`Invalid release target "${target}". Expected <os>-<arch>.`);
  }
  return resolveReleasePlatform(os, arch);
}

export function resolveReleasePlatform(platform: string, arch: string): ReleasePlatform {
  const os = platform === "linux" || platform === "darwin" ? platform : undefined;
  const normalizedArch = arch === "x64" || arch === "amd64"
    ? "x64"
    : arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : undefined;

  if (os && normalizedArch) {
    return {
      os,
      arch: normalizedArch,
    };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}. Supported release targets are Linux and macOS on x64 and arm64.`);
}

export function buildReleaseAssetName(assetPrefix: string, tag: string, target: ReleasePlatform): string {
  return `${assetPrefix}-${normalizeReleaseTag(tag)}-${target.os}-${target.arch}`;
}

export function assertGitHubRepository(value: string): GitHubRepository {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Invalid GitHub repository "${value}". Expected <owner>/<repo>.`);
  }
  return value as GitHubRepository;
}

export function githubApiRepositoryUrl(repository: GitHubRepository): string {
  return `https://api.github.com/repos/${repository}`;
}

export function githubRawRepositoryUrl(repository: GitHubRepository, ref = "main"): string {
  return `https://raw.githubusercontent.com/${repository}/${ref}`;
}

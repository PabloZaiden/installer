import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_CHECKSUM_EXTENSION,
  DEFAULT_GITHUB_API_VERSION,
  assertGitHubRepository,
  buildReleaseAssetName,
  compareReleaseVersions,
  githubApiRepositoryUrl,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  resolveReleasePlatform,
  type GitHubRepository,
  type ReleasePlatform,
} from "./contract";

export type UpdateCommandOptions = {
  checkOnly: boolean;
  version?: string;
};

export type UpdaterChecksumPolicy = {
  required: boolean;
  extension?: string;
};

export type UpdaterCompanionBinary = {
  binaryName: string;
  assetPrefix?: string;
  required?: boolean;
};

export type UpdaterConfig = {
  repository: GitHubRepository | string;
  binaryName: string;
  currentVersion: string;
  productName?: string;
  assetPrefix?: string;
  checksum?: UpdaterChecksumPolicy;
  companionBinaries?: UpdaterCompanionBinary[];
  tempDirectoryPrefix?: string;
  userAgent?: string;
};

type WritableBinaryContent = Uint8Array | string;

export type UpdaterDependencies = {
  fetchFn: typeof fetch;
  out: (message: string) => void;
  err: (message: string) => void;
  getPlatform: () => {
    platform: string;
    arch: string;
  };
  getExecutablePath: () => string;
  resolveRealPath: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  createTempDirectory: (targetDirectory: string, prefix: string) => Promise<string>;
  writeBinary: (path: string, content: WritableBinaryContent) => Promise<void>;
  chmodFile: (path: string, mode: number) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  statFile: (path: string) => Promise<{ mode: number }>;
};

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export type ResolvedReleaseAsset = {
  binaryName: string;
  version: string;
  assetName: string;
  downloadUrl: string;
  checksumAssetName: string;
  checksumDownloadUrl?: string;
};

type InstalledBinaryTarget = {
  binaryName: string;
  assetPrefix: string;
  targetPath: string;
  required: boolean;
};

type StagedBinaryReplacement = {
  target: InstalledBinaryTarget;
  asset: ResolvedReleaseAsset;
  tempDirectory: string;
  tempPath: string;
  backupPath: string;
};

function createDefaultUpdateDependencies(): UpdaterDependencies {
  return {
    fetchFn: fetch,
    out: console.log,
    err: console.error,
    getPlatform: () => ({
      platform: process.platform,
      arch: process.arch,
    }),
    getExecutablePath: () => process.execPath,
    resolveRealPath: async path => await realpath(path),
    fileExists: async path => await Bun.file(path).exists(),
    createTempDirectory: async (targetDirectory, prefix) => await mkdtemp(join(targetDirectory, prefix)),
    writeBinary: async (path, content) => {
      await Bun.write(path, content);
    },
    chmodFile: async (path, mode) => {
      await chmod(path, mode);
    },
    renameFile: async (from, to) => {
      await rename(from, to);
    },
    removeFile: async path => {
      await rm(path, { force: true, recursive: true });
    },
    statFile: async path => {
      const result = await stat(path);
      return { mode: result.mode };
    },
  };
}

function assertReleaseAsset(value: unknown, index: number): GitHubReleaseAsset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`release.assets[${index}] must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["name"] !== "string" || raw["name"] === "") {
    throw new Error(`release.assets[${index}].name must be a non-empty string.`);
  }
  if (typeof raw["browser_download_url"] !== "string" || raw["browser_download_url"] === "") {
    throw new Error(`release.assets[${index}].browser_download_url must be a non-empty string.`);
  }
  return {
    name: raw["name"],
    browser_download_url: raw["browser_download_url"],
  };
}

export function parseGitHubRelease(value: unknown): GitHubRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("release must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["tag_name"] !== "string" || raw["tag_name"] === "") {
    throw new Error("release.tag_name must be a non-empty string.");
  }
  if (!Array.isArray(raw["assets"])) {
    throw new Error("release.assets must be an array.");
  }
  return {
    tag_name: raw["tag_name"],
    assets: raw["assets"].map(assertReleaseAsset),
  };
}

export async function fetchGitHubRelease(
  config: UpdaterConfig,
  command: Pick<UpdateCommandOptions, "version">,
  dependencies: Pick<UpdaterDependencies, "fetchFn" | "out">,
): Promise<GitHubRelease> {
  const repository = assertGitHubRepository(config.repository);
  const tag = command.version ? normalizeReleaseTag(command.version) : undefined;
  const releaseUrl = tag
    ? `${githubApiRepositoryUrl(repository)}/releases/tags/${tag}`
    : `${githubApiRepositoryUrl(repository)}/releases/latest`;
  dependencies.out(tag ? `Fetching release metadata for ${tag}...` : "Fetching release metadata...");
  const response = await dependencies.fetchFn(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": config.userAgent ?? `${config.binaryName}-updater`,
      "x-github-api-version": DEFAULT_GITHUB_API_VERSION,
    },
  });

  if (response.status === 404 && tag) {
    throw new Error(`Release not found: ${tag}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to load release metadata: GitHub returned ${String(response.status)}.`);
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new Error(`Failed to parse release metadata: ${String(error)}`);
  }
  return parseGitHubRelease(rawBody);
}

export function resolveReleaseAsset(
  release: GitHubRelease,
  target: ReleasePlatform,
  config: Pick<UpdaterConfig, "binaryName" | "assetPrefix" | "checksum">,
): ResolvedReleaseAsset {
  const assetPrefix = config.assetPrefix ?? config.binaryName;
  const checksumExtension = config.checksum?.extension ?? DEFAULT_CHECKSUM_EXTENSION;
  const assetName = buildReleaseAssetName(assetPrefix, release.tag_name, target);
  const checksumAssetName = `${assetName}${checksumExtension}`;
  const asset = release.assets.find(entry => entry.name === assetName);
  if (!asset) {
    throw new Error(`Release ${release.tag_name} does not include asset ${assetName}.`);
  }
  const checksumAsset = release.assets.find(entry => entry.name === checksumAssetName);

  return {
    binaryName: config.binaryName,
    version: normalizeReleaseVersion(release.tag_name),
    assetName,
    downloadUrl: asset.browser_download_url,
    checksumAssetName,
    checksumDownloadUrl: checksumAsset?.browser_download_url,
  };
}

function formatCheckMessage(binaryName: string, currentVersion: string, targetVersion: string): string {
  const comparison = compareReleaseVersions(currentVersion, targetVersion);
  if (comparison === 0) {
    return `${binaryName} ${currentVersion} is up to date.`;
  }
  if (comparison > 0) {
    return `${binaryName} ${currentVersion} is newer than the latest published release ${targetVersion}.`;
  }
  return `Update available: ${currentVersion} -> ${targetVersion}`;
}

function toPermissionMessage(productName: string, path: string, error: unknown): Error {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Cannot update ${path}: permission denied. Re-run with permission to modify the installed binary or use the installer script.`,
    );
  }
  if (code === "EBUSY" || code === "ETXTBSY") {
    return new Error(`Cannot update ${path}: the binary is currently in use. Stop any running ${productName} process and try again.`);
  }
  return new Error(`Failed to update ${path}: ${String(error)}`);
}

export function parseExpectedSha256(checksumText: string, assetName: string): string {
  const plainHashes: string[] = [];

  for (const rawLine of checksumText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const [hash, ...fileParts] = line.split(/\s+/);
    if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) {
      continue;
    }
    const normalizedHash = hash.toLowerCase();
    const fileName = fileParts.join(" ").replace(/^\*/, "");
    if (fileName) {
      if (basename(fileName) === assetName) {
        return normalizedHash;
      }
      continue;
    }
    plainHashes.push(normalizedHash);
  }

  if (plainHashes.length === 1) {
    return plainHashes[0]!;
  }
  throw new Error(`Checksum for ${assetName} did not contain a valid SHA-256 entry.`);
}

export async function verifyReleaseAssetChecksum(
  asset: ResolvedReleaseAsset,
  payload: Uint8Array,
  checksumPolicy: Required<UpdaterChecksumPolicy>,
  dependencies: Pick<UpdaterDependencies, "fetchFn" | "out">,
): Promise<void> {
  if (!asset.checksumDownloadUrl) {
    if (checksumPolicy.required) {
      throw new Error(`Release asset ${asset.checksumAssetName} is required to verify ${asset.assetName}.`);
    }
    dependencies.out(`Skipping checksum verification for ${asset.assetName}; ${asset.checksumAssetName} was not published.`);
    return;
  }

  dependencies.out(`Downloading ${asset.checksumAssetName}...`);
  const response = await dependencies.fetchFn(asset.checksumDownloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${asset.checksumAssetName}: GitHub returned ${String(response.status)}.`);
  }

  const expected = parseExpectedSha256(await response.text(), asset.assetName);
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum verification failed for ${asset.assetName}: expected ${expected}, got ${actual}.`);
  }
  dependencies.out(`Verified checksum for ${asset.assetName}.`);
}

async function resolveInstalledBinaryPath(binaryName: string, productName: string, dependencies: UpdaterDependencies): Promise<string> {
  const executablePath = dependencies.getExecutablePath();
  const executableName = basename(executablePath);
  if (executableName === "bun" || executableName.startsWith("bun-")) {
    throw new Error(`${binaryName} update only works from an installed ${productName} binary. Use the installer script when running from source.`);
  }
  const resolvedPath = await dependencies.resolveRealPath(executablePath);
  if (!(await dependencies.fileExists(resolvedPath))) {
    throw new Error(`Installed binary does not exist: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function stageInstalledBinaryReplacement(
  target: InstalledBinaryTarget,
  asset: ResolvedReleaseAsset,
  config: UpdaterConfig,
  checksumPolicy: Required<UpdaterChecksumPolicy>,
  dependencies: UpdaterDependencies,
): Promise<StagedBinaryReplacement> {
  const targetPath = target.targetPath;
  let tempDirectory: string | undefined;
  let tempPath: string | undefined;
  let tempCreated = false;
  let staged = false;

  try {
    tempDirectory = await dependencies.createTempDirectory(dirname(targetPath), config.tempDirectoryPrefix ?? `.${config.binaryName}-update-`);
    tempPath = join(tempDirectory, asset.assetName);
    dependencies.out(`Downloading ${asset.assetName}...`);
    const response = await dependencies.fetchFn(asset.downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.assetName}: GitHub returned ${String(response.status)}.`);
    }

    const payload = new Uint8Array(await response.arrayBuffer());
    await verifyReleaseAssetChecksum(asset, payload, checksumPolicy, dependencies);
    await dependencies.writeBinary(tempPath, payload);
    tempCreated = true;

    const installedBinaryStat = await dependencies.statFile(targetPath);
    const executableMode = installedBinaryStat.mode & 0o777;
    await dependencies.chmodFile(tempPath, executableMode || 0o755);
    staged = true;
    return {
      target,
      asset,
      tempDirectory,
      tempPath,
      backupPath: join(tempDirectory, `${basename(targetPath)}.backup`),
    };
  } catch (error) {
    throw toPermissionMessage(config.productName ?? config.binaryName, targetPath, error);
  } finally {
    if (!staged) {
      if (tempPath) {
        await dependencies.removeFile(tempPath);
      }
      if (tempDirectory) {
        await dependencies.removeFile(tempDirectory);
      }
    }
  }
}

async function cleanupStagedBinaryReplacements(
  stagedReplacements: StagedBinaryReplacement[],
  dependencies: Pick<UpdaterDependencies, "removeFile">,
): Promise<void> {
  for (const staged of stagedReplacements) {
    await dependencies.removeFile(staged.tempDirectory);
  }
}

async function replaceStagedBinaryReplacements(
  stagedReplacements: StagedBinaryReplacement[],
  config: UpdaterConfig,
  dependencies: UpdaterDependencies,
): Promise<void> {
  const movedBackups: StagedBinaryReplacement[] = [];
  const installedReplacements: StagedBinaryReplacement[] = [];

  try {
    for (const staged of stagedReplacements) {
      dependencies.out(`Replacing ${staged.target.targetPath}...`);
      await dependencies.renameFile(staged.target.targetPath, staged.backupPath);
      movedBackups.push(staged);
      await dependencies.renameFile(staged.tempPath, staged.target.targetPath);
      installedReplacements.push(staged);
    }
  } catch (error) {
    for (const staged of installedReplacements.reverse()) {
      await dependencies.removeFile(staged.target.targetPath);
    }
    for (const staged of movedBackups.reverse()) {
      await dependencies.renameFile(staged.backupPath, staged.target.targetPath);
    }
    throw toPermissionMessage(config.productName ?? config.binaryName, config.binaryName, error);
  }
}

async function resolveInstalledBinaryTargets(config: UpdaterConfig, dependencies: UpdaterDependencies): Promise<InstalledBinaryTarget[]> {
  const primaryPath = await resolveInstalledBinaryPath(config.binaryName, config.productName ?? config.binaryName, dependencies);
  const targets: InstalledBinaryTarget[] = [];
  for (const companion of config.companionBinaries ?? []) {
    const companionPath = join(dirname(primaryPath), companion.binaryName);
    if (await dependencies.fileExists(companionPath)) {
      targets.push({
        binaryName: companion.binaryName,
        assetPrefix: companion.assetPrefix ?? companion.binaryName,
        targetPath: companionPath,
        required: companion.required ?? false,
      });
    } else if (companion.required) {
      throw new Error(`Required companion binary does not exist: ${companionPath}`);
    }
  }
  targets.push({
    binaryName: config.binaryName,
    assetPrefix: config.assetPrefix ?? config.binaryName,
    targetPath: primaryPath,
    required: true,
  });
  return targets;
}

export async function runUpdateCommand(
  command: UpdateCommandOptions,
  config: UpdaterConfig,
  dependencyOverrides: Partial<UpdaterDependencies> = {},
): Promise<number> {
  const dependencies = {
    ...createDefaultUpdateDependencies(),
    ...dependencyOverrides,
  };
  const normalizedConfig = {
    ...config,
    repository: assertGitHubRepository(config.repository),
  };
  const checksumPolicy = {
    required: normalizedConfig.checksum?.required ?? true,
    extension: normalizedConfig.checksum?.extension ?? DEFAULT_CHECKSUM_EXTENSION,
  };
  const currentVersion = normalizeReleaseVersion(normalizedConfig.currentVersion);
  const release = await fetchGitHubRelease(normalizedConfig, command, dependencies);
  const runtimePlatform = dependencies.getPlatform();
  const releasePlatform = resolveReleasePlatform(runtimePlatform.platform, runtimePlatform.arch);
  const primaryAsset = resolveReleaseAsset(release, releasePlatform, {
    binaryName: normalizedConfig.binaryName,
    assetPrefix: normalizedConfig.assetPrefix,
    checksum: checksumPolicy,
  });

  if (command.checkOnly) {
    dependencies.out(formatCheckMessage(normalizedConfig.binaryName, currentVersion, primaryAsset.version));
    return 0;
  }

  if (!command.version && compareReleaseVersions(currentVersion, primaryAsset.version) >= 0) {
    dependencies.out(formatCheckMessage(normalizedConfig.binaryName, currentVersion, primaryAsset.version));
    return 0;
  }

  if (command.version && compareReleaseVersions(currentVersion, primaryAsset.version) === 0) {
    dependencies.out(`${normalizedConfig.binaryName} ${currentVersion} is already installed.`);
    return 0;
  }

  const stagedReplacements: StagedBinaryReplacement[] = [];
  try {
    const installedTargets = await resolveInstalledBinaryTargets(normalizedConfig, dependencies);
    for (const target of installedTargets) {
      const asset = resolveReleaseAsset(release, releasePlatform, {
        binaryName: target.binaryName,
        assetPrefix: target.assetPrefix,
        checksum: checksumPolicy,
      });
      stagedReplacements.push(await stageInstalledBinaryReplacement(target, asset, normalizedConfig, checksumPolicy, dependencies));
    }

    await replaceStagedBinaryReplacements(stagedReplacements, normalizedConfig, dependencies);

    for (const { target, asset } of stagedReplacements) {
      if (command.version) {
        dependencies.out(`Installed ${target.binaryName} ${asset.version} at ${target.targetPath}.`);
      } else {
        dependencies.out(`Updated ${target.binaryName} ${currentVersion} -> ${asset.version} at ${target.targetPath}.`);
      }
    }
  } finally {
    await cleanupStagedBinaryReplacements(stagedReplacements, dependencies);
  }

  return 0;
}

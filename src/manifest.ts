import {
  DEFAULT_CHECKSUM_EXTENSION,
  DEFAULT_INSTALL_DIR,
  DEFAULT_INSTALLER_MANIFEST_PATHS,
  SUPPORTED_RELEASE_TARGETS,
  assertGitHubRepository,
  type GitHubRepository,
  type ReleaseTarget,
} from "./contract";

export type InstallerManifestBinary = {
  name: string;
  assetPrefix?: string;
  required?: boolean;
  postInstallMessage?: string;
};

export type InstallerChecksumPolicy = {
  required: boolean;
  extension?: string;
};

export type InstallerManifest = {
  schemaVersion: 1;
  repo?: GitHubRepository;
  installDir?: string;
  binaries: InstallerManifestBinary[];
  checksums?: InstallerChecksumPolicy;
  platforms?: Partial<Record<"linux" | "darwin", Array<"x64" | "arm64">>>;
  postInstallMessage?: string;
};

export type NormalizedInstallerBinary = {
  name: string;
  assetPrefix: string;
  required: boolean;
  postInstallMessage?: string;
};

export type NormalizedInstallerManifest = {
  schemaVersion: 1;
  repo: GitHubRepository;
  installDir: string;
  binaries: NormalizedInstallerBinary[];
  checksums: Required<InstallerChecksumPolicy>;
  targets: ReleaseTarget[];
  postInstallMessage?: string;
};

export const DEFAULT_MANIFEST_PATHS = DEFAULT_INSTALLER_MANIFEST_PATHS;

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectBoolean(value, label);
}

function parseBinary(value: unknown, index: number): InstallerManifestBinary {
  const raw = expectObject(value, `binaries[${index}]`);
  return {
    name: expectString(raw["name"], `binaries[${index}].name`),
    assetPrefix: optionalString(raw["assetPrefix"], `binaries[${index}].assetPrefix`),
    required: optionalBoolean(raw["required"], `binaries[${index}].required`),
    postInstallMessage: optionalString(raw["postInstallMessage"], `binaries[${index}].postInstallMessage`),
  };
}

function parseBinaries(value: unknown): InstallerManifestBinary[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("binaries must be a non-empty array.");
  }
  return value.map(parseBinary);
}

function parseChecksums(value: unknown): InstallerChecksumPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = expectObject(value, "checksums");
  return {
    required: expectBoolean(raw["required"], "checksums.required"),
    extension: optionalString(raw["extension"], "checksums.extension"),
  };
}

function parsePlatforms(value: unknown): InstallerManifest["platforms"] {
  if (value === undefined) {
    return undefined;
  }
  const raw = expectObject(value, "platforms");
  const platforms: InstallerManifest["platforms"] = {};
  for (const os of ["linux", "darwin"] as const) {
    const arches = raw[os];
    if (arches === undefined) {
      continue;
    }
    if (!Array.isArray(arches)) {
      throw new Error(`platforms.${os} must be an array.`);
    }
    platforms[os] = arches.map((arch, index) => {
      if (arch !== "x64" && arch !== "arm64") {
        throw new Error(`platforms.${os}[${index}] must be "x64" or "arm64".`);
      }
      return arch;
    });
  }
  return platforms;
}

export function parseInstallerManifest(value: unknown): InstallerManifest {
  const raw = expectObject(value, "manifest");
  if (raw["schemaVersion"] !== 1) {
    throw new Error("manifest.schemaVersion must be 1.");
  }
  const repo = raw["repo"] === undefined ? undefined : assertGitHubRepository(expectString(raw["repo"], "repo"));
  return {
    schemaVersion: 1,
    repo,
    installDir: optionalString(raw["installDir"], "installDir"),
    binaries: parseBinaries(raw["binaries"]),
    checksums: parseChecksums(raw["checksums"]),
    platforms: parsePlatforms(raw["platforms"]),
    postInstallMessage: optionalString(raw["postInstallMessage"], "postInstallMessage"),
  };
}

export function parseInstallerManifestJson(json: string): InstallerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid installer manifest JSON: ${String(error)}`);
  }
  return parseInstallerManifest(parsed);
}

function normalizeTargets(platforms: InstallerManifest["platforms"]): ReleaseTarget[] {
  if (!platforms) {
    return [...SUPPORTED_RELEASE_TARGETS];
  }
  const targets: ReleaseTarget[] = [];
  for (const os of ["linux", "darwin"] as const) {
    for (const arch of platforms[os] ?? []) {
      targets.push(`${os}-${arch}`);
    }
  }
  if (targets.length === 0) {
    throw new Error("platforms must include at least one target.");
  }
  return targets;
}

export function normalizeInstallerManifest(
  manifest: InstallerManifest,
  fallbackRepository: GitHubRepository,
): NormalizedInstallerManifest {
  const repo = manifest.repo ?? fallbackRepository;
  return {
    schemaVersion: 1,
    repo,
    installDir: manifest.installDir ?? DEFAULT_INSTALL_DIR,
    binaries: manifest.binaries.map(binary => ({
      name: binary.name,
      assetPrefix: binary.assetPrefix ?? binary.name,
      required: binary.required ?? true,
      postInstallMessage: binary.postInstallMessage,
    })),
    checksums: {
      required: manifest.checksums?.required ?? true,
      extension: manifest.checksums?.extension ?? DEFAULT_CHECKSUM_EXTENSION,
    },
    targets: normalizeTargets(manifest.platforms),
    postInstallMessage: manifest.postInstallMessage,
  };
}

export function createSingleBinaryManifest(repository: string, binaryName: string): NormalizedInstallerManifest {
  const repo = assertGitHubRepository(repository);
  const name = expectString(binaryName, "binaryName");
  return normalizeInstallerManifest({
    schemaVersion: 1,
    repo,
    binaries: [{ name }],
  }, repo);
}

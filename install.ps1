[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Repository,
  [string]$Ref = "main",
  [string[]]$Binary = @(),
  [string[]]$AssetPrefix = @(),
  [string]$InstallDir,
  [ValidateSet("required", "optional", "none")]
  [string]$Checksum = "required",
  [switch]$NoModifyPath,
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InstallerVersion = "0.0.0-development"
$DefaultInstallDir = '$HOME/.local/bin'
$DefaultManifestPaths = @(".github/installer.json", ".installer.json")
$DefaultChecksumExtension = ".sha256"
$ChecksumWasSpecified = $PSBoundParameters.ContainsKey("Checksum")

function Show-Usage {
  @"
Usage:
  install.ps1 <owner>/<repo> [options]

Options:
  -Ref <ref>                  Repository ref used to read manifests (default: main)
  -Binary <name[]>            Binary names when no manifest is available
  -AssetPrefix <prefix[]>     Asset prefixes corresponding to -Binary values
  -InstallDir <dir>           Install directory (default: `$HOME/.local/bin)
  -Checksum required|optional|none
  -NoModifyPath               Do not add the install directory to the user PATH
  -Help                       Show this help
"@
}

function Fail([string]$Message) {
  [Console]::Error.WriteLine("Error: $Message")
  exit 1
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [Parameter(Mandatory = $true)]
    [string]$OutFile
  )

  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
}

function Invoke-JsonRequest([string]$Uri) {
  return Invoke-RestMethod -UseBasicParsing -Uri $Uri -Headers @{
    "User-Agent" = "pablozaiden-installer"
    "Accept" = "application/vnd.github+json"
  }
}

function Invoke-RawJsonRequest([string]$Uri) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers @{
    "User-Agent" = "pablozaiden-installer"
    "Accept" = "application/json"
  }
  return ConvertFrom-Json -InputObject ([string]$response.Content)
}

function Test-HttpStatus {
  param(
    [Parameter(Mandatory = $true)]
    [object]$ErrorRecord,
    [Parameter(Mandatory = $true)]
    [int]$StatusCode
  )

  $responseProperty = $ErrorRecord.Exception.PSObject.Properties["Response"]
  if ($null -eq $responseProperty -or $null -eq $responseProperty.Value) {
    return $false
  }
  $statusProperty = $responseProperty.Value.PSObject.Properties["StatusCode"]
  return $null -ne $statusProperty -and [int]$statusProperty.Value -eq $StatusCode
}

function Expand-InstallDirectory([string]$Value) {
  if ($Value -eq '$HOME' -or $Value -eq "~") {
    return $HOME
  }
  if ($Value.StartsWith('$HOME/') -or $Value.StartsWith('$HOME\')) {
    return Join-Path $HOME $Value.Substring(6)
  }
  if ($Value.StartsWith("~/") -or $Value.StartsWith("~\")) {
    return Join-Path $HOME $Value.Substring(2)
  }
  return $Value
}

function Get-ReleaseArchitecture {
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($architecture)) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
  }
  switch ($architecture.ToUpperInvariant()) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default { Fail "Unsupported architecture: $architecture. Supported architectures are x64 and arm64." }
  }
}

function Get-Manifest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepository,
    [Parameter(Mandatory = $true)]
    [string]$TargetRef
  )

  $rawBaseUrl = if ($env:RAW_BASE_URL) {
    $env:RAW_BASE_URL.TrimEnd("/")
  } else {
    "https://raw.githubusercontent.com"
  }

  foreach ($path in $DefaultManifestPaths) {
    $uri = "$rawBaseUrl/$TargetRepository/$TargetRef/$path"
    try {
      $manifest = Invoke-RawJsonRequest $uri
      return [PSCustomObject]@{
        Path = $path
        Value = $manifest
      }
    } catch {
      if (Test-HttpStatus -ErrorRecord $_ -StatusCode 404) {
        continue
      }
      throw
    }
  }
  return $null
}

function Assert-ManifestPlatform {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Manifest,
    [Parameter(Mandatory = $true)]
    [string]$Architecture
  )

  $platformsProperty = $Manifest.PSObject.Properties["platforms"]
  if ($null -eq $platformsProperty) {
    return
  }
  $windowsProperty = $platformsProperty.Value.PSObject.Properties["windows"]
  if ($null -eq $windowsProperty -or @($windowsProperty.Value) -notcontains $Architecture) {
    Fail "Manifest does not support platform windows-$Architecture."
  }
}

function Get-ExpectedChecksum {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ChecksumPath,
    [Parameter(Mandatory = $true)]
    [string]$AssetName
  )

  $plainHashes = @()
  foreach ($line in (Get-Content -LiteralPath $ChecksumPath)) {
    $match = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$')
    if (-not $match.Success) {
      continue
    }
    $hash = $match.Groups[1].Value.ToLowerInvariant()
    $fileName = $match.Groups[2].Value.Trim()
    if ($fileName) {
      if ([IO.Path]::GetFileName($fileName) -eq $AssetName) {
        return $hash
      }
      continue
    }
    $plainHashes += $hash
  }
  if ($plainHashes.Count -eq 1) {
    return $plainHashes[0]
  }
  Fail "Checksum for $AssetName did not contain a valid SHA-256 entry."
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Install-Binary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRepository,
    [Parameter(Mandatory = $true)]
    [string]$Tag,
    [Parameter(Mandatory = $true)]
    [string]$Architecture,
    [Parameter(Mandatory = $true)]
    [string]$TargetInstallDir,
    [Parameter(Mandatory = $true)]
    [string]$ChecksumPolicy,
    [Parameter(Mandatory = $true)]
    [string]$ChecksumExtension,
    [Parameter(Mandatory = $true)]
    [object]$BinaryDefinition
  )

  $name = [string]$BinaryDefinition.name
  $prefixProperty = $BinaryDefinition.PSObject.Properties["assetPrefix"]
  $assetPrefix = if ($null -eq $prefixProperty -or [string]::IsNullOrWhiteSpace([string]$prefixProperty.Value)) {
    $name
  } else {
    [string]$prefixProperty.Value
  }
  $requiredProperty = $BinaryDefinition.PSObject.Properties["required"]
  $required = $null -eq $requiredProperty -or [bool]$requiredProperty.Value
  $assetName = "$assetPrefix-$Tag-windows-$Architecture.exe"
  $releaseBaseUrl = if ($env:GITHUB_RELEASE_BASE_URL) {
    $env:GITHUB_RELEASE_BASE_URL.TrimEnd("/")
  } else {
    "https://github.com"
  }
  $downloadUrl = "$releaseBaseUrl/$TargetRepository/releases/download/$Tag/$assetName"
  $tempFile = [IO.Path]::GetTempFileName()
  $checksumFile = [IO.Path]::GetTempFileName()

  try {
    [Console]::WriteLine("Downloading $assetName...")
    try {
      Invoke-Download -Uri $downloadUrl -OutFile $tempFile
    } catch {
      if (-not $required -and (Test-HttpStatus -ErrorRecord $_ -StatusCode 404)) {
        [Console]::WriteLine("Skipping optional binary $name; $assetName was not published.")
        return $false
      }
      throw
    }

    if ($ChecksumPolicy -eq "none") {
      [Console]::WriteLine("Skipping checksum verification for $assetName; checksum policy is none.")
    } else {
      $checksumName = "$assetName$ChecksumExtension"
      $checksumUrl = "$downloadUrl$ChecksumExtension"
      $checksumDownloaded = $true
      try {
        Invoke-Download -Uri $checksumUrl -OutFile $checksumFile
      } catch {
        if ($ChecksumPolicy -eq "required" -or -not (Test-HttpStatus -ErrorRecord $_ -StatusCode 404)) {
          throw
        }
        [Console]::WriteLine("Skipping checksum verification for $assetName; $checksumName was not published.")
        $checksumDownloaded = $false
      }
      if ($checksumDownloaded) {
        [Console]::WriteLine("Verifying $checksumName...")
        $expected = Get-ExpectedChecksum -ChecksumPath $checksumFile -AssetName $assetName
        $actual = Get-Sha256 $tempFile
        if ($expected -ne $actual) {
          Fail "Checksum verification failed for $assetName`: expected $expected, got $actual."
        }
      }
    }

    $fileName = if ($name.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
      $name
    } else {
      "$name.exe"
    }
    $targetPath = Join-Path $TargetInstallDir $fileName
    Move-Item -LiteralPath $tempFile -Destination $targetPath -Force
    [Console]::WriteLine("Installed $name to $targetPath")
    return $true
  } finally {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $checksumFile -Force -ErrorAction SilentlyContinue
  }
}

function Add-UserPath([string]$Directory) {
  $fullDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd("\")
  $currentEntries = @($env:Path -split ";" | Where-Object { $_ })
  $alreadyCurrent = $currentEntries | Where-Object {
    try {
      [IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))
      ).TrimEnd("\").Equals($fullDirectory, [StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  }
  if ($alreadyCurrent) {
    [Console]::WriteLine("")
    [Console]::WriteLine("Installation complete!")
    return
  }

  if ($NoModifyPath) {
    [Console]::WriteLine("")
    [Console]::WriteLine("Warning: $fullDirectory is not in PATH.")
    [Console]::WriteLine("Add it to your user PATH before invoking installed binaries by name.")
    return
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userEntries = @($userPath -split ";" | Where-Object { $_ })
  $alreadyUser = $userEntries | Where-Object {
    try {
      [IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))
      ).TrimEnd("\").Equals($fullDirectory, [StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  }
  if (-not $alreadyUser) {
    $nextUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
      $fullDirectory
    } else {
      "$fullDirectory;$userPath"
    }
    [Environment]::SetEnvironmentVariable("Path", $nextUserPath, "User")
  }
  $env:Path = "$fullDirectory;$env:Path"
  [Console]::WriteLine("")
  [Console]::WriteLine("Added $fullDirectory to the user PATH.")
  [Console]::WriteLine("Open a new terminal before invoking installed binaries by name.")
}

if ($Help) {
  Show-Usage
  exit 0
}
if ([string]::IsNullOrWhiteSpace($Repository)) {
  Show-Usage
  exit 1
}
if ($env:OS -ne "Windows_NT") {
  Fail "install.ps1 supports Windows only. Use install.sh on Linux or macOS."
}
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  Fail "Repository must be <owner>/<repo>."
}

$architecture = Get-ReleaseArchitecture
[Console]::WriteLine("Installer version: $InstallerVersion")
[Console]::WriteLine("Detected platform: windows-$architecture")

$manifestResult = Get-Manifest -TargetRepository $Repository -TargetRef $Ref
$binaries = @()
$checksumPolicy = $Checksum
$checksumExtension = $DefaultChecksumExtension
$postInstallMessage = $null

if ($null -ne $manifestResult) {
  [Console]::WriteLine("Loaded installer manifest: $($manifestResult.Path)")
  $manifest = $manifestResult.Value
  if ($manifest.schemaVersion -ne 1) {
    Fail "Unsupported installer manifest schemaVersion: $($manifest.schemaVersion). Supported schemaVersion is 1."
  }
  Assert-ManifestPlatform -Manifest $manifest -Architecture $architecture
  if ($manifest.PSObject.Properties["repo"]) {
    $Repository = [string]$manifest.repo
  }
  if ($manifest.PSObject.Properties["installDir"]) {
    $InstallDir = [string]$manifest.installDir
  }
  if (-not $ChecksumWasSpecified -and $manifest.PSObject.Properties["checksums"]) {
    $checksumPolicy = if ([bool]$manifest.checksums.required) { "required" } else { "optional" }
    if ($manifest.checksums.PSObject.Properties["extension"]) {
      $checksumExtension = [string]$manifest.checksums.extension
    }
  }
  $binaries = @($manifest.binaries)
  if ($manifest.PSObject.Properties["postInstallMessage"]) {
    $postInstallMessage = [string]$manifest.postInstallMessage
  }
} else {
  if ($Binary.Count -eq 0) {
    Fail "No installer manifest found. Add .github/installer.json or pass -Binary <name>."
  }
  for ($index = 0; $index -lt $Binary.Count; $index += 1) {
    $prefix = if ($index -lt $AssetPrefix.Count) { $AssetPrefix[$index] } else { $Binary[$index] }
    $binaries += [PSCustomObject]@{
      name = $Binary[$index]
      assetPrefix = $prefix
      required = $true
    }
  }
}

if ($binaries.Count -eq 0) {
  Fail "No binaries configured for installation."
}
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = $DefaultInstallDir
}
$InstallDir = Expand-InstallDirectory $InstallDir
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$apiBaseUrl = if ($env:GITHUB_API_BASE_URL) {
  $env:GITHUB_API_BASE_URL.TrimEnd("/")
} else {
  "https://api.github.com"
}
[Console]::WriteLine("Fetching latest release...")
$release = Invoke-JsonRequest "$apiBaseUrl/repos/$Repository/releases/latest"
$tag = [string]$release.tag_name
if ([string]::IsNullOrWhiteSpace($tag)) {
  Fail "Could not determine latest release version."
}
[Console]::WriteLine("Latest version: $tag")

foreach ($binaryDefinition in $binaries) {
  $installed = Install-Binary `
    -TargetRepository $Repository `
    -Tag $tag `
    -Architecture $architecture `
    -TargetInstallDir $InstallDir `
    -ChecksumPolicy $checksumPolicy `
    -ChecksumExtension $checksumExtension `
    -BinaryDefinition $binaryDefinition
  $messageProperty = $binaryDefinition.PSObject.Properties["postInstallMessage"]
  if ($installed -and $null -ne $messageProperty -and $messageProperty.Value) {
    [Console]::WriteLine([string]$messageProperty.Value)
  }
}

if ($postInstallMessage) {
  [Console]::WriteLine($postInstallMessage)
}
Add-UserPath $InstallDir

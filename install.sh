#!/bin/sh
set -e

INSTALLER_VERSION="0.0.0-development"
DEFAULT_INSTALL_DIR="\$HOME/.local/bin"
DEFAULT_MANIFEST_PATHS=".github/installer.json .installer.json"
DEFAULT_CHECKSUM_EXTENSION=".sha256"
DEFAULT_REF="main"

usage() {
  cat <<'USAGE'
Usage:
  install.sh <owner>/<repo> [options]

Options:
  --ref <ref>                  Repository ref to read manifests from (default: main)
  --binary <name>              Binary name to install when no manifest is available
  --asset-prefix <prefix>      Asset prefix for the most recent --binary
  --install-dir <dir>          Install directory (default: $HOME/.local/bin)
  --checksum required|optional|none
                               Checksum policy when no manifest is available (default: required)
  --help                       Show this help

Preferred use:
  curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh | sh -s -- pablozaiden/link

Consuming repositories should publish .github/installer.json or .installer.json.
USAGE
}

error() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || error "$1 is required."
}

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

make_temp_file() {
  prefix=${1:-installer}
  case "${OS:-}" in
    darwin) mktemp -t "$prefix.XXXXXX" ;;
    *) mktemp "${TMPDIR:-/tmp}/$prefix.XXXXXX" ;;
  esac
}

expand_install_dir() {
  case "$1" in
    "\$HOME") echo "$HOME" ;;
    "\$HOME/"*) echo "$HOME/${1#"\$HOME/"}" ;;
    "~") echo "$HOME" ;;
    "~/"*) echo "$HOME/${1#"~/"}" ;;
    *) echo "$1" ;;
  esac
}

json_string_value() {
  key=$1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

json_boolean_value() {
  key=$1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\(true\\|false\\).*/\\1/p" | head -n 1
}

json_number_value() {
  key=$1
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" | head -n 1
}

manifest_string_value() {
  key=$1
  printf "%s\n" "$MANIFEST_JSON" | tr '\n' ' ' | json_string_value "$key"
}

manifest_schema_version() {
  printf "%s\n" "$MANIFEST_JSON" | tr '\n' ' ' | json_number_value "schemaVersion"
}

manifest_checksum_value() {
  key=$1
  printf "%s\n" "$MANIFEST_JSON" \
    | tr '\n' ' ' \
    | sed -n 's/.*"checksums"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' \
    | json_string_value "$key"
}

manifest_checksum_boolean() {
  key=$1
  printf "%s\n" "$MANIFEST_JSON" \
    | tr '\n' ' ' \
    | sed -n 's/.*"checksums"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' \
    | json_boolean_value "$key"
}

manifest_platform_arches() {
  os=$1
  printf "%s\n" "$MANIFEST_JSON" \
    | tr '\n' ' ' \
    | sed -n "s/.*\"platforms\"[[:space:]]*:[[:space:]]*{[^}]*\"$os\"[[:space:]]*:[[:space:]]*\\[\\([^]]*\\)\\].*/\\1/p" \
    | tr ',' '\n' \
    | sed 's/[ "	]//g' \
    | sed '/^$/d'
}

manifest_has_platforms() {
  printf "%s\n" "$MANIFEST_JSON" | tr '\n' ' ' | sed -n 's/.*"platforms"[[:space:]]*:[[:space:]]*{.*/true/p' | head -n 1
}

manifest_binary_lines() {
  printf "%s\n" "$MANIFEST_JSON" \
    | tr '\n' ' ' \
    | sed -n 's/.*"binaries"[[:space:]]*:[[:space:]]*\[\(.*\)$/\1/p' \
    | sed 's/\][[:space:]]*,[[:space:]]*"[^"]*"[[:space:]]*:.*//' \
    | sed 's/\][[:space:]]*}.*//' \
    | sed 's/}[[:space:]]*,[[:space:]]*{/\}\n\{/g' \
    | while IFS= read -r object || [ -n "$object" ]; do
      name=$(printf "%s\n" "$object" | json_string_value "name")
      [ -n "$name" ] || continue
      prefix=$(printf "%s\n" "$object" | json_string_value "assetPrefix")
      required=$(printf "%s\n" "$object" | json_boolean_value "required")
      message=$(printf "%s\n" "$object" | json_string_value "postInstallMessage")
      [ -n "$prefix" ] || prefix=$name
      [ -n "$required" ] || required=true
      printf "%s|%s|%s|%s\n" "$name" "$prefix" "$required" "$message"
    done
}

manual_binary_lines() {
  printf "%s\n" "$MANUAL_BINARIES" | while IFS='|' read -r name prefix || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    [ -n "$prefix" ] || prefix=$name
    printf "%s|%s|true|\n" "$name" "$prefix"
  done
}

fetch_manifest() {
  repository=$1
  ref=$2
  for path in $DEFAULT_MANIFEST_PATHS; do
    url="${RAW_BASE_URL:-https://raw.githubusercontent.com}/$repository/$ref/$path"
    if body=$(curl -fsSL "$url" 2>/dev/null); then
      MANIFEST_JSON=$body
      MANIFEST_SOURCE=$path
      return 0
    fi
  done
  return 1
}

latest_release_tag() {
  repository=$1
  curl -fsSL "${GITHUB_API_BASE_URL:-https://api.github.com}/repos/$repository/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

download_file() {
  url=$1
  output=$2
  if ! curl -fsSL "$url" -o "$output"; then
    return 1
  fi
}

sha256_of_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    error "sha256sum or shasum is required to verify checksums."
  fi
}

verify_checksum() {
  asset_name=$1
  binary_file=$2
  checksum_file=$3
  expected=$(awk 'NF {print $1; exit}' "$checksum_file" | tr 'A-F' 'a-f')
  case "$expected" in
    ????????????????????????????????????????????????????????????????) ;;
    *) error "Checksum for $asset_name did not contain a valid SHA-256 entry." ;;
  esac
  actual=$(sha256_of_file "$binary_file" | tr 'A-F' 'a-f')
  if [ "$expected" != "$actual" ]; then
    error "Checksum verification failed for $asset_name: expected $expected, got $actual."
  fi
}

install_binary() {
  repository=$1
  tag=$2
  os=$3
  arch=$4
  install_dir=$5
  checksum_policy=$6
  checksum_extension=$7
  binary_name=$8
  asset_prefix=$9

  asset_name="$asset_prefix-$tag-$os-$arch"
  download_url="${GITHUB_RELEASE_BASE_URL:-https://github.com}/$repository/releases/download/$tag/$asset_name"
  temp_file=$(make_temp_file "$binary_name")
  checksum_file=$(make_temp_file "$binary_name-checksum")

  echo "Downloading $asset_name..."
  if ! download_file "$download_url" "$temp_file"; then
    rm -f "$temp_file" "$checksum_file"
    error "Failed to download from $download_url"
  fi

  if [ "$checksum_policy" = "none" ]; then
    echo "Skipping checksum verification for $asset_name; checksum policy is none."
  else
    checksum_name="$asset_name$checksum_extension"
    checksum_url="$download_url$checksum_extension"
    if download_file "$checksum_url" "$checksum_file"; then
      echo "Verifying $checksum_name..."
      verify_checksum "$asset_name" "$temp_file" "$checksum_file"
    elif [ "$checksum_policy" = "required" ]; then
      rm -f "$temp_file" "$checksum_file"
      error "Failed to download required checksum from $checksum_url"
    else
      echo "Skipping checksum verification for $asset_name; $checksum_name was not published."
    fi
  fi

  mv "$temp_file" "$install_dir/$binary_name"
  rm -f "$checksum_file"
  chmod +x "$install_dir/$binary_name"
  echo "Installed $binary_name to $install_dir/$binary_name"
}

REPOSITORY=
REF=$DEFAULT_REF
INSTALL_DIR=$DEFAULT_INSTALL_DIR
CHECKSUM_POLICY=required
CHECKSUM_OPTION_SET=false
CHECKSUM_EXTENSION=$DEFAULT_CHECKSUM_EXTENSION
MANUAL_BINARIES=
LAST_BINARY=

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --ref)
      [ $# -gt 1 ] || error "--ref requires a value."
      REF=$2
      shift 2
      ;;
    --binary)
      [ $# -gt 1 ] || error "--binary requires a value."
      LAST_BINARY=$2
      MANUAL_BINARIES="${MANUAL_BINARIES}${MANUAL_BINARIES:+
}$LAST_BINARY|$LAST_BINARY"
      shift 2
      ;;
    --asset-prefix)
      [ $# -gt 1 ] || error "--asset-prefix requires a value."
      [ -n "$LAST_BINARY" ] || error "--asset-prefix must follow --binary."
      prefix=$2
      MANUAL_BINARIES=$(printf "%s\n" "$MANUAL_BINARIES" | awk -F'|' -v binary="$LAST_BINARY" -v prefix="$prefix" 'BEGIN { OFS = "|" } $1 == binary { $2 = prefix } { print }')
      shift 2
      ;;
    --install-dir)
      [ $# -gt 1 ] || error "--install-dir requires a value."
      INSTALL_DIR=$2
      shift 2
      ;;
    --checksum)
      [ $# -gt 1 ] || error "--checksum requires a value."
      case "$2" in
        required|optional|none) CHECKSUM_POLICY=$2 ;;
        *) error "--checksum must be required, optional, or none." ;;
      esac
      CHECKSUM_OPTION_SET=true
      shift 2
      ;;
    --*)
      error "Unknown option: $1"
      ;;
    *)
      [ -z "$REPOSITORY" ] || error "Unexpected positional argument: $1"
      REPOSITORY=$1
      shift
      ;;
  esac
done

[ -n "$REPOSITORY" ] || {
  usage
  exit 1
}

case "$REPOSITORY" in
  */*) ;;
  *) error "Repository must be <owner>/<repo>." ;;
esac

require_command curl
require_command sed
require_command awk

OS=$(detect_os)
ARCH=$(detect_arch)
[ "$OS" != "unsupported" ] || error "Unsupported operating system: $(uname -s). Supported systems are Linux and macOS."
[ "$ARCH" != "unsupported" ] || error "Unsupported architecture: $(uname -m). Supported architectures are x64 and arm64."

echo "Installer version: $INSTALLER_VERSION"
echo "Detected platform: $OS-$ARCH"

MANIFEST_JSON=
MANIFEST_SOURCE=
if fetch_manifest "$REPOSITORY" "$REF"; then
  echo "Loaded installer manifest: $MANIFEST_SOURCE"
  manifest_schema_version=$(manifest_schema_version)
  [ "$manifest_schema_version" = "1" ] || error "Unsupported installer manifest schemaVersion: ${manifest_schema_version:-missing}. Supported schemaVersion is 1."
  manifest_repo=$(manifest_string_value "repo")
  [ -z "$manifest_repo" ] || REPOSITORY=$manifest_repo
  manifest_install_dir=$(manifest_string_value "installDir")
  [ -z "$manifest_install_dir" ] || INSTALL_DIR=$manifest_install_dir
  manifest_checksum_required=$(manifest_checksum_boolean "required")
  if [ "$CHECKSUM_OPTION_SET" != "true" ] && [ -n "$manifest_checksum_required" ]; then
    if [ "$manifest_checksum_required" = "true" ]; then
      CHECKSUM_POLICY=required
    else
      CHECKSUM_POLICY=optional
    fi
  fi
  manifest_checksum_extension=$(manifest_checksum_value "extension")
  [ -z "$manifest_checksum_extension" ] || CHECKSUM_EXTENSION=$manifest_checksum_extension
  manifest_supported_arches=$(manifest_platform_arches "$OS")
  if [ "$(manifest_has_platforms)" = "true" ] && { [ -z "$manifest_supported_arches" ] || ! printf "%s\n" "$manifest_supported_arches" | grep -qx "$ARCH"; }; then
    error "Manifest does not support platform $OS-$ARCH."
  fi
  BINARY_LINES=$(manifest_binary_lines)
else
  [ -n "$MANUAL_BINARIES" ] || error "No installer manifest found. Add .github/installer.json or pass --binary <name>."
  BINARY_LINES=$(manual_binary_lines)
fi

[ -n "$BINARY_LINES" ] || error "No binaries configured for installation."

INSTALL_DIR=$(expand_install_dir "$INSTALL_DIR")
mkdir -p "$INSTALL_DIR"

echo "Fetching latest release..."
LATEST_TAG=$(latest_release_tag "$REPOSITORY")
[ -n "$LATEST_TAG" ] || error "Could not determine latest release version."
echo "Latest version: $LATEST_TAG"

printf "%s\n" "$BINARY_LINES" | while IFS='|' read -r binary_name asset_prefix required post_message; do
  [ -n "$binary_name" ] || continue
  install_binary "$REPOSITORY" "$LATEST_TAG" "$OS" "$ARCH" "$INSTALL_DIR" "$CHECKSUM_POLICY" "$CHECKSUM_EXTENSION" "$binary_name" "$asset_prefix"
  [ -z "$post_message" ] || echo "$post_message"
done

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo ""
    echo "Installation complete!"
    ;;
  *)
    echo ""
    echo "Warning: $INSTALL_DIR is not in your PATH."
    echo ""
    echo "Add it to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "Or run installed binaries directly from:"
    echo "  $INSTALL_DIR"
    ;;
esac

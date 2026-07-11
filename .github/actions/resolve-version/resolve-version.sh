#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'resolve-version: %s\n' "$1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_release_version() {
  local value
  value="$(trim "$1")"
  [[ -n "$value" ]] || fail "release version is empty."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "release version contains a newline."
  printf '%s' "${value#v}"
}

resolve_latest_release_tag() {
  if [[ -n "${LATEST_RELEASE_TAG:-}" ]]; then
    printf '%s' "$LATEST_RELEASE_TAG"
    return
  fi

  command -v gh >/dev/null 2>&1 || fail "gh is required to resolve the latest release."

  local error_file
  local latest_tag
  local error_message
  error_file="$(mktemp)"
  if latest_tag="$(GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}" gh release view --json tagName --jq '.tagName' 2>"$error_file")"; then
    rm -f "$error_file"
    [[ -n "$latest_tag" ]] || fail "gh returned an empty latest release tag."
    printf '%s' "$latest_tag"
    return
  fi

  error_message="$(cat "$error_file")"
  rm -f "$error_file"
  if printf '%s' "$error_message" | grep -Eqi 'release not found|no releases'; then
    printf 'resolve-version: no published release found; using v0.0.0 as the main base.\n' >&2
    printf 'v0.0.0'
    return
  fi

  printf '%s\n' "$error_message" >&2
  fail "unable to resolve the latest release."
}

write_package_version() {
  [[ -f "$PACKAGE_JSON" ]] || fail "package file not found: $PACKAGE_JSON"
  command -v jq >/dev/null 2>&1 || fail "jq is required when update_package_version is enabled."

  local temporary_file="${PACKAGE_JSON}.tmp.$$"
  if ! jq --arg version "$VERSION" '.version = $version' "$PACKAGE_JSON" > "$temporary_file"; then
    rm -f "$temporary_file"
    fail "could not update package file: $PACKAGE_JSON"
  fi
  mv "$temporary_file" "$PACKAGE_JSON"
}

MODE="${MODE:-release}"
RELEASE_TAG="${RELEASE_TAG:-${GITHUB_REF_NAME:-}}"
UPDATE_PACKAGE_VERSION="${UPDATE_PACKAGE_VERSION:-false}"
PACKAGE_JSON="${PACKAGE_JSON:-package.json}"

[[ -n "${GITHUB_OUTPUT:-}" ]] || fail "GITHUB_OUTPUT is required."

case "$MODE" in
  release)
    [[ -n "$RELEASE_TAG" ]] || fail "release_tag is required in release mode."
    BASE_VERSION="$(normalize_release_version "$RELEASE_TAG")"
    VERSION="$BASE_VERSION"
    ;;
  main)
    LATEST_TAG="$(resolve_latest_release_tag)"
    BASE_VERSION="$(normalize_release_version "$LATEST_TAG")"
    SEMVER_PATTERN='^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
    [[ "$BASE_VERSION" =~ $SEMVER_PATTERN ]] || fail "latest release version is not valid semver: $BASE_VERSION"

    MAJOR=$((10#${BASH_REMATCH[1]}))
    MINOR=$((10#${BASH_REMATCH[2]}))
    BASE_PATCH=$((10#${BASH_REMATCH[3]}))
    BASE_VERSION="${MAJOR}.${MINOR}.${BASE_PATCH}"
    PATCH=$((BASE_PATCH + 1))
    TIMESTAMP="${BUILD_TIMESTAMP:-$(date -u +"%Y-%m-%d-%H-%M")}"
    SHORT_SHA="${SHORT_SHA:-${GITHUB_SHA:-}}"
    SHORT_SHA="${SHORT_SHA:0:7}"
    [[ "$TIMESTAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || fail "invalid build timestamp: $TIMESTAMP"
    [[ "$SHORT_SHA" =~ ^[0-9a-fA-F]{7}$ ]] || fail "SHORT_SHA or GITHUB_SHA must contain at least seven hexadecimal characters."
    VERSION="${MAJOR}.${MINOR}.${PATCH}-main-${TIMESTAMP}-${SHORT_SHA}"
    ;;
  *)
    fail "unsupported mode \"$MODE\". Expected release or main."
    ;;
esac

case "$UPDATE_PACKAGE_VERSION" in
  true)
    write_package_version
    ;;
  false)
    ;;
  *)
    fail "update_package_version must be true or false."
    ;;
esac

{
  printf 'version=%s\n' "$VERSION"
  printf 'base_version=%s\n' "$BASE_VERSION"
} >> "$GITHUB_OUTPUT"

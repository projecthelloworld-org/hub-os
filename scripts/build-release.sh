#!/usr/bin/env bash
set -Eeuo pipefail

version=${1:-0.1.0}
root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
release_dir="$root_dir/release"
archive_name="hubos-v$version.tar.gz"
sbom_name="hubos-v$version.spdx.json"
syft_image=${SYFT_IMAGE:-anchore/syft:v1.44.0}

cd "$root_dir"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '%s\n' "Run this after Git has been initialized." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { printf '%s\n' "Commit or stash changes before building a release." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { printf '%s\n' "Docker is required to generate the SBOM." >&2; exit 1; }

mkdir -p "$release_dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git archive --format=tar.gz --prefix="hubos-v$version/" --output="$release_dir/$archive_name" HEAD
tar -xzf "$release_dir/$archive_name" -C "$work"

docker run --rm \
  -v "$work/hubos-v$version:/source:ro" \
  -v "$release_dir:/output" \
  "$syft_image" dir:/source -o "spdx-json=/output/$sbom_name"

(
  cd "$release_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive_name" "$sbom_name" > SHA256SUMS
  else
    shasum -a 256 "$archive_name" "$sbom_name" > SHA256SUMS
  fi
)

printf '%s\n' "Created release/$archive_name, release/$sbom_name, and release/SHA256SUMS"

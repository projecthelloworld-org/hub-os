#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
vendor_dir="$root_dir/vendor"
odk_version=${ODK_CENTRAL_VERSION:-v2026.2.0}
headwind_version=${HMDM_DOCKER_VERSION:-v0.1.8}

mkdir -p "$vendor_dir"

if [ ! -d "$vendor_dir/odk-central/.git" ]; then
  git clone --depth 1 --branch "$odk_version" \
    https://github.com/getodk/central.git "$vendor_dir/odk-central"
fi

odk_actual=$(git -C "$vendor_dir/odk-central" describe --tags --exact-match 2>/dev/null || true)
if [ "$odk_actual" != "$odk_version" ]; then
  printf '%s\n' "ODK Central checkout is $odk_actual; expected $odk_version." >&2
  printf '%s\n' "Move vendor/odk-central aside and rerun this command." >&2
  exit 1
fi

git -C "$vendor_dir/odk-central" submodule update --init --recursive --depth 1

if [ ! -f "$vendor_dir/odk-central/.env" ]; then
  cp "$root_dir/config/odk/.env.example" "$vendor_dir/odk-central/.env"
fi

if [ ! -d "$vendor_dir/headwind-mdm/.git" ]; then
  git clone --depth 1 --branch "$headwind_version" \
    https://github.com/h-mdm/hmdm-docker.git "$vendor_dir/headwind-mdm"
fi

headwind_actual=$(git -C "$vendor_dir/headwind-mdm" describe --tags --exact-match 2>/dev/null || true)
if [ "$headwind_actual" != "$headwind_version" ]; then
  printf '%s\n' "Headwind MDM checkout is $headwind_actual; expected $headwind_version." >&2
  printf '%s\n' "Move vendor/headwind-mdm aside and rerun this command." >&2
  exit 1
fi

if [ ! -f "$vendor_dir/headwind-mdm/.env" ]; then
  cp "$root_dir/config/headwind/.env.example" "$vendor_dir/headwind-mdm/.env"
fi

printf '%s\n' "ODK Central and Headwind MDM upstream Compose projects are ready."

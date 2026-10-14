#!/usr/bin/env bash
# HubOS interactive installer. Designed to work both from a checkout and via curl | bash.
set -Eeuo pipefail

umask 077

VERSION="0.1.0"
DEFAULT_RELEASE_URL="https://github.com/projecthelloworld-org/hub-os/releases/download/v0.1.0/hubos-v0.1.0.tar.gz"
DEFAULT_RELEASE_SHA256="b1db6a4760fd06b1cea14b2fce6452eeaad311035b1d87661ca4444f2fdb3af7"
INTERACTIVE=1
ASSUME_YES=0
START_STACK=1
INSTALL_DOCKER=0
UPGRADE_REQUESTED=0
ARCHIVE_WORK=""
UPGRADE_WORK=""
UPGRADE_BACKUP=""
SOURCE_REPLACED=0
UPGRADE_STOPPED=0
INSTALL_LOCK=""
PROFILE="core"
CADDY_IMAGE="caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648"
MODE="${HUBOS_INSTALL_MODE:-}"
if [[ -z "$MODE" && -n "${HUBOS_DEMO_MODE:-}" ]]; then
  case "$HUBOS_DEMO_MODE" in true|1) MODE=demo ;; false|0) MODE=live ;; *) printf '%s\n' 'HUBOS_DEMO_MODE must be true or false.' >&2; exit 1 ;; esac
fi
INSTALL_DIR=""
RELEASE_URL="${HUBOS_RELEASE_URL:-$DEFAULT_RELEASE_URL}"
RELEASE_SHA256="${HUBOS_RELEASE_SHA256:-$DEFAULT_RELEASE_SHA256}"
TTY_DEVICE="/dev/tty"
TTY_ECHO_DISABLED=0
COMPOSE_FILES=(-f compose.yaml -f compose/mel.compose.yaml -f compose/monitoring.compose.yaml)

info() { printf '\033[1;34m[HubOS]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[HubOS]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[HubOS]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[HubOS]\033[0m %s\n' "$*" >&2; exit 1; }

restore_terminal() {
  local result=$?
  if (( TTY_ECHO_DISABLED )) && [[ -w "$TTY_DEVICE" ]]; then stty echo < "$TTY_DEVICE" 2>/dev/null || true; fi
  [[ -z "$ARCHIVE_WORK" ]] || rm -rf "$ARCHIVE_WORK"
  [[ -z "$UPGRADE_WORK" ]] || rm -rf "$UPGRADE_WORK"
  [[ -z "$INSTALL_LOCK" ]] || rm -rf "$INSTALL_LOCK"
  if (( result != 0 && UPGRADE_STOPPED )); then
    warn "Upgrade did not complete. Services may remain paused. Review the configuration and rerun the installer; do not roll back migrated databases by replacing source files alone."
  fi
}
trap restore_terminal EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat <<'EOF'
HubOS interactive installer

Usage:
  ./install.sh [options]
  curl -fsSL INSTALLER_URL | bash

Options:
  --install-dir PATH      Installation directory
  --profile PROFILE      core (default) or ecosystem (adds ODK and Headwind)
  --mode MODE            demo (fictional sites) or live (no fictional data)
  --upgrade              Download the sealed release for an unpacked deployment
  --release-url URL      Release .tar.gz used when running through a pipe
  --release-sha256 HASH  Expected SHA-256 for the release archive
  --install-docker       Offer to install Docker on supported Linux systems
  --no-start             Prepare and validate configuration without starting HubOS
  --non-interactive      Read supported settings from environment variables
  --yes                  Accept confirmation prompts
  --help                 Show this help

Non-interactive variables use the names from .env.example. Required secrets are
generated when omitted. HUBOS_RELEASE_URL can identify the source archive.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) [[ $# -ge 2 ]] || die "--install-dir needs a path"; INSTALL_DIR=$2; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || die "--profile needs core or ecosystem"; PROFILE=$2; shift 2 ;;
    --mode) [[ $# -ge 2 ]] || die "--mode needs demo or live"; MODE=$2; shift 2 ;;
    --release-url) [[ $# -ge 2 ]] || die "--release-url needs a URL"; RELEASE_URL=$2; shift 2 ;;
    --release-sha256) [[ $# -ge 2 ]] || die "--release-sha256 needs a hash"; RELEASE_SHA256=$2; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --upgrade) UPGRADE_REQUESTED=1; shift ;;
    --no-start) START_STACK=0; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$PROFILE" == "core" || "$PROFILE" == "ecosystem" ]] || die "Profile must be core or ecosystem."
[[ -z "$MODE" || "$MODE" == demo || "$MODE" == live ]] || die "Mode must be demo or live."

has_tty() { [[ -r "$TTY_DEVICE" && -w "$TTY_DEVICE" ]]; }

prompt() {
  local message=$1 default=${2:-} answer
  if (( ! INTERACTIVE )); then printf '%s' "$default"; return; fi
  has_tty || die "Interactive installation needs a terminal. Use --non-interactive for automation."
  if [[ -n "$default" ]]; then
    read -r -p "$message [$default]: " answer < "$TTY_DEVICE"
  else
    read -r -p "$message: " answer < "$TTY_DEVICE"
  fi
  printf '%s' "${answer:-$default}"
}

prompt_secret() {
  local message=$1 answer
  if (( ! INTERACTIVE )); then printf ''; return; fi
  has_tty || die "Secret input needs a terminal."
  printf '%s: ' "$message" > "$TTY_DEVICE"
  TTY_ECHO_DISABLED=1
  stty -echo < "$TTY_DEVICE"
  IFS= read -r answer < "$TTY_DEVICE" || true
  stty echo < "$TTY_DEVICE"
  TTY_ECHO_DISABLED=0
  printf '\n' > "$TTY_DEVICE"
  printf '%s' "$answer"
}

choose_password() {
  local message=$1 value=${2:-} first second
  if (( INTERACTIVE )); then
    first=$(prompt_secret "$message (leave blank to generate one)")
    if [[ -n "$first" ]]; then
      second=$(prompt_secret "Repeat $message")
      [[ "$first" == "$second" ]] || die "The passwords do not match."
      value=$first
    fi
  fi
  value=${value:-$(random_secret 24)}
  (( ${#value} >= 12 )) || die "$message must contain at least 12 characters."
  validate_env_value "$message" "$value"
  printf '%s' "$value"
}

hash_operator_password() {
  local password=$1 result
  (( ${#password} <= 72 )) || die "Operator passwords must fit bcrypt's 72-byte limit."
  result=$(printf '%s\n' "$password" | docker run --rm -i --entrypoint caddy "$CADDY_IMAGE" hash-password --algorithm bcrypt --bcrypt-cost 12) \
    || die "Cannot hash the operator password. Check Docker and access to the pinned Caddy image."
  [[ "$result" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || die "Caddy did not return a valid bcrypt password hash."
  printf '%s' "$result"
}

confirm() {
  local message=$1 answer
  (( ASSUME_YES )) && return 0
  (( INTERACTIVE )) || return 1
  answer=$(prompt "$message (y/N)" "N")
  [[ "$answer" =~ ^[Yy]$ ]]
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${1:-24}"
  elif [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    od -An -N "${1:-24}" -tx1 /dev/urandom | tr -d ' \n'
  else
    die "openssl or /dev/urandom with od is required to generate credentials."
  fi
}

random_base64_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    random_secret 32
  fi
}

read_dotenv() {
  local key=$1 fallback=$2 value
  value=$(awk -F= -v wanted="$key" '$1 == wanted {print substr($0, index($0, "=") + 1); exit}' .env 2>/dev/null || true)
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value=${value:1:${#value}-2}; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "${value:-$fallback}"
}

has_setting() {
  awk -F= -v wanted="$1" '$1 == wanted {found=1} END {exit !found}' .env
}

add_missing_setting() {
  validate_env_value "$1" "$2"
  if ! has_setting "$1"; then printf '\n%s=%s\n' "$1" "$(env_escape "$2")" >> .env; fi
}

save_private_credential() {
  printf '%s=%s\n' "$1" "$(env_escape "$2")" >> .hubos-credentials
  chmod 600 .hubos-credentials
}

validate_port() {
  [[ "$2" =~ ^[0-9]+$ ]] && (( 10#$2 >= 1 && 10#$2 <= 65535 )) || die "$1 must be a port from 1 to 65535."
}

validate_env_value() {
  [[ "$2" != *$'\n'* && "$2" != *$'\r'* ]] || die "$1 cannot contain a newline."
}

env_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  printf '"%s"' "$value"
}

url_encode() {
  local value=$1 character index LC_ALL=C
  for ((index=0; index<${#value}; index++)); do
    character=${value:index:1}
    case "$character" in
      [a-zA-Z0-9.~_-]) printf '%s' "$character" ;;
      *) printf '%%%02X' "'$character" ;;
    esac
  done
}

script_source_dir() {
  local candidate
  [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]] || return 1
  candidate=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
  [[ -f "$candidate/compose.yaml" && -f "$candidate/.env.example" ]] && printf '%s' "$candidate"
}

claim_installation() {
  local lock="$INSTALL_DIR.install-lock"
  mkdir "$lock" 2>/dev/null || die "Another installer may be using this directory. Review $lock; remove it only after confirming that no installer is running."
  INSTALL_LOCK=$lock
  printf 'pid=%s\n' "$$" > "$INSTALL_LOCK/owner"
}

download_source() {
  local target=$1 archive work extracted actual_sha expected_sha package_version
  [[ -n "$RELEASE_URL" ]] || die "This piped installer has no published release URL yet. Set HUBOS_RELEASE_URL or pass --release-url."
  [[ "$RELEASE_URL" == https://* ]] || die "Release downloads require HTTPS."
  [[ "$RELEASE_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || die "The release SHA-256 must contain exactly 64 hexadecimal characters."
  command -v curl >/dev/null 2>&1 || die "curl is required to download HubOS."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack HubOS."
  [[ ! -e "$target" || -z "$(ls -A "$target" 2>/dev/null || true)" ]] || die "$target is not empty. Choose another --install-dir."
  work=$(mktemp -d)
  ARCHIVE_WORK=$work
  archive="$work/hubos.tar.gz"
  info "Downloading the HubOS release…"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 "$RELEASE_URL" --output "$archive"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha=$(sha256sum "$archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
  else
    die "sha256sum or shasum is required to verify the release archive."
  fi
  actual_sha=$(printf '%s' "$actual_sha" | tr '[:upper:]' '[:lower:]')
  expected_sha=$(printf '%s' "$RELEASE_SHA256" | tr '[:upper:]' '[:lower:]')
  [[ "$actual_sha" == "$expected_sha" ]] || die "Release checksum verification failed."
  tar -tzf "$archive" >/dev/null || die "The downloaded release is not a valid gzip archive."
  tar -tzf "$archive" | awk '
    /^\// || /(^|\/)\.\.($|\/)/ || /[[:cntrl:]]/ {bad=1}
    {split($0,p,"/"); if (!root) root=p[1]; if (p[1]!=root) bad=1}
    END {exit bad || !root}' || die "The release contains unsafe paths or more than one source tree."
  tar -tvzf "$archive" | awk '
    {kind=substr($0,1,1); mode=substr($0,1,10)}
    kind!="-" && kind!="d" {bad=1}
    mode ~ /[sStT]/ || substr(mode,9,1)=="w" {bad=1}
    END {exit bad}' || die "Release archives cannot contain links, special files or unsafe permission bits."
  mkdir -p "$work/unpacked" "$target"
  # Public source modes must survive the private credential umask so the image's
  # non-root Bun user can read copied source. Ownership is never imported.
  tar -xzpf "$archive" --no-same-owner -C "$work/unpacked"
  extracted=$(find "$work/unpacked" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [[ -n "$extracted" && -f "$extracted/compose.yaml" ]] || die "The release does not contain a HubOS source tree."
  package_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$extracted/services/hubos/package.json" 2>/dev/null || true)
  [[ "$(basename "$extracted")" == "hubos-v$VERSION" && "$package_version" == "$VERSION" ]] \
    || die "The package version does not agree with this sealed installer."
  [[ ! -e "$extracted/.env" && ! -e "$extracted/.hubos-credentials" && ! -e "$extracted/.git" ]] \
    || die "A release archive must not contain private deployment configuration or a Git checkout."
  cp -RPp "$extracted"/. "$target"/
  printf 'version=%s\nsha256=%s\n' "$VERSION" "$expected_sha" > "$target/.hubos-release"
  chmod 600 "$target/.hubos-release"
  rm -rf "$work"
  ARCHIVE_WORK=""
}

upgrade_source() {
  local target=$1 namespace previous_mode running path relative old_files
  [[ ! -L "$target" && ! -e "$target/.git" ]] || die "Automatic release upgrades require an unpacked deployment, not a symbolic link or Git checkout."
  [[ -f "$target/.env" && ! -L "$target/.env" && ! -L "$target/.hubos-credentials" ]] \
    || die "An upgrade requires the existing private configuration; configuration files cannot be symbolic links."
  cd "$target"
  namespace=$(read_dotenv COMPOSE_PROJECT_NAME "${COMPOSE_PROJECT_NAME:-hubos}")
  [[ "$namespace" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "Invalid saved installation namespace."
  [[ -z "${COMPOSE_PROJECT_NAME:-}" || "$COMPOSE_PROJECT_NAME" == "$namespace" ]] || die "COMPOSE_PROJECT_NAME conflicts with the saved installation namespace."
  previous_mode=$(read_dotenv HUBOS_DEMO_MODE false)
  case "$previous_mode" in true|1) previous_mode=demo ;; false|0) previous_mode=live ;; *) die "Existing HUBOS_DEMO_MODE must be true or false." ;; esac
  [[ -z "$MODE" || "$MODE" == "$previous_mode" ]] || die "An upgrade cannot change the installation's demo/live mode."
  confirm "Upgrade this installation to HubOS $VERSION after taking a consistent database and configuration backup" \
    || die "Upgrade cancelled. The existing installation is unchanged."
  ensure_dependencies
  ensure_compose_version
  check_capacity
  running=$(docker ps --quiet --filter "label=com.docker.compose.project=$namespace")
  [[ -z "$running" || "$START_STACK" == 1 ]] || die "Stop this installation before a --no-start upgrade. No files were changed."
  UPGRADE_WORK=$(mktemp -d "$(dirname "$target")/.hubos-stage.XXXXXX")
  download_source "$UPGRADE_WORK/release"
  [[ -f "$UPGRADE_WORK/release/compose/mel.compose.yaml" && -f "$UPGRADE_WORK/release/compose/monitoring.compose.yaml" ]] \
    || die "The sealed package is not a HubOS monitoring release."
  # Refuse to follow a deployment's links when overlaying managed release files.
  while IFS= read -r path; do
    relative=${path#"$UPGRADE_WORK/release/"}
    [[ ! -L "$target/$relative" ]] || die "A managed release path is a symbolic link. Review the deployment before upgrading."
    if [[ -e "$target/$relative" ]]; then
      [[ -d "$path" && -d "$target/$relative" || -f "$path" && -f "$target/$relative" ]] \
        || die "A managed release path has changed between file and directory. Review the deployment before upgrading."
    fi
  done < <(find "$UPGRADE_WORK/release" -mindepth 1 -print)
  # Publish the receipt only after every managed file is in place. A partial
  # copy keeps the old receipt so another run stages the package again.
  cp -p "$UPGRADE_WORK/release/.hubos-release" "$UPGRADE_WORK/receipt"
  rm "$UPGRADE_WORK/release/.hubos-release"
  if [[ -n "$running" ]]; then
    old_files=(-f compose.yaml)
    for path in compose/mel.compose.yaml compose/monitoring.compose.yaml; do [[ ! -f "$path" ]] || old_files+=(-f "$path"); done
    [[ "$previous_mode" != demo || ! -f compose/development.compose.yaml ]] || old_files+=(-f compose/development.compose.yaml)
    [[ "$PROFILE" != ecosystem || ! -f compose/ecosystem.compose.yaml || ! -d vendor/odk-central ]] || old_files+=(-f compose/ecosystem.compose.yaml)
    info "Pausing this installation before replacing its managed source files…"
    UPGRADE_STOPPED=1
    docker compose -p "$namespace" "${old_files[@]}" stop
  fi
  UPGRADE_BACKUP="$target.pre-upgrade-$(random_secret 4)"
  [[ ! -e "$UPGRADE_BACKUP" && ! -L "$UPGRADE_BACKUP" ]] || die "The selected backup path already exists. No source files were moved."
  mkdir "$UPGRADE_BACKUP"
  chmod 700 "$UPGRADE_BACKUP"
  cp -RPp "$target"/. "$UPGRADE_BACKUP"/
  # Keep bind-mounted directory identities stable across Docker hosts. In
  # particular, replacing the entire tree can leave a VM's existing mounts
  # pointing at the old migrations even after containers are recreated.
  cp -RPp "$UPGRADE_WORK/release"/. "$target"/
  cp -p "$UPGRADE_WORK/receipt" "$target/.hubos-release"
  SOURCE_REPLACED=1
  info "Previous source and private configuration retained at $UPGRADE_BACKUP. This is not a database backup."
  rm -rf "$UPGRADE_WORK"
  UPGRADE_WORK=""
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

install_docker_debian() {
  local sudo_cmd=() distro codename arch keyring
  (( EUID == 0 )) || sudo_cmd=(sudo)
  command -v sudo >/dev/null 2>&1 || (( EUID == 0 )) || die "sudo is required to install Docker."
  # shellcheck disable=SC1091
  . /etc/os-release
  distro=$(printf '%s' "$ID" | tr '[:upper:]' '[:lower:]')
  [[ "$distro" == ubuntu || "$distro" == debian ]] || die "Automatic Docker installation supports Ubuntu and Debian only."
  codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
  [[ -n "$codename" ]] || die "Could not determine the operating-system release name."
  arch=$(dpkg --print-architecture)
  keyring=/etc/apt/keyrings/docker.asc
  info "Installing Docker Engine and the Compose plugin from Docker's official repository…"
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y ca-certificates curl
  "${sudo_cmd[@]}" install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$distro/gpg" | "${sudo_cmd[@]}" tee "$keyring" >/dev/null
  "${sudo_cmd[@]}" chmod a+r "$keyring"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: %s\n' \
    "$distro" "$codename" "$arch" "$keyring" | "${sudo_cmd[@]}" tee /etc/apt/sources.list.d/docker.sources >/dev/null
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  "${sudo_cmd[@]}" systemctl enable --now docker
}

ensure_dependencies() {
  local os
  docker_ready && return
  os=$(uname -s)
  if [[ "$os" == Linux && "$INSTALL_DOCKER" == 1 ]]; then
    install_docker_debian
  elif [[ "$os" == Linux ]] && confirm "Docker Engine or Compose is unavailable. Install Docker now"; then
    install_docker_debian
  elif [[ "$os" == Darwin ]]; then
    die "Install and start Docker Desktop for Mac, then rerun this installer: https://docs.docker.com/desktop/setup/install/mac-install/"
  else
    die "Install Docker Engine and the Docker Compose plugin, start Docker, then rerun this installer: https://docs.docker.com/engine/install/"
  fi
  docker_ready || die "Docker was installed but is not usable by this account. Log out and back in after adding Docker group access, or rerun with suitable privileges."
}

ensure_compose_version() {
  local version major minor patch
  version=$(docker compose version --short)
  [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]] || die "Cannot identify the Docker Compose version. Compose 2.24.4 or later is required."
  major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}; patch=${BASH_REMATCH[3]}
  (( major > 2 || (major == 2 && (minor > 24 || (minor == 24 && patch >= 4))) )) \
    || die "Docker Compose 2.24.4 or later is required for safe port-list overrides."
}

check_capacity() {
  local available_kb required_kb=5242880
  [[ "$PROFILE" == ecosystem ]] && required_kb=15728640
  available_kb=$(df -Pk "$INSTALL_DIR" | awk 'NR==2 {print $4}')
  [[ "$available_kb" =~ ^[0-9]+$ ]] || return
  (( available_kb >= required_kb )) || die "Not enough free disk space. The $PROFILE profile needs at least $((required_kb / 1048576)) GB free."
}

port_in_use() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then ss -ltn | awk '{print $4}' | grep -Eq "[:.]$port$"
  else return 1
  fi
}

wait_for_setup() {
  local deadline=$((SECONDS + 600)) ready service container details state exit_code health
  local tasks=(migrate metabase-bootstrap kuma-bootstrap)
  local applications=(db metabase-db api worker caddy metabase kuma)
  [[ "$MODE" != demo ]] || tasks+=(seed)
  info "Waiting for healthy applications and completed migrations, dashboards and monitor provisioning…"
  while (( SECONDS < deadline )); do
    ready=1
    for service in "${tasks[@]}" "${applications[@]}"; do
      container=$(docker compose "${COMPOSE_FILES[@]}" ps --all -q "$service")
      if [[ -z "$container" ]]; then ready=0; continue; fi
      details=$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
      IFS='|' read -r state exit_code health <<< "$details"
      case "$service" in
        migrate|seed|metabase-bootstrap|kuma-bootstrap)
          if [[ "$state" == dead || ( "$state" == exited && "$exit_code" != 0 ) ]]; then
            die "Setup task $service failed. Review its Compose logs; application health alone does not complete installation."
          fi
          [[ "$state" == exited && "$exit_code" == 0 ]] || ready=0
          ;;
        *)
          [[ "$state" != exited && "$state" != dead && "$health" != unhealthy ]] || die "Required application $service stopped or became unhealthy. Review its Compose logs."
          [[ "$state" == running && ( -z "$health" || "$health" == healthy ) ]] || ready=0
          ;;
      esac
    done
    if (( ready )); then
      local address="http://127.0.0.1:$hubos_port"
      [[ "$bind_address" != ::1 ]] || address="http://[::1]:$hubos_port"
      [[ "$tls_enabled" != true ]] || address="$site_address"
      if curl --fail --silent --show-error --max-time 10 "$address/readyz" >/dev/null 2>&1; then
        ok "Application health and provisioning completed."
        return
      fi
    fi
    sleep 2
  done
  die "Installation did not complete within 10 minutes. Review Compose application and provisioning logs."
}

source_dir=$(script_source_dir || true)
if [[ -n "$source_dir" ]]; then
  INSTALL_DIR=${INSTALL_DIR:-$source_dir}
else
  INSTALL_DIR=${INSTALL_DIR:-${HUBOS_INSTALL_DIR:-$HOME/hubos}}
fi
[[ ! -L "$INSTALL_DIR" ]] || die "The installation directory must not be a symbolic link."
mkdir -p "$INSTALL_DIR"
INSTALL_DIR=$(CDPATH= cd -- "$INSTALL_DIR" && pwd)
claim_installation
if [[ -f "$INSTALL_DIR/compose.yaml" ]]; then
  if (( UPGRADE_REQUESTED )) || [[ -z "$source_dir" ]]; then
    if [[ ! -f "$INSTALL_DIR/.hubos-release" ]] \
      || ! grep -Fxq "version=$VERSION" "$INSTALL_DIR/.hubos-release" \
      || ! grep -Fxiq "sha256=$RELEASE_SHA256" "$INSTALL_DIR/.hubos-release"; then
      upgrade_source "$INSTALL_DIR"
    fi
  fi
else
  download_source "$INSTALL_DIR"
fi
INSTALL_DIR=$(CDPATH= cd -- "$INSTALL_DIR" && pwd)
cd "$INSTALL_DIR"
[[ -f compose.yaml && -f compose/mel.compose.yaml && -f compose/monitoring.compose.yaml ]] || die "$INSTALL_DIR is not a HubOS monitoring release."

ensure_dependencies
ensure_compose_version
check_capacity

EXISTING_CONFIG=0
[[ ! -L .env && ! -L .hubos-credentials ]] || die "Configuration and credential files must not be symbolic links."
if [[ -f .env ]]; then
  EXISTING_CONFIG=1
  info "Existing HubOS configuration detected. It will be preserved."
  warn "To change persistent database credentials, use a documented credential-rotation procedure; replacing .env alone will disconnect existing volumes."
  previous_demo=$(read_dotenv HUBOS_DEMO_MODE false)
  case "$previous_demo" in true|1) previous_mode=demo ;; false|0) previous_mode=live ;; *) die "Existing HUBOS_DEMO_MODE must be true or false." ;; esac
  [[ -z "$MODE" || "$MODE" == "$previous_mode" ]] || die "Existing installation uses $previous_mode mode. Use a separate installation and fresh volumes for $MODE mode."
  MODE=$previous_mode
  project_name=$(read_dotenv COMPOSE_PROJECT_NAME "${COMPOSE_PROJECT_NAME:-hubos}")
  [[ -z "${COMPOSE_PROJECT_NAME:-}" || "$COMPOSE_PROJECT_NAME" == "$project_name" ]] || die "COMPOSE_PROJECT_NAME conflicts with this installation's saved data namespace."
elif (( INTERACTIVE )); then
  MODE=$(prompt "Installation mode (demo has fictional sites; live starts empty)" "${MODE:-demo}")
fi
if (( ! EXISTING_CONFIG )); then
  project_name=${COMPOSE_PROJECT_NAME:-hubos-$(random_secret 4)}
  if (( INTERACTIVE )); then project_name=$(prompt "Installation name (keeps persistent data separate)" "$project_name"); fi
fi
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "Installation names use lower-case letters, digits, underscores or hyphens."
MODE=${MODE:-demo}
[[ "$MODE" == demo || "$MODE" == live ]] || die "Mode must be demo or live."
demo_mode=false
runtime_environment=production
if [[ "$MODE" == demo ]]; then
  demo_mode=true
  runtime_environment=development
  [[ -f compose/development.compose.yaml ]] || die "Demo Compose configuration is missing."
  COMPOSE_FILES+=(-f compose/development.compose.yaml)
fi
info "Installation mode: $MODE."
if (( ! EXISTING_CONFIG )); then
  existing_containers=$(docker compose -p "$project_name" "${COMPOSE_FILES[@]}" ps --all -q)
  existing_volumes=$(docker volume ls --filter "label=com.docker.compose.project=$project_name" --quiet)
  [[ -z "$existing_containers" && -z "$existing_volumes" ]] || die "Installation name $project_name has existing data or containers. Restore its configuration or choose another name; do not reuse it for a fresh installation."
fi

bind_address=${HUBOS_BIND_ADDRESS:-127.0.0.1}
site_address=${HUBOS_SITE_ADDRESS:-:80}
https_port=${HUBOS_HTTPS_PORT:-443}
hubos_port=${HUBOS_HTTP_PORT:-8080}
metabase_port=${METABASE_PORT:-3001}
kuma_port=${KUMA_PORT:-3002}
mailpit_port=${MAILPIT_WEB_PORT:-8025}
operator_user=${HUBOS_OPERATOR_USERNAME:-operator}
kuma_user=${KUMA_ADMIN_USER:-hubos-admin}
admin_email=${METABASE_ADMIN_EMAIL:-admin@hubos.local}
admin_first=${METABASE_ADMIN_FIRST_NAME:-HubOS}
admin_last=${METABASE_ADMIN_LAST_NAME:-Administrator}
metabase_site_url=${METABASE_SITE_URL:-http://localhost:$metabase_port}

if (( EXISTING_CONFIG )); then
  bind_address=$(read_dotenv HUBOS_BIND_ADDRESS "$bind_address")
  site_address=$(read_dotenv HUBOS_SITE_ADDRESS "$site_address")
  https_port=$(read_dotenv HUBOS_HTTPS_PORT "$https_port")
  hubos_port=$(read_dotenv HUBOS_HTTP_PORT "$hubos_port")
  metabase_port=$(read_dotenv METABASE_PORT "$metabase_port")
  kuma_port=$(read_dotenv KUMA_PORT "$kuma_port")
  mailpit_port=$(read_dotenv MAILPIT_WEB_PORT "$mailpit_port")
  admin_email=$(read_dotenv METABASE_ADMIN_EMAIL "$admin_email")
  operator_user=$(read_dotenv HUBOS_OPERATOR_USERNAME "$operator_user")
  kuma_user=$(read_dotenv KUMA_ADMIN_USER "$kuma_user")
  admin_password="(preserved in .env)"
elif (( INTERACTIVE )); then
  info "Configuration (press Enter to accept the value shown)."
  bind_address=$(prompt "Operator bind address (127.0.0.1 is private; remote access requires HTTPS)" "$bind_address")
  if [[ "$bind_address" != 127.0.0.1 && "$bind_address" != ::1 && "$bind_address" != localhost || "$site_address" != :80 ]]; then
    site_address=$(prompt "Operator HTTPS origin (for example https://monitoring.example.org)" "$site_address")
  fi
  if [[ "$site_address" != :80 && -z "${HUBOS_HTTP_PORT:-}" ]]; then hubos_port=80; fi
  hubos_port=$(prompt "HubOS port" "$hubos_port")
  metabase_port=$(prompt "Metabase port" "$metabase_port")
  kuma_port=$(prompt "Uptime Kuma port" "$kuma_port")
  mailpit_port=$(prompt "Local alert inbox port" "$mailpit_port")
  admin_first=$(prompt "Metabase administrator first name" "$admin_first")
  admin_last=$(prompt "Metabase administrator last name" "$admin_last")
  admin_email=$(prompt "Metabase administrator email" "$admin_email")
  metabase_site_url=$(prompt "Metabase site URL used in alerts" "$metabase_site_url")
  operator_user=$(prompt "HubOS operator username" "$operator_user")
  kuma_user=$(prompt "Uptime Kuma administrator username" "$kuma_user")
fi

tls_enabled=false
if [[ "$site_address" != :80 ]]; then
  [[ "$site_address" =~ ^https://([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:([0-9]+))?$ ]] || die "HUBOS_SITE_ADDRESS must be a credential-free HTTPS origin, with no trailing slash, path, query or fragment."
  origin_port=${BASH_REMATCH[3]:-443}
  if [[ -n "${HUBOS_HTTPS_PORT:-}" || "$EXISTING_CONFIG" == 1 ]] && [[ "$https_port" != "$origin_port" ]]; then
    die "HUBOS_HTTPS_PORT must match the HTTPS origin's port."
  fi
  https_port=$origin_port
  validate_port HUBOS_HTTPS_PORT "$https_port"
  [[ -f compose/tls.compose.yaml ]] || die "HTTPS Compose configuration is missing."
  COMPOSE_FILES+=(-f compose/tls.compose.yaml)
  tls_enabled=true
  if (( ! EXISTING_CONFIG && ! INTERACTIVE )) && [[ -z "${HUBOS_HTTP_PORT:-}" ]]; then hubos_port=80; fi
elif [[ "$bind_address" != 127.0.0.1 && "$bind_address" != ::1 && "$bind_address" != localhost ]]; then
  die "Remote operator bindings require an explicit HTTPS HUBOS_SITE_ADDRESS."
fi
operator_address="http://localhost:$hubos_port"
[[ "$tls_enabled" != true ]] || operator_address="$site_address"

validate_port HUBOS_HTTP_PORT "$hubos_port"
validate_port METABASE_PORT "$metabase_port"
validate_port KUMA_PORT "$kuma_port"
validate_port MAILPIT_WEB_PORT "$mailpit_port"
if [[ "$tls_enabled" == true ]]; then
  [[ "$https_port" != "$hubos_port" && "$https_port" != "$metabase_port" && "$https_port" != "$kuma_port" && "$https_port" != "$mailpit_port" ]] || die "HTTPS needs a separate port."
fi
[[ "$hubos_port" != "$metabase_port" && "$hubos_port" != "$mailpit_port" && "$metabase_port" != "$mailpit_port" ]] || die "HubOS, Metabase, and Mailpit must use different ports."
[[ "$kuma_port" != "$hubos_port" && "$kuma_port" != "$metabase_port" && "$kuma_port" != "$mailpit_port" ]] || die "Uptime Kuma needs a separate port."
[[ "$admin_email" == *@*.* ]] || die "Enter a valid Metabase administrator email."
for pair in "HUBOS_BIND_ADDRESS:$bind_address" "METABASE_ADMIN_FIRST_NAME:$admin_first" "METABASE_ADMIN_LAST_NAME:$admin_last" "METABASE_ADMIN_EMAIL:$admin_email" "METABASE_SITE_URL:$metabase_site_url"; do
  validate_env_value "${pair%%:*}" "${pair#*:}"
done

if (( ! EXISTING_CONFIG )); then
  [[ "$operator_user" =~ ^[A-Za-z][A-Za-z0-9_.@-]{0,63}$ ]] || die "Use a simple HubOS operator username."
  [[ "$kuma_user" =~ ^[A-Za-z][A-Za-z0-9_.@-]{0,63}$ ]] || die "Use a simple Kuma administrator username."
  admin_password=$(choose_password "Metabase administrator password" "${METABASE_ADMIN_PASSWORD:-}")
  kuma_password=$(choose_password "Uptime Kuma administrator password" "${KUMA_ADMIN_PASSWORD:-}")
  operator_hash=${HUBOS_OPERATOR_PASSWORD_HASH:-}
  operator_password=""
  if [[ -z "$operator_hash" ]]; then
    operator_password=$(choose_password "HubOS operator password" "${HUBOS_OPERATOR_PASSWORD:-}")
    operator_hash=$(hash_operator_password "$operator_password")
  fi
  [[ "$operator_hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || die "HUBOS_OPERATOR_PASSWORD_HASH must be a bcrypt hash."

  postgres_password=${POSTGRES_PASSWORD:-$(random_secret 24)}
  metabase_db_password=${METABASE_DB_PASSWORD:-$(random_secret 24)}
  ingest_key=${HUBOS_INGEST_KEY:-$(random_secret 32)}
  admin_key=${HUBOS_ADMIN_KEY:-$(random_secret 32)}
  encryption_key=${METABASE_ENCRYPTION_SECRET_KEY:-$(random_base64_key)}
  analytics_password=${METABASE_HUBOS_DB_PASSWORD:-$(random_secret 32)}
  kuma_webhook_key=${KUMA_WEBHOOK_KEY:-$(random_secret 32)}
  metabase_webhook_key=${METABASE_WEBHOOK_KEY:-$(random_secret 32)}

  for variable in postgres_password metabase_db_password ingest_key admin_key encryption_key analytics_password kuma_webhook_key metabase_webhook_key; do
    validate_env_value "$variable" "${!variable}"
    [[ -n "${!variable}" ]] || die "$variable cannot be empty."
  done
  machine_keys=("$ingest_key" "$admin_key" "$kuma_webhook_key" "$metabase_webhook_key")
  for ((i=0; i<${#machine_keys[@]}; i++)); do
    (( ${#machine_keys[i]} >= 32 )) || die "Machine ingestion and webhook keys must contain at least 32 characters."
    for ((j=i+1; j<${#machine_keys[@]}; j++)); do
      [[ "${machine_keys[i]}" != "${machine_keys[j]}" ]] || die "Use separate credentials for ingestion, administration and each webhook source."
    done
  done

  for port in "$hubos_port" "$metabase_port" "$mailpit_port"; do
    if port_in_use "$port"; then warn "Port $port is already in use. Compose will fail unless it belongs to this HubOS installation."; fi
  done

  cat > .env <<EOF
# Generated by HubOS installer $VERSION on $(date -u +%Y-%m-%dT%H:%M:%SZ)
COMPOSE_PROJECT_NAME=$(env_escape "$project_name")
HUBOS_ENV=$runtime_environment
HUBOS_HTTP_PORT=$hubos_port
HUBOS_BIND_ADDRESS=$(env_escape "$bind_address")
HUBOS_DEMO_MODE=$demo_mode
HUBOS_INGEST_KEY=$(env_escape "$ingest_key")
HUBOS_ADMIN_KEY=$(env_escape "$admin_key")
HUBOS_OPERATOR_CONSOLE_ENABLED=true
HUBOS_OPERATOR_USERNAME=$(env_escape "$operator_user")
HUBOS_OPERATOR_PASSWORD_HASH='$operator_hash'
HUBOS_SITE_ADDRESS=$(env_escape "$site_address")
HUBOS_HTTPS_PORT=$https_port

POSTGRES_DB=hubos
POSTGRES_USER=hubos
POSTGRES_PASSWORD=$(env_escape "$postgres_password")
HUBOS_DATABASE_URL=$(env_escape "postgresql://hubos:$(url_encode "$postgres_password")@db:5432/hubos?sslmode=disable")

METABASE_PORT=$metabase_port
METABASE_DB_PASSWORD=$(env_escape "$metabase_db_password")
METABASE_SITE_URL=$(env_escape "$metabase_site_url")
METABASE_ENCRYPTION_SECRET_KEY=$(env_escape "$encryption_key")
METABASE_ADMIN_FIRST_NAME=$(env_escape "$admin_first")
METABASE_ADMIN_LAST_NAME=$(env_escape "$admin_last")
METABASE_ADMIN_EMAIL=$(env_escape "$admin_email")
METABASE_ADMIN_PASSWORD=$(env_escape "$admin_password")
METABASE_HUBOS_DB_USER=hubos_analytics
METABASE_HUBOS_DB_PASSWORD=$(env_escape "$analytics_password")
METABASE_HUBOS_SCHEMAS=analytics
METABASE_WEBHOOK_KEY=$(env_escape "$metabase_webhook_key")
KUMA_PORT=$kuma_port
KUMA_ADMIN_USER=$(env_escape "$kuma_user")
KUMA_ADMIN_PASSWORD=$(env_escape "$kuma_password")
KUMA_WEBHOOK_KEY=$(env_escape "$kuma_webhook_key")
HUBOS_NOTIFICATION_MODE=local
MAILPIT_WEB_PORT=$mailpit_port

HMDM_HTTP_PORT=${HMDM_HTTP_PORT:-8081}
HMDM_CLIENT_PORT=${HMDM_CLIENT_PORT:-31000}
ODK_HTTPS_PORT=${ODK_HTTPS_PORT:-8443}
EOF
  chmod 600 .env
  {
    printf '# Private administrator credentials. Do not commit or share this file.\n'
    printf 'HUBOS_OPERATOR_USERNAME=%s\n' "$(env_escape "$operator_user")"
    if [[ -n "$operator_password" ]]; then printf 'HUBOS_OPERATOR_PASSWORD=%s\n' "$(env_escape "$operator_password")"; fi
    printf 'METABASE_ADMIN_EMAIL=%s\nMETABASE_ADMIN_PASSWORD=%s\n' "$(env_escape "$admin_email")" "$(env_escape "$admin_password")"
    printf 'KUMA_ADMIN_USER=%s\nKUMA_ADMIN_PASSWORD=%s\n' "$(env_escape "$kuma_user")" "$(env_escape "$kuma_password")"
  } > .hubos-credentials
  chmod 600 .hubos-credentials
else
  # Existing persistent credentials are never rewritten. Supply new capabilities
  # only where no setting exists; a repeated run therefore changes nothing.
  if ! has_setting HUBOS_OPERATOR_PASSWORD_HASH; then
    operator_hash=${HUBOS_OPERATOR_PASSWORD_HASH:-}
    if [[ -z "$operator_hash" ]]; then
      operator_password=$(choose_password "New HubOS operator password" "${HUBOS_OPERATOR_PASSWORD:-}")
      operator_hash=$(hash_operator_password "$operator_password")
      save_private_credential HUBOS_OPERATOR_USERNAME "$operator_user"
      save_private_credential HUBOS_OPERATOR_PASSWORD "$operator_password"
    fi
    [[ "$operator_hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || die "HUBOS_OPERATOR_PASSWORD_HASH must be a bcrypt hash."
    printf "\nHUBOS_OPERATOR_PASSWORD_HASH='%s'\n" "$operator_hash" >> .env
  fi
  add_missing_setting HUBOS_OPERATOR_USERNAME "$operator_user"
  add_missing_setting COMPOSE_PROJECT_NAME "$project_name"
  add_missing_setting HUBOS_SITE_ADDRESS "$site_address"
  add_missing_setting HUBOS_HTTPS_PORT "$https_port"
  add_missing_setting HUBOS_ENV "$runtime_environment"
  add_missing_setting HUBOS_INGEST_KEY "${HUBOS_INGEST_KEY:-$(random_secret 32)}"
  add_missing_setting HUBOS_ADMIN_KEY "${HUBOS_ADMIN_KEY:-$(random_secret 32)}"
  add_missing_setting KUMA_PORT "$kuma_port"
  add_missing_setting KUMA_ADMIN_USER "$kuma_user"
  if ! has_setting KUMA_ADMIN_PASSWORD; then
    kuma_password=$(choose_password "New Uptime Kuma administrator password" "${KUMA_ADMIN_PASSWORD:-}")
    add_missing_setting KUMA_ADMIN_PASSWORD "$kuma_password"
    save_private_credential KUMA_ADMIN_USER "$kuma_user"
    save_private_credential KUMA_ADMIN_PASSWORD "$kuma_password"
  fi
  add_missing_setting KUMA_WEBHOOK_KEY "${KUMA_WEBHOOK_KEY:-$(random_secret 32)}"
  add_missing_setting METABASE_WEBHOOK_KEY "${METABASE_WEBHOOK_KEY:-$(random_secret 32)}"
  add_missing_setting METABASE_HUBOS_DB_USER 'hubos_analytics'
  add_missing_setting METABASE_HUBOS_DB_PASSWORD "${METABASE_HUBOS_DB_PASSWORD:-$(random_secret 32)}"
  add_missing_setting METABASE_HUBOS_SCHEMAS 'analytics'
  # The published legacy Compose default must stay unchanged when it was implicit.
  add_missing_setting METABASE_ENCRYPTION_SECRET_KEY "${METABASE_ENCRYPTION_SECRET_KEY:-aHViT3MtbG9jYWwtb25seS1lbmNyeXB0aW9uLWtleQ==}"
  add_missing_setting HUBOS_NOTIFICATION_MODE local
  chmod 600 .env
fi

info "Validating the Compose configuration…"
docker compose "${COMPOSE_FILES[@]}" config --quiet

if [[ "$PROFILE" == ecosystem ]]; then
  command -v git >/dev/null 2>&1 || die "git is required for the ODK and Headwind ecosystem profile."
  info "Preparing pinned ODK Central and Headwind MDM releases…"
  ./scripts/vendor-ecosystem.sh
  COMPOSE_FILES+=(-f compose/ecosystem.compose.yaml)
  docker compose "${COMPOSE_FILES[@]}" config --quiet
fi

if (( START_STACK )); then
  info "Building and starting HubOS. The first run can take several minutes…"
  recreate=()
  (( ! SOURCE_REPLACED )) || recreate=(--force-recreate)
  docker compose "${COMPOSE_FILES[@]}" up --build -d "${recreate[@]}"
  wait_for_setup
fi

cat <<EOF

HubOS is configured.

  Installation: $INSTALL_DIR
  Data namespace: $project_name
  HubOS:        $operator_address
  Metabase:     http://localhost:$metabase_port
  Uptime Kuma:  http://localhost:$kuma_port
  Alert inbox:  http://localhost:$mailpit_port
  Admin email:  $admin_email
Credentials and generated service keys are stored in $INSTALL_DIR/.env (mode 600).
Administrator passwords generated during setup are in $INSTALL_DIR/.hubos-credentials
(mode 600). They are not printed to terminal logs.
Back up both .env and the Docker volumes. For an internet-facing deployment,
configure a domain, HTTPS, OIDC, firewall rules, and encrypted off-host backups.
EOF
if (( ! START_STACK )); then info "Configuration prepared; services were not started (--no-start)."; fi

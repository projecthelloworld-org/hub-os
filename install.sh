#!/usr/bin/env bash
# HubOS interactive installer. Designed to work both from a checkout and via curl | bash.
set -Eeuo pipefail

umask 077

VERSION="0.1.0"
DEFAULT_RELEASE_URL=""
DEFAULT_RELEASE_SHA256=""
INTERACTIVE=1
ASSUME_YES=0
START_STACK=1
INSTALL_DOCKER=0
PROFILE="core"
INSTALL_DIR=""
RELEASE_URL="${HUBOS_RELEASE_URL:-$DEFAULT_RELEASE_URL}"
RELEASE_SHA256="${HUBOS_RELEASE_SHA256:-$DEFAULT_RELEASE_SHA256}"
TTY_DEVICE="/dev/tty"
TTY_ECHO_DISABLED=0
COMPOSE_FILES=(-f compose.yaml -f compose/mel.compose.yaml -f compose/development.compose.yaml)

info() { printf '\033[1;34m[HubOS]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[HubOS]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[HubOS]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[HubOS]\033[0m %s\n' "$*" >&2; exit 1; }

restore_terminal() {
  if (( TTY_ECHO_DISABLED )) && [[ -w "$TTY_DEVICE" ]]; then stty echo < "$TTY_DEVICE" 2>/dev/null || true; fi
}
trap restore_terminal EXIT INT TERM

usage() {
  cat <<'EOF'
HubOS interactive installer

Usage:
  ./install.sh [options]
  curl -fsSL INSTALLER_URL | bash

Options:
  --install-dir PATH      Installation directory
  --profile PROFILE      core (default) or ecosystem (adds ODK and Headwind)
  --release-url URL      Release .tar.gz used when running through a pipe
  --release-sha256 HASH  Expected SHA-256 for the release archive
  --install-docker       Offer to install Docker on supported Linux systems
  --no-start             Prepare and validate configuration without starting HubOS
  --non-interactive      Read all settings from environment variables
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
    --release-url) [[ $# -ge 2 ]] || die "--release-url needs a URL"; RELEASE_URL=$2; shift 2 ;;
    --release-sha256) [[ $# -ge 2 ]] || die "--release-sha256 needs a hash"; RELEASE_SHA256=$2; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --no-start) START_STACK=0; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$PROFILE" == "core" || "$PROFILE" == "ecosystem" ]] || die "Profile must be core or ecosystem."

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
  printf '%s' "${value:-$fallback}"
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

script_source_dir() {
  local candidate
  [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]] || return 1
  candidate=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
  [[ -f "$candidate/compose.yaml" && -f "$candidate/.env.example" ]] && printf '%s' "$candidate"
}

download_source() {
  local target=$1 archive work extracted
  [[ -n "$RELEASE_URL" ]] || die "This piped installer has no published release URL yet. Set HUBOS_RELEASE_URL or pass --release-url."
  command -v curl >/dev/null 2>&1 || die "curl is required to download HubOS."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack HubOS."
  [[ ! -e "$target" || -z "$(ls -A "$target" 2>/dev/null || true)" ]] || die "$target is not empty. Choose another --install-dir."
  work=$(mktemp -d)
  trap 'rm -rf "$work"' RETURN
  archive="$work/hubos.tar.gz"
  info "Downloading the HubOS release…"
  curl --fail --silent --show-error --location "$RELEASE_URL" --output "$archive"
  if [[ -n "$RELEASE_SHA256" ]]; then
    [[ "$RELEASE_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || die "The release SHA-256 must contain exactly 64 hexadecimal characters."
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
  else
    warn "No release checksum was supplied. Published installers must embed HUBOS_RELEASE_SHA256."
  fi
  tar -tzf "$archive" >/dev/null || die "The downloaded release is not a valid gzip archive."
  mkdir -p "$work/unpacked" "$target"
  tar -xzf "$archive" -C "$work/unpacked"
  extracted=$(find "$work/unpacked" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [[ -n "$extracted" && -f "$extracted/compose.yaml" ]] || die "The release does not contain a HubOS source tree."
  cp -R "$extracted"/. "$target"/
  trap - RETURN
  rm -rf "$work"
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

source_dir=$(script_source_dir || true)
if [[ -n "$source_dir" ]]; then
  INSTALL_DIR=${INSTALL_DIR:-$source_dir}
else
  INSTALL_DIR=${INSTALL_DIR:-${HUBOS_INSTALL_DIR:-$HOME/hubos}}
  if [[ ! -f "$INSTALL_DIR/compose.yaml" ]]; then
    mkdir -p "$INSTALL_DIR"
    download_source "$INSTALL_DIR"
  fi
fi
INSTALL_DIR=$(CDPATH= cd -- "$INSTALL_DIR" && pwd)
cd "$INSTALL_DIR"
[[ -f compose.yaml && -f compose/mel.compose.yaml && -f compose/development.compose.yaml ]] || die "$INSTALL_DIR is not a HubOS release."

ensure_dependencies
check_capacity

EXISTING_CONFIG=0
if [[ -f .env ]]; then
  EXISTING_CONFIG=1
  info "Existing HubOS configuration detected. It will be preserved."
  warn "To change persistent database credentials, use a documented credential-rotation procedure; replacing .env alone will disconnect existing volumes."
fi

bind_address=${HUBOS_BIND_ADDRESS:-127.0.0.1}
hubos_port=${HUBOS_HTTP_PORT:-8080}
metabase_port=${METABASE_PORT:-3001}
mailpit_port=${MAILPIT_WEB_PORT:-8025}
admin_email=${METABASE_ADMIN_EMAIL:-admin@hubos.local}
admin_first=${METABASE_ADMIN_FIRST_NAME:-HubOS}
admin_last=${METABASE_ADMIN_LAST_NAME:-Administrator}
metabase_site_url=${METABASE_SITE_URL:-http://localhost:$metabase_port}

if (( EXISTING_CONFIG )); then
  bind_address=$(read_dotenv HUBOS_BIND_ADDRESS "$bind_address")
  hubos_port=$(read_dotenv HUBOS_HTTP_PORT "$hubos_port")
  metabase_port=$(read_dotenv METABASE_PORT "$metabase_port")
  mailpit_port=$(read_dotenv MAILPIT_WEB_PORT "$mailpit_port")
  admin_email=$(read_dotenv METABASE_ADMIN_EMAIL "$admin_email")
  admin_password="(preserved in .env)"
elif (( INTERACTIVE )); then
  info "Configuration (press Enter to accept the value shown)."
  bind_address=$(prompt "Bind address (127.0.0.1 is local-only; use 0.0.0.0 for a LAN/server)" "$bind_address")
  hubos_port=$(prompt "HubOS port" "$hubos_port")
  metabase_port=$(prompt "Metabase port" "$metabase_port")
  mailpit_port=$(prompt "Local alert inbox port" "$mailpit_port")
  admin_first=$(prompt "Metabase administrator first name" "$admin_first")
  admin_last=$(prompt "Metabase administrator last name" "$admin_last")
  admin_email=$(prompt "Metabase administrator email" "$admin_email")
  metabase_site_url=$(prompt "Metabase site URL used in alerts" "$metabase_site_url")
fi

validate_port HUBOS_HTTP_PORT "$hubos_port"
validate_port METABASE_PORT "$metabase_port"
validate_port MAILPIT_WEB_PORT "$mailpit_port"
[[ "$hubos_port" != "$metabase_port" && "$hubos_port" != "$mailpit_port" && "$metabase_port" != "$mailpit_port" ]] || die "HubOS, Metabase, and Mailpit must use different ports."
[[ "$admin_email" == *@*.* ]] || die "Enter a valid Metabase administrator email."
for pair in "HUBOS_BIND_ADDRESS:$bind_address" "METABASE_ADMIN_FIRST_NAME:$admin_first" "METABASE_ADMIN_LAST_NAME:$admin_last" "METABASE_ADMIN_EMAIL:$admin_email" "METABASE_SITE_URL:$metabase_site_url"; do
  validate_env_value "${pair%%:*}" "${pair#*:}"
done

if (( ! EXISTING_CONFIG )); then
  admin_password=${METABASE_ADMIN_PASSWORD:-}
  if (( INTERACTIVE )); then
    first=$(prompt_secret "Metabase administrator password (leave blank to generate one)")
    if [[ -n "$first" ]]; then
      second=$(prompt_secret "Repeat the Metabase administrator password")
      [[ "$first" == "$second" ]] || die "The passwords do not match."
      admin_password=$first
    fi
  fi
  admin_password=${admin_password:-$(random_secret 18)}
  (( ${#admin_password} >= 12 )) || die "The Metabase administrator password must contain at least 12 characters."
  validate_env_value METABASE_ADMIN_PASSWORD "$admin_password"

  postgres_password=${POSTGRES_PASSWORD:-$(random_secret 24)}
  metabase_db_password=${METABASE_DB_PASSWORD:-$(random_secret 24)}
  ingest_key=${HUBOS_INGEST_KEY:-$(random_secret 32)}
  admin_key=${HUBOS_ADMIN_KEY:-$(random_secret 32)}
  encryption_key=${METABASE_ENCRYPTION_SECRET_KEY:-$(random_base64_key)}

  for port in "$hubos_port" "$metabase_port" "$mailpit_port"; do
    if port_in_use "$port"; then warn "Port $port is already in use. Compose will fail unless it belongs to this HubOS installation."; fi
  done

  cat > .env <<EOF
# Generated by HubOS installer $VERSION on $(date -u +%Y-%m-%dT%H:%M:%SZ)
HUBOS_ENV=development
HUBOS_HTTP_PORT=$hubos_port
HUBOS_BIND_ADDRESS=$(env_escape "$bind_address")
HUBOS_DEMO_MODE=true
HUBOS_INGEST_KEY=$(env_escape "$ingest_key")
HUBOS_ADMIN_KEY=$(env_escape "$admin_key")
HUBOS_OPERATOR_CONSOLE_ENABLED=true

POSTGRES_DB=hubos
POSTGRES_USER=hubos
POSTGRES_PASSWORD=$(env_escape "$postgres_password")
HUBOS_DATABASE_URL=$(env_escape "postgresql://hubos:$postgres_password@db:5432/hubos?sslmode=disable")

METABASE_PORT=$metabase_port
METABASE_DB_PASSWORD=$(env_escape "$metabase_db_password")
METABASE_SITE_URL=$(env_escape "$metabase_site_url")
METABASE_ENCRYPTION_SECRET_KEY=$(env_escape "$encryption_key")
METABASE_ADMIN_FIRST_NAME=$(env_escape "$admin_first")
METABASE_ADMIN_LAST_NAME=$(env_escape "$admin_last")
METABASE_ADMIN_EMAIL=$(env_escape "$admin_email")
METABASE_ADMIN_PASSWORD=$(env_escape "$admin_password")
METABASE_HUBOS_SCHEMAS=analytics,public
MAILPIT_WEB_PORT=$mailpit_port

HMDM_HTTP_PORT=${HMDM_HTTP_PORT:-8081}
HMDM_CLIENT_PORT=${HMDM_CLIENT_PORT:-31000}
ODK_HTTPS_PORT=${ODK_HTTPS_PORT:-8443}
EOF
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
  docker compose "${COMPOSE_FILES[@]}" up --build -d
  info "Waiting for the HubOS and Metabase health checks…"
  deadline=$((SECONDS + 600))
  while (( SECONDS < deadline )); do
    api_status=$(docker compose "${COMPOSE_FILES[@]}" ps --format json api 2>/dev/null | grep -c '"Health":"healthy"' || true)
    metabase_status=$(docker compose "${COMPOSE_FILES[@]}" ps --format json metabase 2>/dev/null | grep -c '"Health":"healthy"' || true)
    (( api_status > 0 && metabase_status > 0 )) && break
    sleep 5
  done
  (( api_status > 0 && metabase_status > 0 )) || die "Services did not become healthy within 10 minutes. Run: cd $INSTALL_DIR && docker compose ${COMPOSE_FILES[*]} logs"
fi

cat <<EOF

HubOS is configured.

  Installation: $INSTALL_DIR
  HubOS:        http://localhost:$hubos_port
  Metabase:     http://localhost:$metabase_port
  Alert inbox:  http://localhost:$mailpit_port
  Admin email:  $admin_email
  Admin password: $admin_password

Credentials and generated service keys are stored in $INSTALL_DIR/.env (mode 600).
Back up both .env and the Docker volumes. For an internet-facing deployment,
configure a domain, HTTPS, OIDC, firewall rules, and encrypted off-host backups.
EOF
if (( ! START_STACK )); then info "Configuration prepared; services were not started (--no-start)."; fi

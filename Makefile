SHELL := /bin/sh
BUN_INSTALL_CACHE_DIR ?= $(CURDIR)/.bun-cache
export BUN_INSTALL_CACHE_DIR

COMPOSE = docker compose -f compose.yaml -f compose/mel.compose.yaml -f compose/development.compose.yaml
ECOSYSTEM_COMPOSE = $(COMPOSE) -f compose/ecosystem.compose.yaml

.PHONY: help install installer test check compose-config up down logs seed demo \
	ecosystem-setup ecosystem-config ecosystem-up ecosystem-down ecosystem-logs release

help:
	@echo "HubOS scaffold commands"
	@echo "  make install          Install Bun development dependencies"
	@echo "  make installer        Run the interactive system installer"
	@echo "  make test             Run the Bun test suite"
	@echo "  make check            Validate source and connector manifests"
	@echo "  make compose-config   Validate the local Docker Compose configuration"
	@echo "  make up               Start HubOS, Metabase, demo data and local email"
	@echo "  make down             Stop the local stack"
	@echo "  make logs             Follow local stack logs"
	@echo "  make seed             Reapply the synthetic Uganda and Angola demo"
	@echo "  make ecosystem-setup  Fetch pinned ODK Central and Headwind MDM projects"
	@echo "  make ecosystem-up     Start HubOS, Metabase, ODK Central and Headwind MDM"
	@echo "  make release          Build the v0.1.0 archive, SBOM and checksums"

install:
	cd services/hubos && bun install --frozen-lockfile

installer:
	./install.sh

test:
	cd services/hubos && bun test

check:
	cd services/hubos && bun run check

compose-config:
	$(COMPOSE) config --quiet

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

seed:
	$(COMPOSE) run --rm seed

demo: up
	@echo "HubOS:    http://localhost:$${HUBOS_HTTP_PORT:-8080}"
	@echo "Metabase: http://localhost:$${METABASE_PORT:-3001}"
	@echo "Mailpit:  http://localhost:$${MAILPIT_WEB_PORT:-8025}"

ecosystem-setup:
	./scripts/vendor-ecosystem.sh

ecosystem-config: ecosystem-setup
	$(ECOSYSTEM_COMPOSE) config --quiet

ecosystem-up: ecosystem-setup
	$(ECOSYSTEM_COMPOSE) up --build -d
	@echo "HubOS:        http://localhost:$${HUBOS_HTTP_PORT:-8080}"
	@echo "Metabase:     http://localhost:$${METABASE_PORT:-3001}"
	@echo "Headwind MDM: http://localhost:$${HMDM_HTTP_PORT:-8081}"
	@echo "ODK Central:  https://local:$${ODK_HTTPS_PORT:-8443}"
	@echo "Mailpit:      http://localhost:$${MAILPIT_WEB_PORT:-8025}"

ecosystem-down:
	$(ECOSYSTEM_COMPOSE) down

ecosystem-logs:
	$(ECOSYSTEM_COMPOSE) logs -f

release:
	./scripts/build-release.sh 0.1.0

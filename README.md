# HubOS

HubOS is an open, self-hostable operations layer for monitoring and supporting school connectivity. This repository is a runnable technology scaffold with a canonical school registry, replaceable connector contract, PostgreSQL evidence model, operator console, background collection, Metabase analytics, and modular Docker Compose packaging.

The included ten-school Uganda and Angola dataset is entirely synthetic. It demonstrates the product without turning a particular pilot into an architectural dependency.

## Version 1 stack

- Bun 1.3.14 with vanilla JavaScript for all HubOS-owned runtime code;
- Bun HTTP API and responsive operator console;
- Bun connector worker with PostgreSQL-backed jobs and leases;
- PostgreSQL 16 as the canonical, operational, and analytical store;
- plain SQL migrations managed by Dbmate—no custom ORM or schema-management layer;
- Caddy as the only public entry point to HubOS;
- Metabase for monitoring, evaluation, dashboards, and alert delivery;
- Mailpit for local alert testing;
- optional pinned ODK Central and Headwind MDM Compose applications.

Valkey, Celery, Prometheus, Grafana, Alertmanager, and Superset are intentionally outside Version 1. PostgreSQL already provides the durable queue needed at this scale, and Metabase covers the initial reporting and alerting requirement. Superset remains a possible Version 2 deployment option rather than another default dependency.

## Quick start

Requirements: Docker Compose and a running Docker engine.

For a guided server installation, run the interactive installer from a release checkout:

```sh
./install.sh
```

Once the tagged release assets and website endpoint are live, the equivalent hosted command is:

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | bash
```

The installer checks Docker and Compose, checks available disk space and ports, gathers the Metabase administrator details without echoing the password, generates the remaining service secrets, creates a protected `.env`, starts the stack, and waits for HubOS and Metabase to become healthy. See the [installation guide](docs/Installation.md) for the eventual hosted one-command form, automation, upgrades, and the optional ecosystem profile.

```sh
cp .env.example .env
make demo
```

Open the addresses printed by the command:

- HubOS at `http://localhost:8080`;
- Metabase at `http://localhost:3001`;
- Mailpit at `http://localhost:8025`.

The first start applies the SQL migrations and seeds five fictional schools in Uganda and five in Angola. Re-running the seed is safe because canonical identifiers and observation keys are deterministic.

The development layer also initializes Metabase and adds `HubOS PostgreSQL` automatically. With the Compose defaults, sign in with `admin@hubos.local` and `hubos-local-admin-1`. Set `METABASE_ADMIN_EMAIL` and `METABASE_ADMIN_PASSWORD` before the first start for any shared environment.

## Optional ODK and Headwind environment

Version 1 includes ODK Central and Headwind MDM as optional, independently upgradable Compose projects:

```sh
make ecosystem-setup
make ecosystem-config
make ecosystem-up
```

This fetches the pinned upstream releases and runs them with HubOS, Metabase, and Mailpit. It is a deployment template: HubOS can also connect to existing hosted ODK or Headwind instances.

## Local Bun development

```sh
make install
make test
make check
```

With PostgreSQL available and migrated:

```sh
cd services/hubos
HUBOS_DEMO_MODE=true bun run seed
bun run dev
```

## API surface

- `/` — operator console;
- `/healthz` and `/readyz` — process and database health;
- `/api/v1/openapi.json` — machine-readable API definition;
- `/api/v1/overview` — current operator view;
- `/api/v1/sites` and `/api/v1/sites/{id}/status` — canonical schools and status;
- `/api/v1/source-connections` and `/api/v1/connectors` — integration inventory;
- `/api/v1/incidents` — operational incidents;
- `/api/v1/ingest/observations:batch` — authenticated, idempotent canonical ingestion.

## Extending connectors

A connector implements one small lifecycle—manifest, configuration validation, collection, normalisation, and health—and emits the versioned canonical envelope. The shared runner handles scheduling, raw evidence, identity verification, idempotent ingestion, status updates, retries, and run history. Adding a vendor therefore changes a connector package and configuration, not the core architecture or database access pattern.

## Safe boundary

- Production mode refuses demo data and known placeholder API keys.
- Source credentials are never stored in the public seed or raw `source_connections.config` field.
- Metabase encrypts newly stored database connection details; replace the local example encryption key before sharing a deployment.
- The demo contains no real school, learner, device, or network data.
- PostgreSQL is not published to the host.
- Connected field systems are read-only in Version 1.
- Before production use, add OIDC, secret management, HTTPS domains, encrypted backups, tenant policy tests, and operational restore exercises.

## Documentation

- [Technical design](docs/HubOS_Pilot_Ready_Technical_Design.md)
- [Open connectivity prospectus](docs/HubOS_Open_Connectivity_Prospectus.md)
- [Local development guide](docs/Local_Development.md)
- [Installation guide](docs/Installation.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Licence

HubOS is released under the [MIT License](LICENSE). Each tagged release includes an SPDX software bill of materials and SHA-256 checksums.

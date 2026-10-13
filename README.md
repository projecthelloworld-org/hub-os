# HubOS

HubOS is an open, self-hostable operations layer for monitoring and supporting community-site connectivity. Schools are one supported site type, alongside community centres and libraries. The design combines a canonical site registry, extensible connector contract, PostgreSQL evidence model, operator console, background collection, Metabase analytics, and modular Docker Compose packaging.

The development demonstration includes ten entirely synthetic sites in Uganda and Angola. It demonstrates the product without turning a particular pilot into an architectural dependency.

The published `v0.1.0` release is a demonstration scaffold, not a fully connected or production-ready monitoring system. Only the synthetic connector is registered. Live vendor connectors, prebuilt Metabase dashboards and alert rules, automatic alert-to-incident creation, and production privacy/access controls remain unfinished. See the [implementation audit](docs/HubOS_Pilot_Ready_Technical_Design.md#11-delivered-scaffold-versus-target-architecture) for delivered capabilities and the staged roadmap.

The `codex/community-monitoring-v02` development branch adds tested dashboard/alert provisioning, Uptime Kuma, trusted connector packages and read-only UniFi/Headwind/ODK clients. This does not change the published installer. Installer modes, administration, backup/restore and remaining release gates are still in progress; `v0.2.0` has not been published.

## Version 1 stack

- Bun 1.3.14 with vanilla JavaScript for all HubOS-owned runtime code;
- Bun HTTP API and responsive operator console;
- Bun connector worker with PostgreSQL-backed jobs and leases;
- PostgreSQL 16 as the canonical, operational, and analytical store;
- plain SQL migrations managed by Dbmate—no custom ORM or schema-management layer;
- Caddy as the only public entry point to HubOS;
- Metabase with automatic database connection and analytical views; dashboard and alert provisioning remain planned;
- Mailpit for local alert testing;
- optional pinned ODK Central and Headwind MDM Compose applications.

Valkey, Celery, Prometheus, Grafana, Alertmanager, and Superset are intentionally outside Version 1. PostgreSQL already provides the durable queue needed at this scale, and Metabase is the selected tool for the planned reporting and alerting workflow. Superset remains a possible Version 2 deployment option rather than another default dependency.

## Quick start

Requirements: Docker Compose and a running Docker engine.

For a guided server installation, run the interactive installer from a release checkout:

```sh
./install.sh
```

The hosted installer is live at [hubos.myhellohub.org](https://hubos.myhellohub.org). Install the latest stable release with:

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | bash
```

The published `v0.1.0` installer checks Docker and Compose, checks available disk space and ports, gathers the Metabase administrator details without echoing the password, generates the remaining service secrets, creates a protected `.env`, starts the stack, and waits for HubOS and Metabase to become healthy. See the [installation guide](docs/Installation.md) for hosted installation, automation, upgrades, and the optional ecosystem profile.

For manual Compose testing on the **development branch**, operator authentication must be configured first:

```sh
cp .env.example .env
chmod 600 .env
docker run --rm -it --network none caddy:2.11.4-alpine caddy hash-password --algorithm bcrypt
```

Choose your operator password at the prompt. Put the resulting bcrypt hash in `.env`
as `HUBOS_OPERATOR_PASSWORD_HASH='the-generated-hash'`, keeping the single quotes.
Set distinct generated machine keys and database/tool credentials before sharing a
deployment. An invalid or empty operator hash makes Caddy refuse startup.

```sh
make demo
```

Open the addresses printed by the command:

- HubOS at `http://localhost:8080`;
- Metabase at `http://localhost:3001`;
- Uptime Kuma at `http://localhost:3002`;
- Mailpit at `http://localhost:8025`.

The development first start applies SQL migrations and seeds five fictional sites in Uganda and five in Angola, mixing schools, community centres and libraries. Canonical identifiers and observation keys are deterministic. Do not reseed a configured live deployment.

The development layer also initializes Metabase and adds `HubOS PostgreSQL` automatically. With the Compose defaults, sign in with `admin@hubos.local` and `hubos-local-admin-1`. Set `METABASE_ADMIN_EMAIL` and `METABASE_ADMIN_PASSWORD` before the first start for any shared environment.

The published `v0.1.0` bootstrap creates only the administrator and data source.
Development provisioning additionally creates four dashboards, questions and native
alert routing without overwriting tracked user-customized resources. Mailpit captures
local alert delivery. See [monitoring and alerts](docs/Monitoring_and_Alerts.md).

## Optional ODK and Headwind environment

Version 1 includes ODK Central and Headwind MDM as optional, independently upgradable Compose projects:

```sh
make ecosystem-setup
make ecosystem-config
make ecosystem-up
```

This fetches the pinned upstream releases and runs them with HubOS, Metabase, and Mailpit. It is a deployment template: the target design also accommodates existing hosted ODK or Headwind instances.

The published `v0.1.0` package has no live connectors. Development includes read-only
clients; review [compatibility and actual test evidence](docs/Live_Connectors.md) and
service credentials/domain configuration before connecting a real source.

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
- `/api/v1/sites` and `/api/v1/sites/{id}/status` — canonical community sites and status;
- `/api/v1/source-connections` and `/api/v1/connectors` — integration inventory;
- `/api/v1/incidents` — operational incidents;
- `/api/v1/ingest/observations:batch` — authenticated, idempotent canonical ingestion.

## Extending connectors

A connector implements one small lifecycle—manifest, configuration validation, collection, normalisation, and health—and emits the versioned canonical envelope. The shared runner handles scheduling, numeric privacy projection, identity verification, idempotent ingestion, status updates, retries, and run history. Adding a vendor changes a trusted connector package and configuration, not the core architecture or database access pattern. See [plugin installation](docs/Connector_Plugins.md).

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

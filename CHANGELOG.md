# Changelog

All notable changes to HubOS are documented here.

## 0.2.0 - 2026-10-14

Community-site monitoring:

- Mixed school, community-centre and library demonstration with ten fictional sites in Uganda and Angola.
- Four automatically provisioned Metabase dashboards with site/country/date controls, read-only analytics, generic plugin telemetry and data-based alerts.
- Digest-pinned Uptime Kuma 2.5.6, infrastructure/demo monitoring and explicitly configured community targets; uptime reported with observation coverage.
- Read-only UniFi local Network, Headwind Community and ODK Central modules behind a trusted local plugin interface.
- Protected site/source/mapping administration, connection testing and source-specific authenticated webhooks.
- Ordered, deduplicated incidents, ownership, explicit recovery and durable notification retries; local Mailpit and optional external SMTP.
- Separate demo/live installer modes, provisioning completion checks, private bindings, operator authentication and verified remote TLS.
- Consistent core/configuration/tool backups and fresh-volume restoration; checksum-sealed upgrades preserving canonical identities and tool resources.
- Maintained Metabase compatibility baseline, forward-facing documentation and desktop/mobile browser verification.

See the [release notes](docs/releases/v0.2.0.md) for upgrade guidance, compatibility limits and deferred features.

## 0.1.0 - 2026-07-17

First public technology scaffold:

- Bun and vanilla-JavaScript HubOS API, worker, connector contract, and operator console;
- PostgreSQL canonical evidence model and Dbmate migrations;
- synthetic five-school Uganda and five-school Angola demonstration data;
- Metabase analytics with automatic PostgreSQL connection bootstrap;
- Caddy entry point and Mailpit alert testing;
- optional pinned ODK Central and Headwind MDM deployment layer;
- interactive and unattended terminal installer;
- technical design, open-connectivity prospectus, local guide, and outage runbook.

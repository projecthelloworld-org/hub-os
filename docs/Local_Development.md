# HubOS local development

## Deployment layers

| File | Capability |
|---|---|
| `compose.yaml` | PostgreSQL, Dbmate migration, Bun API/console, Bun worker, Caddy |
| `compose/mel.compose.yaml` | Metabase with its own application database |
| `compose/development.compose.yaml` | Deterministic demonstration seed and Mailpit email capture |
| `compose/ecosystem.compose.yaml` | Pinned official Headwind MDM and ODK Central Compose applications |

The normal local command merges the first three files. The ecosystem command adds the fourth. HubOS has no Valkey or Redis dependency; any Redis containers inside ODK belong to ODK's Enketo subsystem.

## Synthetic demonstration

The idempotent seed creates five fictional Uganda sites and five fictional Angola sites. It includes:

- two UniFi and two MikroTik controller sources;
- Innovex REMOT, Headwind MDM, ODK, and ISP-file sources;
- verified external identifiers for every school/source relationship;
- healthy, degraded, and critical connectivity, power, and device states;
- one fictional high-severity connectivity incident;
- a scheduled mock connector job that refreshes canonical telemetry.

No credentials, names, or measurements come from a live school.

## Start the lightweight environment

```sh
cp .env.example .env
make compose-config
make demo
```

| Product | Address |
|---|---|
| HubOS | `http://localhost:8080` |
| Metabase | `http://localhost:3001` |
| Mailpit | `http://localhost:8025` |

The Docker engine must be running. The migration service applies `db/migrations/*.sql` before the seed, API, and worker start.

## Work on HubOS custom code

All custom runtime code is standard JavaScript on Bun. There is no framework or ORM code generator.

```sh
make install
make test
make check
```

Create and apply a database migration with the pinned Dbmate package:

```sh
cd services/hubos
bun run db:new descriptive_change_name
DATABASE_URL=postgresql://hubos:hubos-local-only@localhost:5432/hubos bun run db:up
```

Once a table, constraint, index, or view is declared in SQL, Dbmate records the migration and PostgreSQL enforces it. Application queries use Bun's native PostgreSQL client directly; HubOS does not maintain ORM models in parallel with the database.

## Metabase automatic setup

The development layer runs a one-off, idempotent Bun bootstrap after Metabase and the HubOS seed are ready. On a new application database it:

- creates the first Metabase administrator;
- names the instance `HubOS Monitoring and Evaluation`;
- disables anonymous tracking;
- adds `HubOS PostgreSQL` as a PostgreSQL data source;
- limits discovery to the `analytics` and `public` schemas;
- leaves later starts unchanged when the connection already exists.

The local defaults are:

```text
Email: admin@hubos.local
Password: hubos-local-admin-1
```

Override `METABASE_ADMIN_EMAIL`, `METABASE_ADMIN_PASSWORD`, and the `METABASE_HUBOS_*` variables in `.env` before the first start. If Metabase was already initialized, the bootstrap uses those administrator credentials to add the missing HubOS connection.

Connection credentials saved by Metabase are encrypted with `METABASE_ENCRYPTION_SECRET_KEY`. Preserve that key across restarts and replace the committed local-only example before sharing a deployment. Use a dedicated read-only PostgreSQL account for shared or production environments; the local template falls back to the HubOS database account for convenience.

Local Metabase email is routed to Mailpit, allowing alert and subscription testing without sending external messages.

## Run ODK Central and Headwind MDM

The optional applications retain their upstream build contexts, internal services, volumes, and release paths.

```sh
make ecosystem-setup
make ecosystem-config
make ecosystem-up
```

| Product | Address |
|---|---|
| Headwind MDM | `http://localhost:8081` |
| ODK Central | `https://local:8443` |
| HubOS | `http://localhost:8080` |
| Metabase | `http://localhost:3001` |
| Mailpit | `http://localhost:8025` |

ODK uses its upstream self-signed local certificate, so a browser warning is expected. Create the first ODK administrator after the services are healthy:

```sh
docker compose \
  -f compose.yaml \
  -f compose/mel.compose.yaml \
  -f compose/development.compose.yaml \
  -f compose/ecosystem.compose.yaml \
  exec service odk-cmd --email operator@hubos.local user-create
```

Then promote the same account by replacing `user-create` with `user-promote`.

Before enrolling real devices or collecting real submissions:

- configure real DNS names and HTTPS certificates;
- replace all example passwords, API keys, and shared secrets;
- keep source credentials in a deployment secret store;
- set `FORCE_RECONFIGURE=false` after Headwind's first successful setup;
- configure outbound email, encrypted backups, and restore testing;
- review official upgrade notes before changing pinned versions;
- give HubOS connector accounts only the permissions they need.

## Production boundary

The scaffold is not an internet-ready deployment. Production requires OIDC, tenant authorization tests, secret rotation, domain-specific Caddy configuration, encrypted off-host backups, monitoring of backup age and disk capacity, retention rules, and documented incident ownership.

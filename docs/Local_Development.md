# Contributor environment and testing

Use an isolated source checkout and fictional data to contribute to HubOS. Do not use a live community deployment as a test environment. See [CONTRIBUTING.md](../CONTRIBUTING.md) for code and review conventions.

## Tools and checks

Use the Bun version pinned by CI/container packaging, a running Docker engine and Compose 2.24 or later. No host PostgreSQL or Java installation is needed for container-based application fixtures.

```sh
make install
make test
make check
make compose-config
```

Unit tests do not require source accounts. Native integration suites are opt-in and CI provisions their disposable applications. A skipped integration suite is not a passed compatibility check.

## Start the community demonstration

```sh
cp .env.example .env
chmod 600 .env
docker run --rm -it --network none caddy:2.11.4-alpine caddy hash-password --algorithm bcrypt
```

Choose an operator password and put the returned bcrypt hash in `.env` as a single-quoted `HUBOS_OPERATOR_PASSWORD_HASH`. Configure the username and distinct API/webhook, database, analytics and tool credentials. Preserve encryption secrets across restarts. Public examples are not deployment credentials.

Review [Metabase security/compatibility guidance](Metabase_Compatibility.md) before starting or upgrading a tool image. Keep the demonstration loopback-only and entirely synthetic.

```sh
make demo
```

| Service | Default local address |
|---|---|
| HubOS console | `http://localhost:8080` |
| Metabase | `http://localhost:3001` |
| Uptime Kuma | `http://localhost:3002` |
| Mailpit | `http://localhost:8025` |

The demonstration contains five Ugandan and five Angolan sites, mixing schools, community centres and libraries. Source labels model different equipment, but synthetic data is not proof of a live vendor integration.

## Compose layers

| File | Responsibility |
|---|---|
| `compose.yaml` | Database, migrations, API/console, worker and authenticated Caddy |
| `compose/mel.compose.yaml` | Metabase and its application database/provisioning |
| `compose/monitoring.compose.yaml` | Kuma, provisioning and notification configuration |
| `compose/development.compose.yaml` | Fictional seed data and local email capture |
| `compose/ecosystem.compose.yaml` | Optional upstream Headwind and ODK applications |

The standard demonstration command merges core, analytics, monitoring and demonstration layers. Redis containers belonging to ODK's Enketo subsystem are not a HubOS core dependency.

## Database changes

Declare schema changes as additive SQL migrations. Dbmate records applied migrations and PostgreSQL enforces constraints; do not introduce an ORM schema layer.

```sh
cd services/hubos
bun run db:new descriptive_change_name
```

Apply migrations using a dedicated test database and the configured `DATABASE_URL`. Test upgrades from the previous release as well as fresh databases. Never rewrite a migration already included in a published release.

## Optional upstream applications

```sh
make ecosystem-setup
make ecosystem-config
make ecosystem-up
```

The setup helper fetches pinned upstream projects. Configure them through their upstream procedures, including initial administrator setup, domains, certificates and backups. Do not bypass password-reset policies or certificate validation. Existing externally hosted instances do not need a local duplicate.

## Integration testing

Fixtures use explicit project names, guarded endpoints, isolated volumes and public fictional credentials. Run only the suite matching the disposable service you started. Never point a fixture variable at a production URL.

- `compose/test.compose.yaml`: PostgreSQL migrations, mappings, jobs, reporting permissions, incidents and upgrade preservation.
- `compose/kuma-test.compose.yaml`: real pinned Kuma provisioning, metrics, outage/recovery hooks and Mailpit.
- `compose/metabase-test.compose.yaml`: native dashboard queries, filters, account/resource preservation and alert delivery.
- `compose/metabase-upgrade-test.compose.yaml`: actual Metabase application-database migrations, retained encrypted connections and preservation of operator-owned resources. It starts a legacy image on loopback only; never use this fixture for deployment.
- `compose/headwind-test.compose.yaml`: Community inventory, check-in clocks and reader permissions.
- `compose/odk-test.compose.yaml`: API-only Central, approved OData, reader permissions and upstream form validation.
- `compose/access-test.compose.yaml`: actual HubOS API behind authenticated Caddy.

The [CI workflow](../.github/workflows/ci.yml) is the reproducible command reference. Keep test fixtures and credentials inside test tooling; user guides should explain supported operation, not recount individual runs.

The native Metabase suite starts an ephemeral HubOS receiver on its own private Compose network. Set `HUBOS_TEST_METABASE_PROJECT` to the guarded fixture project name. This exercises the same private webhook destination as an installation without relying on host-gateway aliases or weakening Metabase's network policy.

The ODK runner is `bun scripts/test-odk.js` after starting its named fixture. It creates only fictional accounts/projects and verifies internal addressing, disabled external reporting and Mailpit-only email. Its API checks do not test Central's web UI or ODK Collect.

When cleaning up, specify the exact test Compose file and project. Use `down --volumes` only for disposable fixtures whose data may be destroyed. Never use an unqualified cleanup command against an installation.

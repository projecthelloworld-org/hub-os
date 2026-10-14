# Contributor environment and testing

Use an isolated source checkout and fictional data to contribute to HubOS. Do not use a live community deployment as a test environment. See [CONTRIBUTING.md](../CONTRIBUTING.md) for code and review conventions.

## Tools and checks

Use the Bun version pinned by CI/container packaging, a running Docker engine and Compose 2.24.4 or later. No host PostgreSQL or Java installation is needed for container-based application fixtures.

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
| `compose/tls.compose.yaml` | HTTPS operator origin, certificate provisioning and HTTP redirects |
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
- `services/hubos/test/console.browser.integration.test.js`: authenticated desktop/mobile console, keyboard country filtering, missing-data handling and incident ownership/resolution. All screenshots contain fictional data only.
- `compose/tls-test.compose.yaml` with the access and TLS layers: hostname-verified HTTPS, certificate trust failure, HTTP redirects and operator-origin checks. It uses an isolated local CA and never changes host trust or public DNS.
- `services/hubos/test/installer.integration.test.js`: the real installer on fresh private storage, followed by repeat setup with retained accounts, a live fixture site and an operator-customized dashboard. It creates a tracked source copy and a separate image tag; it does not reuse an existing deployment.
- `services/hubos/test/backup.integration.test.js`: a maintenance-paused snapshot of that disposable installer, fresh-volume restoration, retained site/tool identities and graceful cancellation. The original fixture is preserved; the target must have no retained containers or volumes.
- `services/hubos/test/package-upgrade.integration.test.js`: published v0.1.0 artifacts verified against immutable checksums, followed by an actual piped HTTPS installer upgrade to a sealed candidate. It checks retained identities, observations, mappings, accounts, operator-owned Metabase resources and new monitor/dashboard provisioning.

The [CI workflow](../.github/workflows/ci.yml) provides reproducible commands and the environment settings for each suite. Test output belongs in the pull request or CI artifacts; never attach private deployment configuration or source credentials.

For console browser checks, install the pinned Chromium build and start the disposable access fixture:

```sh
cd services/hubos
bun node_modules/playwright/cli.js install chromium
cd ../..
docker compose -p hubos-v02-access-test -f compose/access-test.compose.yaml up -d --wait
cd services/hubos
HUBOS_TEST_CONSOLE_URL=http://127.0.0.1:13041/ bun test test/console.browser.integration.test.js
```

On Linux, use `install --with-deps chromium` to install browser system dependencies as well. Browser checks modify only the fixture's fictional incident. Restart its API before another run, or after the separate access suite, to reset its in-memory data; then wait for health using the same Compose startup command. Screenshots are written to `output/playwright/` and excluded from source control. Chromium and Playwright are test tools, not production runtime dependencies.

For the native installer rehearsal, set `HUBOS_TEST_INSTALLER_PROJECT=hubos-v02-installer-live-test` and run `bun test test/installer.integration.test.js` from `services/hubos`. The guarded project must have no containers or retained volumes, and loopback ports 19080, 19081, 19082 and 19085 must be available. The suite stops its applications afterward and retains its private configuration/data for diagnostics. Explicitly clean only that disposable project before another fresh rehearsal. This test covers a source installation; a sealed release archive and v0.1.0 package upgrade require their own release checks.

To test recovery afterward, set `HUBOS_TEST_BACKUP_SOURCE_DIR` to that suite's temporary installation directory and run `bun test test/backup.integration.test.js`. Only its explicitly owned project is accepted. The restore target uses `hubos-v02-recovery-test` and loopback ports 19180, 19181, 19182 and 19185; it must start with no retained storage. Private backups stay in temporary storage and must never be uploaded as CI artifacts.

For the package upgrade rehearsal, set `HUBOS_TEST_PACKAGE_PROJECT=hubos-v02-package-test` and run `bun test test/package-upgrade.integration.test.js` from `services/hubos`. This guarded namespace must have no containers or retained volumes. It uses loopback ports 19280, 19281, 19282, 19285 and 19494, isolated application image names and synthetic data only. Its temporary package server uses a test certificate trusted only by the fixture's curl process; host certificate trust is unchanged.

The legacy fixture restores the public file permissions recorded in the original archive before building its unchanged runtime, because v0.1.0's private extraction mask can leave source files unreadable to non-root containers. Only fixture namespaces, image names and source permissions are adjusted; published artifacts are never replaced. The candidate package retains the source version until release verification is complete. Applications are stopped after the test, with private fixture configuration/data retained for explicit inspection or cleanup.

The native Metabase suite starts an ephemeral HubOS receiver on its own private Compose network. Set `HUBOS_TEST_METABASE_PROJECT` to the guarded fixture project name. This exercises the same private webhook destination as an installation without relying on host-gateway aliases or weakening Metabase's network policy.

The ODK runner is `bun scripts/test-odk.js` after starting its named fixture. It creates only fictional accounts/projects and verifies internal addressing, disabled external reporting and Mailpit-only email. Its API checks do not test Central's web UI or ODK Collect.

When cleaning up, specify the exact test Compose file and project. Use `down --volumes` only for disposable fixtures whose data may be destroyed. Never use an unqualified cleanup command against an installation.

# Monitoring and alerts

Current-status dashboard cards filter on their evaluation time (`as_of`), while
historical cards filter evidence/event dates. This keeps old, stale and never-collected
sites visible under the default current reporting period. Current cards do not
reconstruct past state. Observation timestamps remain visible, and unknown is not
healthy. Plugins may declare `evidence_max_age_seconds` independently of polling
freshness; both report validity and successful collection must then be current.

Metabase uses `MB_HTTP_CHANNEL_HOST_STRATEGY=allow-private` so its authenticated
HTTP channel can reach HubOS on the private Compose backend. Its default
`external-only` policy rejects that route. The selected upstream policy continues
to reject loopback, link-local and known metadata hostnames; it does allow other
private-network destinations, so channel administration is a trusted operator
privilege. HubOS separately requires a distinct source webhook credential. See
[the upstream setting](https://github.com/metabase/metabase/blob/v0.60.7/src/metabase/channel/settings.clj)
and [host validation](https://github.com/metabase/metabase/blob/v0.60.7/src/metabase/util/http.clj).

Implementation in progress for v0.2.0. Native Metabase setup, filter queries and fault/recovery delivery have been exercised locally alongside the Kuma/incident path. The complete installer, final rendered templates, supported upstream version review and backup flow remain release gates.

## Reachability is not community internet availability

The stack includes Uptime Kuma **2.5.6**, pinned to the Docker manifest digest `sha256:9912da7d7d9b6ddc0c2d904beb84d24689c1ed9c33b81419eb9008663a92a329`. Its default local UI is `http://localhost:3002`, with a persistent `kuma-data` volume. SQLite is private to Kuma; PostgreSQL holds the shared reporting evidence.

Starter monitors check HubOS API/database readiness and Metabase health. These measure the monitoring infrastructure, not a community site's WAN. Demonstration mode adds explicitly labelled synthetic community-site targets. Their faults are generated examples, not live deployment results.

Extra community targets require an enabled entry in a reviewed local configuration, a canonical site ID and a reachable URL. Copy `config/kuma/monitors.example.json` to `config/kuma/monitors.json` and set `KUMA_MONITOR_CONFIG=/config/kuma/monitors.json`. Private school/router addresses are not presumed reachable from the central installation. Provisioning fails clearly on an unreachable configured target; it never substitutes a healthy fictional monitor. A reachable HTTP service still does not prove that users at a community site can access the internet.

`interval_seconds` and `max_retries` configure the check cadence and the number of retries before Kuma declares a failure. Native Kuma edits are preserved on repeat provisioning. Default starter checks have no retry delay; use explicit community settings appropriate to the target rather than treating this as a universal uptime policy.

## Version-isolated integration

The supported `/metrics` endpoint supplies numeric status and response time without a Prometheus server. Labels such as target URL, hostname, names and tags are discarded. Because metrics do not carry heartbeat timestamps, the pinned Socket.IO adapter reads the latest heartbeat and active state to establish freshness. Pending, maintenance, paused, absent, inconsistent and stale evidence is unknown.

The same adapter creates the first administrator, an API key and the owned webhook provider and monitors. This internal interface is not guaranteed stable upstream: HubOS refuses versions other than 2.5.6, and tests the real pinned image. Source: [Kuma internal interface](https://github.com/louislam/uptime-kuma/wiki/Internal-API), [pinned implementation](https://github.com/louislam/uptime-kuma/tree/2.5.6/server).

Repeat provisioning preserves existing accounts and monitor edits, reuses managed IDs and refuses ambiguous or missing managed resources. It never disables existing two-factor authentication or resets a password. The generated metrics key is stored in a private, mode-600 file in the `hubos-secrets` volume, not in reporting tables. If that file is lost while the managed key remains in Kuma, provisioning stops for operator recovery rather than creating duplicate keys silently. Back up this volume with core configuration; it contains credentials.

## What uptime and coverage mean

An observation supports at most the configured monitor interval, ending earlier when another observation arrives. No observation is carried across a long gap. Unknown intervals do not contribute healthy time.

- **Observed uptime** = observed up seconds / observed known seconds. It is unavailable when no known evidence exists.
- **Observation coverage** = observed known seconds / eligible seconds since monitor creation within the reporting window.
- **Response time** = time-weighted mean of available response times during observed up intervals; down/unknown samples have no response-time value.

Daily reporting uses UTC boundaries. Combined uptime and coverage must use summed numerators and denominators, not an average of site percentages. High observed uptime with low coverage is not evidence of continuous service. Infrastructure and community scopes remain explicit in the analytics views.

## Signal and incident lifecycle

Kuma's authenticated webhook enters `/api/v1/source-connections/{sourceId}/webhook`. The installed plugin projects the vendor message into validated monitor samples and operational signals; core code has no vendor-specific webhook handler. The source-specific `x-hubos-webhook-key` is distinct from browser/operator and observation-ingest credentials.

Signals have a configured rule, mapped site or monitor, timestamp and active/healthy/unknown state. Rules are availability, collection freshness, managed-device check-in and operational field faults. Metabase owns data-based alert evaluation; silence from any evaluator never marks a fault recovered.

## Native Metabase reporting and data alerts

Provisioning creates four dashboards: Community Operations, Availability & Connectivity, Devices & Field Evidence, and Collection & Support. Fifteen questions use only analytics views, with community-site, country and UTC-date filters. The default rolling period includes today. Infrastructure checks explicitly ignore community-site/country filters and remain separate from community connectivity. Generic telemetry includes new canonical plugin metrics without a vendor-specific schema.

The reporting login can select analytics views but cannot read raw configuration tables or modify persistent application data. It uses UTC and defaults to read-only transactions. Credentials remain in private deployment settings and the tool connection, not reporting views. Existing administrator accounts and uniquely identified PostgreSQL connections are retained; a missing tracked or ambiguous connection requires review rather than silent replacement.

Owned resource IDs track two collections, four dashboards, fifteen reporting questions, eight active/healthy rule questions, one authenticated HTTP channel and eight native notifications. Repeat setup preserves existing question/dashboard edits. Templates are initial defaults, not a remote reset mechanism for user-customised layouts. Incomplete dashboard allocation can resume after an interrupted first setup.

Each site/rule combines its source evidence. Any supported fault can activate the rule; all relevant conditions must be explicitly healthy to recover. Missing, stale, disabled or invalid conditions prevent false recovery. `freshness_seconds` sets a source's collection limit; source configuration `alert_thresholds.stale_device_count` and `alert_thresholds.fault_count` set non-negative count thresholds (default zero). Kuma cadence/retries govern reachability thresholds. Read-time site status expires after five minutes; evidence more than one minute ahead of the clock is unknown, not healthy.

Metabase sends native `has_result` notifications repeatedly through a private-header-authenticated, source-scoped HubOS webhook. Approved question IDs determine the rule/state; creator names, image data, question URLs and unapproved columns are discarded. Empty channel tests are not health evidence. Core incidents/outbox coordination is shared with Kuma, not duplicated inside the dashboards.

The exercised compatibility baseline is Metabase v0.60.7. Its upstream support/security status must be reviewed and the chosen release version reverified before v0.2.0 publication; these checks are not a claim of production readiness.

An active signal opens one incident. Further active signals update it while preserving acknowledgement and ownership. Older or equal-time signals are ignored. Only newer, explicit healthy evidence records recovery. Unknown evidence preserves an existing incident without sending another opening message. A later new outage after recovery opens a new incident.

Opening and recovery notifications are written to a PostgreSQL outbox in the same transaction as the incident transition. Delivery retries have bounded exponential delays; expired sending leases are reclaimed after worker restarts. A recovery message waits for the opening message to be delivered or exhaust its retries. SMTP delivery is at-least-once across a crash immediately after SMTP acceptance; a stable message ID helps recipients deduplicate, but HubOS does not claim exactly-once email delivery.

Local delivery goes to Mailpit and uses the fictional recipient `operator@hubos.local`. External SMTP requires `HUBOS_NOTIFICATION_MODE=smtp`, a configured host and explicit recipients. TLS is required for external SMTP. Credentials are deployment environment/secrets, never dashboard fields. `HUBOS_NOTIFICATION_MODE=disabled` leaves messages queued rather than pretending they were delivered.

## Local integration verification

The isolated fixture uses `compose/test.compose.yaml` for PostgreSQL and `compose/kuma-test.compose.yaml` for Kuma, a controllable synthetic probe and Mailpit. It verifies fresh and repeat setup, preservation of monitor edits/accounts, live metrics, native authenticated outage/recovery webhooks, incident deduplication, pause-as-unknown and actual email delivery. All fixture credentials are public test values and must not be reused for deployments.

Run database migrations, start the Kuma fixture, then run the tests from `services/hubos` with `HUBOS_TEST_DATABASE_URL=postgresql://hubos_test:fixture-only-not-for-deployment@127.0.0.1:15432/hubos_test` and `HUBOS_TEST_KUMA_URL=http://127.0.0.1:13002`. CI binds only its ephemeral callback receiver to the Docker host gateway; installed HubOS ports default to loopback.

The fixture metrics key `/tmp/hubos-kuma-fixture-metrics.key` belongs to its test volume. Reset both together when starting a fresh fixture; never use this cleanup procedure for a real Kuma deployment. Consistency-safe backup/restore tooling, with a brief Kuma maintenance pause, is still a release gate and must not be inferred from these integration checks.

`compose/metabase-test.compose.yaml` adds a disposable native Metabase instance at `http://127.0.0.1:13021`. Start PostgreSQL under project `hubos-v02-foundation-test` first; Metabase joins its private network and reaches `db:5432`. A different test project needs `HUBOS_TEST_DB_NETWORK=<project>_default`. Do not expose PostgreSQL on a public host binding to make container access work.

Run `test/metabase.integration.test.js` with the same database fixture, `HUBOS_TEST_METABASE_URL=http://127.0.0.1:13021` and the Kuma fixture's Mailpit. It requires a fresh Metabase volume, creates a random reporting database/role, exercises a retained legacy account/connection, repeat setup, real saved queries and native webhook/mail delivery, then removes only its own reporting database/role. CI exposes only its ephemeral callback receiver through the Docker host gateway; the fresh fixture refuses to run against another URL or an already-configured account.

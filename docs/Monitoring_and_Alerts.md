# Monitoring and alerts

Implementation in progress for v0.2.0. This document describes the locally exercised Kuma and incident path; Metabase data-alert provisioning and the complete installer/backup flow remain separate release gates.

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

Signals have a configured rule, mapped site or monitor, timestamp and active/healthy/unknown state. Rules are availability, collection freshness, managed-device check-in and operational field faults. Metabase will own data-based alert evaluation; silence from any evaluator never marks a fault recovered.

An active signal opens one incident. Further active signals update it while preserving acknowledgement and ownership. Older or equal-time signals are ignored. Only newer, explicit healthy evidence records recovery. Unknown evidence preserves an existing incident without sending another opening message. A later new outage after recovery opens a new incident.

Opening and recovery notifications are written to a PostgreSQL outbox in the same transaction as the incident transition. Delivery retries have bounded exponential delays; expired sending leases are reclaimed after worker restarts. A recovery message waits for the opening message to be delivered or exhaust its retries. SMTP delivery is at-least-once across a crash immediately after SMTP acceptance; a stable message ID helps recipients deduplicate, but HubOS does not claim exactly-once email delivery.

Local delivery goes to Mailpit and uses the fictional recipient `operator@hubos.local`. External SMTP requires `HUBOS_NOTIFICATION_MODE=smtp`, a configured host and explicit recipients. TLS is required for external SMTP. Credentials are deployment environment/secrets, never dashboard fields. `HUBOS_NOTIFICATION_MODE=disabled` leaves messages queued rather than pretending they were delivered.

## Local integration verification

The isolated fixture uses `compose/test.compose.yaml` for PostgreSQL and `compose/kuma-test.compose.yaml` for Kuma, a controllable synthetic probe and Mailpit. It verifies fresh and repeat setup, preservation of monitor edits/accounts, live metrics, native authenticated outage/recovery webhooks, incident deduplication, pause-as-unknown and actual email delivery. All fixture credentials are public test values and must not be reused for deployments.

Run database migrations, start the Kuma fixture, then run the tests from `services/hubos` with `HUBOS_TEST_DATABASE_URL=postgresql://hubos_test:fixture-only-not-for-deployment@127.0.0.1:15432/hubos_test` and `HUBOS_TEST_KUMA_URL=http://127.0.0.1:13002`. CI binds only its ephemeral callback receiver to the Docker host gateway; installed HubOS ports default to loopback.

The fixture metrics key `/tmp/hubos-kuma-fixture-metrics.key` belongs to its test volume. Reset both together when starting a fresh fixture; never use this cleanup procedure for a real Kuma deployment. Consistency-safe backup/restore tooling, with a brief Kuma maintenance pause, is still a release gate and must not be inferred from these integration checks.

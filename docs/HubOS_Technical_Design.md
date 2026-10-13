# HubOS technical design

HubOS is a modular operations layer for community connectivity. It combines evidence from existing systems, maps that evidence to stable community-site identities, and helps operators identify and respond to support needs.

This document describes the monitoring architecture. [Release boundaries](Roadmap.md) distinguish published capabilities from planned extensions. Schools, community centres, libraries and other shared spaces use the same model.

## Principles

- Keep the core small and use established open-source tools.
- Connect existing systems rather than replacing their management functions.
- Use one canonical identity and metric model across connectors.
- Treat missing or stale evidence as unknown.
- Collect operational information, not identifiable browsing or respondent histories.
- Make monitoring useful for a support decision, not just a report.

## System boundary

HubOS-owned runtime code is vanilla JavaScript on Bun. PostgreSQL is the shared relational/evidence store and durable job queue. Dbmate manages versioned SQL migrations; there is no custom ORM or parallel schema model.

| Component | Responsibility |
|---|---|
| Caddy | Operator authentication and the HTTP/HTTPS entry point |
| HubOS API and console | Site/source status, operational overview, ingestion and incident interfaces |
| Background worker | Source-driven collection, leases, timeouts, retries and notification delivery |
| PostgreSQL | Canonical identities, mappings, numeric observations, monitors, incidents, jobs and reporting views |
| Metabase | Analytical questions, dashboards and data-based alert evaluation |
| Uptime Kuma | Explicit target reachability checks and reachability alert evaluation |
| Mailpit | Local notification capture without external email delivery |
| Optional Headwind/ODK | Upstream device-management and field-data applications |

Valkey, Prometheus, Grafana, Alertmanager and Superset are not required core services. Kuma's own SQLite storage and databases used by optional upstream applications remain owned by those applications.

## Data and action flow

```text
Source systems → trusted connector → validated mapping and numeric projection
                                          ↓
                                      PostgreSQL
                                          ↓
                           dashboards and alert evaluation
                                          ↓
                           authenticated signal → incident
                                          ↓
                            notification → operator response
```

Kuma and Metabase evaluate different conditions and send authenticated, source-scoped webhooks. HubOS coordinates incident identity, ordering, ownership and notification delivery. It does not require a separate alert broker.

## Canonical identities

An organisation contains community sites and source connections. A site's UUID remains stable when its equipment, source or external identifier changes. Its classification is a string such as `school`, `community_centre`, `library` or `other`.

A source connection represents one controller, external instance, form or configured collection account. Several connections can use the same plugin; several can serve one site. External identifiers are scoped to their source, so identical local IDs on different controllers are unrelated.

A verified mapping associates an external identifier with a canonical entity. Several identifiers or monitors may map to the same site. An unmapped identifier is rejected rather than guessed or silently counted.

The database also stores observations, status snapshots, connector jobs/runs, monitors and samples, alert signal state, incidents, notification outbox entries and managed tool-resource identifiers. Separate comprehensive asset, hub and service administration is a [longer-term direction](Roadmap.md), not an implied current registry.

## Evidence model

Connectors emit versioned envelopes containing source identity, external site identity, a stable record identifier, observation time and numeric metric records. The shared runtime validates the envelope, verifies mappings, projects approved attributes and persists canonical observations idempotently.

Each observation has a metric, finite value, unit, quality and truthful evidence time. Source collection success has a separate timestamp. Re-reading a report does not make the report new.

Only approved numeric fields and bounded operational attributes enter reporting storage. Raw source bodies, device numbers, addresses, browsing information, respondent details and credentials are not the reporting model. Canonical site identities remain operationally identifiable to authorised operators; aggregate data should not be described as automatically anonymous.

## Connector architecture

The versioned lifecycle contains a manifest, configuration validation, collection, normalization and health checks. Optional provisioning and webhook methods use the same context. Core routing and scheduling do not contain vendor-specific handlers.

Built-in modules are discovered locally. Additional trusted packages require installation, explicit configuration and a restart—not edits to core imports or database queries. Plugins execute with the HubOS process's privileges; there is no marketplace, remote code download or sandbox guarantee.

Ordinary connectors use canonical metrics and mappings rather than vendor-specific tables. The starter package and conformance checks demonstrate this contract. See [connector plugins](Connector_Plugins.md).

### Initial live interfaces

- **UniFi:** official local Network Integration API, multiple source connections, supported device/client aggregates and optional device statistics. No cloud Site Manager or legacy cookie fallback.
- **Headwind Community:** read-only inventory, group/configuration lookup and check-in aggregates. No enrolment, wipe, lock or device-policy commands.
- **ODK Central:** published operational forms through REST authentication and selected OData fields. No unrestricted respondent export or form management by collectors.

Detailed configuration and compatibility boundaries are in [connector guides](Live_Connectors.md). Solar, ISP and additional router interfaces are separately listed in the roadmap.

## Dashboards and interpretation

The monitoring templates provide four dashboards:

1. Community Operations.
2. Availability & Connectivity.
3. Devices & Field Evidence.
4. Collection & Support.

They include site, country and date controls, collection freshness, incidents and a generic telemetry view. The PostgreSQL analytics account can read reporting views but cannot read raw configuration or modify application data.

Current-state cards filter evaluation time; historical cards filter evidence time. Current cards do not reconstruct a past state. Provisioning tracks managed resource IDs and preserves user-customized questions, dashboards and tool accounts on repeat startup.

Uptime and observation coverage are reported together. A sample supports at most its configured observation interval; no healthy value is stretched across an unexplained gap. Missing response-time values are unavailable, not zero.

Infrastructure monitors describe HubOS services. A community monitor describes only its explicitly configured reachable target. Neither controller uptime nor an external website's availability proves that people at the community site can use the internet. See [monitoring definitions](Monitoring_and_Alerts.md).

## Alerts and incidents

The basic rule set covers availability, collection freshness, stale device check-ins and operational fault reports. Thresholds are deployment configuration, not universal assumptions about site performance.

Signals carry a subject, rule, timestamp and active/healthy/unknown state. Repeated active signals update one active incident and preserve its owner/acknowledgement. Older or equal-time signals cannot override newer evidence. Silence and unknown evidence do not automatically recover an incident.

New explicit healthy evidence records automatic recovery. Manual resolution records an operator decision and explanation; it is not a substitute for measured recovery evidence. More elaborate escalation and maintenance workflows are outside the basic incident model.

Incident transitions and notification-outbox entries share a database transaction. Workers lease delivery attempts, retry failures and reclaim abandoned work after a restart. SMTP delivery is at-least-once around a crash after server acceptance; HubOS does not promise exactly-once email.

## Reliability

Collection uses bounded response sizes, deadlines and cancellation. Pagination must progress, remain complete and stay within collection limits. Authentication failures, malformed responses and incomplete inventories cannot produce healthy zero measurements.

Jobs have renewable leases and fencing tokens. An abandoned worker cannot complete work owned by a newer worker. Source freshness and observation validity are evaluated independently.

These are central-runtime safeguards. Persistent site-side buffering, backfill and quarantine/replay require separate extensions and are not implied by ordinary retry support.

## Access and privacy

Caddy authenticates operators. Ingestion and source webhooks use distinct machine credentials, not browser passwords. The API is not directly published; local service bindings are private by default. Remote source connections require certificate-verified HTTPS, with a deliberate local HTTP exception for isolated demonstrations/tests.

Credentials use environment or mounted-file references and remain outside reporting tables. Operator writes reject foreign browser origins, and JSON request bodies are bounded. The reference boundary is one trusted installation, not a multi-partner security model.

Deployments must define data ownership, permitted fields, controller access, recipients, incident owners, retention, backup custody and patching responsibilities. Retention schedules are policy decisions; automatic pruning should not be assumed from a suggested duration. See [access guidance](Security_and_Access.md) and the [security policy](../SECURITY.md).

## Packaging and lifecycle

Core, analytics, monitoring and demonstration configuration are separate Compose layers. Optional Headwind and ODK applications retain upstream build contexts and lifecycle procedures. An externally hosted tool does not need a duplicate local deployment.

Configuration and persistent volumes are part of the installation. Database migrations are declared in SQL, applied in order and tracked by Dbmate. Released archives, installers, SBOMs and checksums are versioned; published tags/assets must not be changed in place.

Before an upgrade, preserve the HubOS and Metabase application databases, tool storage, configuration and encryption secrets. Rehearse restores in isolated storage. Never test a newer tool image against the original database without a recovery plan. Kuma backups require a consistency-safe maintenance pause, not an uncoordinated copy of live SQLite files.

## Operational success

Useful measures include observation coverage, supported service availability, incident acknowledgement/restoration times and repeat faults. Report sample coverage and meaningful breakdowns alongside aggregates. Set operational targets from a deployment's baseline and support commitments, not arbitrary universal thresholds.

HubOS telemetry does not establish educational impact, unique participants or community benefit. Those questions need separately governed evidence and methods.

## Further reading

- [Project prospectus](HubOS_Open_Connectivity_Prospectus.md)
- [Roadmap](Roadmap.md)
- [Bun SQL client](https://bun.com/docs/api/sql)
- [Dbmate](https://github.com/amacneil/dbmate)
- [PostgreSQL documentation](https://www.postgresql.org/docs/)
- [Metabase documentation](https://www.metabase.com/docs/latest/)
- [Uptime Kuma](https://github.com/louislam/uptime-kuma)

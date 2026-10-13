# Monitoring and alerts

HubOS combines reachability, source freshness, device check-ins, operational reports and incident history. Read evidence quality and scope alongside the apparent status: unknown is not healthy.

## Dashboards

Metabase templates provide Community Operations, Availability & Connectivity, Devices & Field Evidence, and Collection & Support. Site, country and date controls support operational review; generic telemetry can show canonical metrics from additional plugins.

The reporting account can select analytics views but cannot read raw source configuration or modify application data. Provisioning tracks managed IDs and preserves existing accounts, connections and customized questions/dashboards. A missing or ambiguous managed resource requires review rather than silent replacement.

Current-status cards use evaluation time (`as_of`); historical cards use evidence/event dates. This keeps stale and never-collected sites visible in a current view. A current card does not reconstruct its historical state. Report time and source collection time remain separate.

## Reachability scope

Uptime Kuma 2.5.6 is integrated through a version-specific adapter. Its storage remains private to Kuma; canonical monitor samples and reporting evidence are held in PostgreSQL. A Prometheus server is not required.

Starter checks measure HubOS/Metabase infrastructure. Synthetic demonstration checks are explicitly labelled. Community checks are added only for configured, reachable targets with canonical site mappings.

Copy `config/kuma/monitors.example.json` to a private reviewed configuration and select it with `KUMA_MONITOR_CONFIG`. Configure the target, site identity, interval and retry policy deliberately. An unreachable configured target is an error, not a reason to substitute a healthy demo check.

A reachable target proves only that check's result from the monitoring vantage point. Central infrastructure, controller and device uptime must not be presented as community internet availability. Measuring users' connectivity needs an explicitly defined site-perspective observation.

## Uptime, coverage and response time

- **Observed uptime:** observed up seconds divided by observed known seconds; unavailable without known evidence.
- **Observation coverage:** observed known seconds divided by eligible seconds in the reporting window.
- **Response time:** time-weighted mean of available response times during observed up intervals.

A sample supports at most its configured interval, ending earlier when a newer sample arrives. No healthy observation is carried across a long gap. Down or unknown intervals have no response-time value.

Daily reporting uses UTC. Combined ratios use summed numerators/denominators, not averages of site percentages. High observed uptime with low coverage is not evidence of continuous service.

Missing, stale, paused, pending, maintenance or inconsistent checks are unknown. Device check-ins are not human use. For field reports, a separate `evidence_max_age_seconds` horizon can differ from collection freshness; both must support a current result.

## Rules and thresholds

The basic rules cover availability, collection freshness, stale managed-device check-ins and operational faults. Source `freshness_seconds` controls collection age; configured fault/check-in thresholds control count-based conditions. Kuma cadence and retries govern reachability decisions.

Any supported fault can activate a rule. Recovery needs explicit healthy evidence across its relevant conditions. Missing, stale, disabled or invalid evidence prevents a false recovery. Choose thresholds for the deployment rather than treating examples as service guarantees.

## Authenticated alert routing

Kuma and Metabase send signals to `/api/v1/source-connections/{sourceId}/webhook` with a distinct source-specific key. Installed plugins project messages into canonical monitor samples/signals; core code has no vendor-specific webhook handler.

Metabase evaluates data-based questions. Known question identities and approved row fields determine the signal. Creator details, images, URLs and unrelated columns are discarded. An empty connection test is not a measurement and cannot mark a source healthy.

The private Metabase HTTP-channel policy permits the Compose route while retaining upstream loopback/link-local restrictions. It is not a per-host allowlist: editing channel destinations is a trusted operator privilege. Use the setting appropriate to the pinned version; see [Metabase compatibility](Metabase_Compatibility.md).

## Incident and notification behaviour

An active signal opens one incident. Repeated signals update it without repeated opening notifications and preserve acknowledgement/ownership. Older or equal-time signals are ignored. Unknown or missing evidence preserves the incident; only newer explicit healthy evidence records automatic recovery.

Manual resolution records an operator's decision and explanation, not proof of measured recovery. A new outage after recovery can open a new incident.

Incident transitions and notification-outbox entries are transactional. Delivery has bounded retries and leased restart recovery. SMTP delivery is at-least-once around a crash after server acceptance; exactly-once email is not guaranteed.

Local messages go to Mailpit. External SMTP needs `HUBOS_NOTIFICATION_MODE=smtp`, a configured host, explicit recipients and TLS. Credentials remain in protected deployment settings. Disabled delivery leaves messages queued rather than pretending they were sent.

## Preserve tool state

Repeat provisioning does not reset Kuma accounts, disable two-factor authentication or overwrite monitor edits. The generated metrics key lives in private `hubos-secrets` storage. Losing that file requires deliberate recovery, not silent duplicate-key creation.

Back up tool databases, managed secret storage and configuration together. A consistency-safe Kuma backup needs a documented maintenance pause; do not copy a live SQLite file uncoordinated. Use upstream restore/upgrade guidance and isolated restore tests.

## References

- [Kuma internal interface](https://github.com/louislam/uptime-kuma/wiki/Internal-API)
- [Kuma 2.5.6 implementation](https://github.com/louislam/uptime-kuma/tree/2.5.6/server)
- [Metabase webhooks](https://www.metabase.com/docs/latest/configuring-metabase/webhooks)

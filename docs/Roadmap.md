# HubOS roadmap

HubOS grows through versioned, reusable capabilities rather than a fixed pilot or calendar. Release notes and tagged documentation define what a published package includes. A planned feature is not a deployment guarantee.

## v0.1.0 — released demonstration

The first release provides the Bun API and operator console, PostgreSQL data model and jobs, Dbmate migrations, synthetic collection, basic incident acknowledgement/resolution, Metabase database bootstrap, optional ODK/Headwind deployment templates and an interactive HTTPS installer.

Its demonstration contains five fictional school sites in Uganda and five in Angola. It is not a connected production monitoring system: live vendor collection, automatically provisioned dashboards and alerts, and complete real-data safeguards are not part of that release.

## v0.2.0 — community-site monitoring

The next release focuses on monitoring and supporting community connectivity:

- Community sites as the primary concept, with a mixed school, community-centre and library demonstration.
- Four automatically provisioned Metabase dashboards, read-only analytics and data-based alerts.
- Uptime Kuma, explicit target configuration and coverage-aware availability.
- Read-only UniFi local Network, Headwind Community and ODK Central connectors.
- Trusted local plugin packages using canonical metrics and mappings.
- Protected site/source/mapping administration and connection testing.
- Authenticated incident routing, deduplication, ownership and notification retries.
- Separate demonstration/live installation modes, provisioning checks and private defaults.
- Basic operator access, source-specific credentials, data minimisation and backup/restore procedures.

Publication requires fresh/repeat installation, compatibility, upgrade, privacy, alert, restore and CI checks. Until publication, the public installer continues to serve v0.1.0. These release requirements do not imply full multi-partner production hosting.

## v0.3.0 — broader collection and intermittent connectivity

- MikroTik/RouterOS and The Dude.
- Innovex REMOT and ISP imports.
- Additional solar and open IoT integration paths.
- Persistent site-side offline buffering and historical backfill.
- Controlled quarantine and replay.

Central scheduling, timeouts, retries and worker restart recovery belong to the monitoring core; they do not depend on these extensions.

## Longer-term directions

Advanced asset administration, partner isolation and managed hosting, OIDC/MFA, richer maintenance/escalation workflows, RADIUS vouchers and an optional Superset deployment are outside the v0.2.0 boundary.

Contributors can propose an integration or improvement through a repository issue. Include the operational need, supported upstream interface, privacy boundary and a practical test approach. See [contribution guidelines](../CONTRIBUTING.md).

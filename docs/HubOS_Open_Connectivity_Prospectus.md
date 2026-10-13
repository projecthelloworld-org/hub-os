# HubOS: open infrastructure for community connectivity

HubOS helps communities and their support partners keep shared connectivity useful. It is an open-source, self-hostable operations layer for schools, community centres, libraries and other shared spaces.

This prospectus is for potential users, implementing organisations, technology partners, governments, funders and contributors. [Release notes and the roadmap](Roadmap.md) distinguish available packages from planned capabilities.

## Installation is only the beginning

A community site can have an internet connection, Wi-Fi and shared devices and still be effectively offline. An access point fails, devices stop checking in, a connection becomes unstable, or a fault goes unreported until a support visit.

The information may already exist in several systems, but no one has a clear view of what needs attention. HubOS combines approved evidence so operators can spot issues, coordinate support and learn from the response.

The point is practical: know what is working, know what is unknown, and make it easier for someone to act. A dashboard is not the outcome; a working community service is.

## What HubOS brings together

HubOS connects existing systems rather than replacing them. Its monitoring architecture combines reachability checks, supported network-controller aggregates, managed-device check-ins, operational field reports, collection freshness and incident history.

The initial live connector modules focus on the official local UniFi Network API, Headwind Community and ODK Central. Additional router, ISP, solar and IoT interfaces are part of the expansion roadmap. A trusted plugin contract allows contributors to add products without rebuilding the core data model.

Every source is mapped to a stable community-site identity. Several controllers or external identifiers can describe one site without making it several sites in a report.

## Designed for action

Operators need to know which sites need attention, whether the information is recent, what evidence supports a fault and who is handling it.

HubOS's monitoring design provides operations dashboards, explicit reachability checks, data-based alerts and a shared incident ledger. Repeated signals update the same active incident. Recovery needs explicit evidence; missing data cannot quietly turn a problem green.

Local people remain essential. Monitoring cannot repair equipment, call an ISP or verify that a service meets community needs. It should make those actions easier to prioritise and record.

## Evidence that can be trusted

HubOS distinguishes the service from the monitoring system:

- A healthy central server is not proof of a site's internet connection.
- An online router is not proof that people can use the service.
- Device check-ins are not learner activity or unique participants.
- Missing observations are unknown, not healthy.
- Uptime must be read alongside observation coverage.

Operational measures include evidence coverage, supported availability and the time taken to acknowledge and restore service. Targets should reflect local baselines and support commitments.

The product does not claim educational or social impact from infrastructure telemetry alone. Programme evaluation requires separately governed human evidence and an appropriate method.

## Open tools and local control

The core uses established open-source tools and a small integration layer: Bun and vanilla JavaScript, PostgreSQL, Dbmate, Caddy, Metabase and Uptime Kuma. ODK Central and Headwind MDM can be optional local applications or existing external services.

HubOS-owned code and documentation use MIT. Partners can inspect, self-host, adapt and contribute to the project. Third-party components keep their own licences, and a connected router or service does not have to be open source for its approved interface to be usable.

Self-hosting avoids a compulsory HubOS subscription, but does not eliminate infrastructure, security, maintenance or support costs. An organisation must still own its deployment and support process.

## Responsible data use

The reporting model uses approved numeric operational evidence, not identifiable browsing histories, respondent records or raw vendor exports. Credentials are kept outside reporting data. Community infrastructure identities remain accessible to authorised operators and must be protected appropriately.

Each organisation decides who may access the system, which fields may be collected, how long data is retained and what may be shared. Advanced multi-partner hosting and identity controls are future work, not assumptions about the basic installation.

## A reusable demonstration

The community-site demonstration contains ten fictional locations: five in Uganda and five in Angola, mixing schools, community centres and libraries. It helps users explore the product without exposing real community or device data.

Synthetic data does not establish field performance, national-scale capacity or compatibility with every installation. Real deployments need their own source verification and operational acceptance.

## Ways to participate

- **Use and evaluate:** try a release, document practical needs and share non-sensitive feedback.
- **Connect systems:** contribute read-only connectors and sanitised compatibility tests.
- **Improve support:** refine dashboards, incident guidance, accessibility and runbooks with operators.
- **Strengthen evidence:** improve metric definitions, data quality and responsible evaluation methods.
- **Fund maintenance:** support security reviews, interoperability, translations, testing and long-term stewardship.
- **Support deployments:** help organisations operate infrastructure and preserve local ownership of data.

Contributions should become reusable project capabilities rather than one-off scripts hidden inside a deployment. See [contribution guidelines](../CONTRIBUTING.md).

## Sustainability and growth

The near-term priority is dependable monitoring, not the largest possible feature list. Further collection paths, offline buffering and richer operations can build on the same canonical model and plugin boundary.

Future managed hosting can serve organisations without an internal platform team, provided access/isolation controls are explicitly implemented and the self-hosted option remains viable. Monitoring, access vouchers and hosted services have different responsibilities; they should not be bundled implicitly.

HubOS invites users and contributors to build a shared operations layer that is practical to run, open to improve and honest about the evidence it has.

## Learn more

- [Technical design](HubOS_Technical_Design.md)
- [Installation](Installation.md)
- [Monitoring and alerts](Monitoring_and_Alerts.md)
- [Connector compatibility](Live_Connectors.md)
- [Roadmap](Roadmap.md)

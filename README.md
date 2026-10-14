# HubOS

Open-source monitoring and support for shared community connectivity.

HubOS brings network, device, reachability and field-report evidence into one operational view. It helps operators see which community sites need attention, understand what the evidence supports, and coordinate a response. Schools, community centres and libraries use the same site model.

HubOS is self-hostable and modular. Its custom code is vanilla JavaScript on Bun; PostgreSQL holds canonical data and jobs; SQL migrations use Dbmate. Metabase provides reporting, Uptime Kuma provides reachability checks, and Caddy protects operator access. ODK Central and Headwind MDM can be hosted alongside HubOS or connected as external services.

## Install the stable release

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | bash
```

The installer runs interactively in your terminal, checks dependencies and verifies the release archive before extraction. Review a downloaded script before running it. See the [installation guide](docs/Installation.md) for requirements, version selection and configuration.

This source tree contains **v0.2.0 community-site monitoring**. The stable installer follows the latest published GitHub release; unpublished source changes do not alter it. Use the documentation at your installed release tag and the [roadmap](docs/Roadmap.md) when selecting capabilities. The earlier v0.1.0 package is a synthetic demonstration scaffold, not the complete monitoring product.

Before running v0.1.0, read its [Metabase security warning](docs/Metabase_Compatibility.md). Its bundled 0.60.7 image predates a critical fix and must not be exposed publicly.

## What the monitoring architecture provides

- A canonical community-site registry with source-scoped external identifiers.
- A source-driven plugin interface for trusted local connector packages.
- Metabase dashboards for operations, availability, devices, field evidence and support.
- Reachability checks with uptime and observation coverage reported together.
- Authenticated signals, deduplicated incidents and durable notification delivery.
- Read-only UniFi local Network, Headwind Community and ODK Central connector modules.
- A fully synthetic demonstration: five sites in Uganda and five in Angola.

The demonstration is not a field trial. Device check-ins are not human usage, controller uptime is not community internet availability, and missing data is unknown—not healthy. [Monitoring definitions](docs/Monitoring_and_Alerts.md) explain these boundaries.

## Explore or contribute

Start with the [documentation index](docs/README.md). For a source checkout, follow [contributor setup](docs/Local_Development.md), including operator authentication and private credentials before starting Compose.

```sh
make install
make test
make check
make compose-config
```

Contributions to connectors, dashboards, accessibility, translations, runbooks, deployment guidance and testing are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [plugin guide](docs/Connector_Plugins.md).

## Operate responsibly

Use read-only source accounts, verified TLS for remote connections and private service bindings. Keep credentials outside reporting tables and never commit real device, respondent or browsing data. Each deployment needs an owner, an incident-response process and tested backups. Basic single-installation access controls are not multi-partner isolation or a production-security certification.

Read the [access guide](docs/Security_and_Access.md) and [security policy](SECURITY.md). Report vulnerabilities privately.

## Learn more

- [Technical design](docs/HubOS_Technical_Design.md)
- [Project prospectus](docs/HubOS_Open_Connectivity_Prospectus.md)
- [Connector compatibility](docs/Live_Connectors.md)
- [Roadmap](docs/Roadmap.md)
- [Changelog](CHANGELOG.md)

## Licence

HubOS-owned code and documentation use the [MIT License](LICENSE). Third-party components retain their own licences. Tagged releases include an SPDX software bill of materials and SHA-256 checksums.

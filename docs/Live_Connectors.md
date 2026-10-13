# Connecting source systems

HubOS connectors use a common source connection, verified site mappings and numeric evidence store. A connection to a source does not transfer management responsibility to HubOS.

Use the connector documentation shipped with your release. [The roadmap](Roadmap.md) distinguishes the initial live modules from later router, ISP and solar integrations.

## Configure a connection

Each source record defines its plugin, base URL, enabled state, collection mode, polling/freshness limits, non-secret settings and organisation scope. Credential settings contain references, not literal passwords or tokens:

```json
{"credential_refs": {"apiKey": "env:SOURCE_API_KEY"}}
```

The private deployment environment or mounted secret file supplies the referenced value. Optional environment variables can be stored in the Git-ignored `config/source-secrets.env`; keep it owner-readable only. Never use a personal identifier as a site code.

Several connections may use the same plugin, such as multiple UniFi controllers or ODK forms. Map the external identifiers within each source to canonical HubOS site IDs. Multiple identifiers can represent one site; identical local IDs on different sources are unrelated.

## Initial modules

| Module | Evidence | Required identity | Guide |
|---|---|---|---|
| `unifi` | Supported adopted-device/client aggregates and fresh optional statistics | Local API key and controller-site mappings | [UniFi](connectors/unifi.md) |
| `headwind` | Inventory and recent/stale/unknown device check-ins | Scoped Community reader and group/configuration mappings | [Headwind](connectors/headwind.md) |
| `odk` | Approved operational fields from a published form | Project Viewer Web User and infrastructure site-code mappings | [ODK](connectors/odk.md) |

UniFi compatibility is contract-tested against the documented API versions. Headwind and ODK tests also exercise actual upstream applications. These are bounded compatibility claims, not universal deployment certification. Confirm the target installation's interface, privileges, schema and certificate trust before collection.

Collectors authenticate and read only. They do not enrol devices, alter policies, publish forms, grant privileges, reboot routers or change infrastructure configuration. Setup by a source administrator is separate from collection.

## Read evidence correctly

- Controller/device uptime is not community internet availability.
- Connected-client counts are not unique people.
- Device check-ins are not charging, application use or learning activity.
- Re-reading a report does not change its inspection time.
- Missing or stale fields are unavailable, not zero.
- Authentication, pagination or mapping failure cannot replace complete evidence with a healthy empty inventory.

## Transport and privacy

Remote base URLs require certificate-verified HTTPS. Configure private CA trust deliberately; do not disable verification. `allow_local_http: true` is an explicit isolated demo/test exception for loopback or a single-label private Compose hostname, not a remote HTTP fallback.

Source configuration is administrator-controlled. These clients are not an SSRF sandbox. Raw bodies, addresses, device identifiers, respondent fields and secrets are removed before reporting persistence; only approved numeric evidence and bounded diagnostics are retained.

To add another product, follow the [trusted plugin guide](Connector_Plugins.md). A new ordinary connector uses canonical metrics and mappings without vendor-specific core queries or tables.

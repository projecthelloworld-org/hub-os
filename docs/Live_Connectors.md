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

## Register, map and enable

The v0.2.0 source tree provides protected administration under `/api/v1`; these routes are not part of the published v0.1.0 API. Use Caddy's operator login, not an ingestion key. Read organisation and site UUIDs from `/api/v1/organisations` and `/api/v1/sites`, and installed plugin manifests from `/api/v1/connectors`.

1. Register a connection with `POST /api/v1/source-connections`. Supply `organisation_id`, `name`, `plugin_id`, a supported `collection_mode`, its base URL and non-secret `config`. Credential values stay in the private environment or secret files. New connections are always disabled; callers cannot supply health or collection timestamps.
2. Add infrastructure associations with `POST /api/v1/source-connections/{sourceId}/mappings`. Supply `site_id` and `external_id`. Verification defaults to false; set `verified: true` only after checking the association. Use infrastructure IDs, never personal identifiers or email addresses.
3. Test access with `POST /api/v1/source-connections/{sourceId}/test` and an empty JSON object. The plugin performs read-only requests. Success confirms source access only; it does not establish community connectivity, validate every collection path or refresh evidence.
4. Enable with `POST /api/v1/source-connections/{sourceId}/enable` and an empty JSON object. Polling requires a verified site mapping and successful access testing. HubOS schedules one collector per connection; repeated activation preserves the existing schedule. Webhook-only sources do not create polling jobs.
5. Confirm actual collection, freshness, supported metrics and incident routing. An enabled source remains unknown until collection succeeds. Read source metadata from `/api/v1/source-connections`; configuration and credential references are not returned.

Remote operator requests require HTTPS. JSON requests must use `Content-Type: application/json`. The OpenAPI description at `/api/v1/openapi.json` lists request fields and error responses. Missing credentials, authentication failures and timeouts return bounded diagnostic codes, not upstream bodies or passwords.

### Changes and pausing

Pause with `POST /api/v1/source-connections/{sourceId}/disable`. This revokes source-scoped collector leases and rejects late observations, monitor measurements and alert signals. Current status becomes unknown; stored history is retained. Pausing is not a healthy recovery signal and does not resolve incidents. Re-enabling a source does not restore a healthy status until fresh collection succeeds.

Status snapshots created before source attribution was available remain stored during upgrades, but cannot establish current health. Fresh, attributed collection restores supported status claims. A status from one source is not evidence that another source or the community internet connection is healthy.

Use `PATCH /api/v1/source-connections/{sourceId}` while disabled to edit its name, URL, complete configuration object or timing limits. A supplied `config` replaces the whole object, including its credential references. Source UUID, organisation, plugin, collection mode and synthetic/live classification stay fixed; register another connection when those identities differ.

List mappings with `GET /api/v1/source-connections/{sourceId}/mappings`. Correct a paused association or change verification with `PATCH /api/v1/source-connections/{sourceId}/mappings/{mappingId}`. A different `site_id` resets verification unless explicitly verified. Mapping UUID and external ID stay fixed; add another mapping for another external ID. Existing observations keep their original site association. Sites must belong to the source's organisation, and tool-owned automatic mappings remain controlled by provisioning.

Current status and metric cards require an active, verified association with that site. After a correction, recent history at the former site is retained but cannot become current merely because collection succeeds at the new site. Re-enabling an unchanged source also leaves metrics unknown until collection succeeds; measurement age and source freshness are separate checks.

Retest and re-enable after changes. If settings change during an access test, activation refuses the outdated result. These organisation checks preserve data relationships; they are not partner access isolation. All operators in this release share installation-wide authority.

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

Remote base URLs require certificate-verified HTTPS. Configure private CA trust deliberately; do not disable verification. `allow_local_http: true` is an explicit local exception for loopback or a single-label private Compose hostname, including a locally hosted source application. It is not a remote HTTP fallback.

Source configuration is administrator-controlled. These clients are not an SSRF sandbox. Raw bodies, addresses, device identifiers, respondent fields and secrets are removed before reporting persistence; only approved numeric evidence and bounded diagnostics are retained.

Registration rejects common literal credential fields and malformed references. This is not an automatic classifier for every secret hidden in arbitrary settings: administrators and plugin authors must keep all configuration non-secret. Operators able to configure sources choose upstream destinations and credential references; grant that authority only to trusted deployment administrators.

To add another product, follow the [trusted plugin guide](Connector_Plugins.md). A new ordinary connector uses canonical metrics and mappings without vendor-specific core queries or tables.

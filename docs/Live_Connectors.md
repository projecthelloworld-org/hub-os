# Initial live connector profiles

The `unifi`, `headwind` and `odk` modules use the same source-driven plugin lifecycle,
canonical site mappings and numeric evidence store. No vendor-specific reporting
tables or core routing changes are needed. They are currently fixture-tested;
local Headwind/ODK integration and release verification remain pending.

Each source has an explicit base URL, plugin ID, enabled flag, polling/freshness
limits, configuration, and verified external-ID mappings. Credentials are references
to environment variables or mounted secret files, not literal configuration values.
Never configure personal fields as site identifiers. Use several source connections
for several controllers or ODK forms. Collection only authenticates and reads:
it never enrols devices, changes configuration, creates forms or grants privileges.

## UniFi

Base URL: `https://<console>/proxy/network/integration/` (deployment-specific official
local paths require capability checks). Configuration:

```json
{
  "credential_refs": {"apiKey": "env:UNIFI_LOCAL_API_KEY"},
  "statistics_max_age_seconds": 300
}
```

Map the controller's site UUID to a HubOS site. API access, device restart uptime,
connected client counts and online access points are not WAN uptime or people counts.
Missing/stale statistics are omitted, not zero-filled. Gateway topology rates are
not summed into invented ISP traffic. External IDs are source-scoped.
Fixtures exercise documented 9.1.120, 9.4.17 and 10.6.106 shapes, not deployed hardware.
Classic standalone Network Server compatibility is not assumed. No cloud or legacy
cookie API fallback exists. See [the compatibility notes](UniFi_Local_API_Notes.md).

## Headwind Community

Base URL is the web application's origin/context. Configuration:

```json
{
  "credential_refs": {"username": "env:HMDM_READER", "password": "env:HMDM_READER_PASSWORD"},
  "check_in_max_age_seconds": 86400
}
```

Map `group:3` and/or `configuration:7`, not names. Multiple mappings to one site
count each device once. A device assigned to different canonical sites fails
collection until the mapping conflict is resolved. Unknown groups and incomplete
inventory fail collection. Devices outside approved mappings are not persisted.
Check-ins are server receipt timestamps, not human/app use. JWT login uses the
upstream password-digest protocol over verified TLS; digests and tokens are secrets.
No licensed analytics or management commands are used. See [the API notes](Headwind_Community_API_Notes.md).

## ODK Central

Use a dedicated Web User with Project Viewer access, not an App User. Password-based
sessions do not support OIDC-only installations. Each source selects one published
form, approved leaf fields and an external site-code field:

```json
{
  "credential_refs": {"email": "env:ODK_READER_EMAIL", "password": "env:ODK_READER_PASSWORD"},
  "project_id": 7,
  "form_id": "hubos-inspection",
  "site_field": "site_code",
  "event_time_field": "reported_at",
  "evidence_max_age_seconds": 604800,
  "require_review_approval": false,
  "approved_fields": {
    "fault_count": "field.report.fault.count",
    "usable_devices": "field.report.devices.usable.count",
    "connectivity_available": "field.report.connectivity.available",
    "power_available": "field.report.power.available"
  }
}
```

Map configured external site codes to canonical sites. Approved fields mean a data
whitelist, not review approval; enable `require_review_approval` when required.
Rejected/problematic/encrypted/missing/stale answers are invalid/unavailable, never
healthy zero values. A query with no relevant report invalidates prior current values;
its collection timestamp is not an inspection time. Otherwise evidence keeps its
event timestamp (or receipt time when no event field is configured). Successful
polling does not make old reports new. The generic `evidence_max_age_seconds` validity
horizon is separate from the source's collection freshness, and both must be current.
The client bounds the crawl to 30 days/2,000 rows, selects latest report per external
site, and rejects unsafe continuation URLs. See [the API notes](ODK_Central_API_Notes.md).

## Transport and privacy

Remote sources require HTTPS with certificate validation. A trusted private CA can
be supplied through the runtime's certificate trust configuration; never disable
TLS validation. `allow_local_http: true` is an explicit local demo/test exception
for loopback or a single-label private Compose hostname, not a remote HTTP fallback.
Do not use this exception for remote exposure. Source configuration is administrator-
controlled; these adapters are not an SSRF sandbox.

Raw vendor bodies, device identifiers, browsing data, credentials, submitter details
and unapproved answers never enter reporting storage. Only mapped numeric evidence
and bounded diagnostic codes are persisted. Pagination/authentication/collection
failure cannot replace complete evidence with a misleading healthy zero inventory.

# ODK Central connector

The `odk` module reads approved operational fields from a published ODK Central form. It does not create forms, change submissions or export unrestricted respondent data.

## Requirements and configuration

Use a dedicated Web User with Project Viewer access to approved projects/forms. An App User is a data-collection identity, not an analytics reader. Password-session authentication is not compatible with OIDC-only Central installations; there is no silent SSO bypass.

Remote instances require verified HTTPS and a correctly configured canonical domain. OData continuation URLs use Central's configured domain, so that address must match the approved base URL and be reachable by the collector.

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

Map each operational site code to a canonical HubOS site. Codes must identify infrastructure, not respondents. Approved fields are a collection whitelist; set `require_review_approval` separately when accepted review status is required.

## Collection contract

The collector creates an authenticated session through `POST v1/sessions`, verifies the configured published form, and reads `v1/projects/{projectId}/forms/{formId}.svc/Submissions`.

`$select` requests only approved leaf fields and necessary system metadata. Whole groups, respondent fields, device IDs and raw XML are not selected. Cursor pagination follows same-origin `@odata.nextLink` values while preserving the approved selection/filter. Redirects, changed selections, repeated IDs/links and incomplete responses are rejected. The crawl is bounded to a 30-day receipt window and 2,000 rows.

The client refreshes a session at most once after 401. A 403 is a permissions failure, not a reason to keep retrying credentials. Session tokens are private in-memory values.

## Four different clocks

- **Report time:** an approved inspection/event field, when configured.
- **Receipt time:** Central's initial `__system.submissionDate`.
- **Update time:** a data or metadata edit; not necessarily a new inspection.
- **Collection time:** when HubOS successfully checked Central.

Polling never re-dates a report. The latest report per external site supplies current evidence; its validity horizon and collection freshness are evaluated separately. A fresh poll with an old report is not fresh operational evidence.

Missing/blank, stale, future, rejected, problematic or unavailable encrypted answers are invalid/unavailable, not healthy zero. A query with no relevant report invalidates previous current values; that collection time is not an inspection time. Recovery requires a later explicit healthy report or other supported evidence.

## Community inspection form

The [bundled inspection form](../../config/odk/hubos-inspection.xml) records an infrastructure site code, inspection time, current fault count, usable shared devices and observed power/connectivity. Unchecked optional values should remain blank.

Review local language, site-code choices, collection policy and Central access before deployment. Validate form changes with the upstream ODK validator and test the collection client. A valid XML form and working API do not establish compatibility with every client, Enketo web-form deployment or field workflow.

## Compatibility

Integration tests exercise Central v2026.2.0 with actual session authentication, Project Viewer permissions, two-page OData, approved-field exclusion and truthful timestamps. No management privilege is required by the collector. Deployment-specific authentication, encryption and schema variants require their own checks.

## Upstream references

- [Central authentication](https://docs.getodk.org/central-api-authentication/)
- [OData endpoints](https://docs.getodk.org/central-api-odata-endpoints/)
- [Central v2026.2.0](https://github.com/getodk/central/tree/v2026.2.0)
- [Pinned backend contract](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/docs/api.yaml)
- [ODK Validate](https://github.com/getodk/validate)

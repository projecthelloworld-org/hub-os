# ODK Central: read-only operational evidence connector

Checked 13 October 2026. These findings use the deployment selected by `scripts/vendor-ecosystem.sh`: **Central v2026.2.0**, repository commit **`ee0e4207ab6fb628247f4d5b5b576325782a5a05`**, with Central Backend submodule **`bee93414a2215bd73d7f371113c6640c66d90c95`**. Source inspection is not a completed local integration test. References to backend source below are pinned to that exact submodule commit. [Central release](https://github.com/getodk/central/tree/v2026.2.0), [pinned backend](https://github.com/getodk/central-backend/tree/bee93414a2215bd73d7f371113c6640c66d90c95)

## Authentication and minimum access

Use a dedicated **Web User** with access only to approved projects/forms. The upstream **Project Viewer** role includes `project.read`, `form.list`, `form.read`, `submission.read`, and `submission.list`, without form/submission management rights. An **App User** is not an analytics credential: it can retrieve collection forms and create submissions, not read existing submission data. Do not automatically grant or change production access. [Viewer role source](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/model/migrations/20190923-01-add-project-viewer-role.js), [official authentication guide](https://docs.getodk.org/central-api-authentication/)

```http
POST /v1/sessions
Content-Type: application/json

{"email":"hubos-reader@example.invalid","password":"<secret actual password>"}
```

HTTP 200 returns a **bare object**, not an `OK/data` envelope:

```json
{
  "createdAt":"2026-10-13T10:00:00.000Z",
  "expiresAt":"2026-10-14T10:00:00.000Z",
  "token":"<secret bearer token>"
}
```

Send `Authorization: Bearer <token>` on subsequent requests. Default session lifetime is 86,400 seconds, but use the returned expiration rather than assuming it. Keep tokens in memory, never in reporting tables, logs or URLs. Cookies returned by login are unnecessary for the collector. A bounded refresh after 401 is appropriate; 403 indicates insufficient rights and must not cause repeated credential retries. Login creates a session and ordinary authentication/audit metadata, but does not alter project/form configuration. [Session resource](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/sessions.js), [session creation/audit](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/http/sessions.js), [expiration validation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/model/query/sessions.js)

Password-session login and Basic authentication are disabled when Central uses OIDC SSO. This collector's password-based profile must report that incompatibility honestly rather than silently bypassing SSO. Basic is discouraged and only accepted over HTTPS; it is not a necessary fallback. Require HTTPS for remote instances and permit plain HTTP only on explicitly local/isolated test infrastructure. [Authentication options and errors](https://docs.getodk.org/central-api-authentication/), [OIDC route condition](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/sessions.js)

## Discovery through REST

| Endpoint | Response shape and use |
|---|---|
| `GET /v1/projects` | Array of permitted projects; each includes numeric `id`, `name`, optional description/encryption metadata and `archived` |
| `GET /v1/projects/{projectId}/forms` | Array of permitted forms; validate `projectId`, `xmlFormId`, `state`, and publication status |
| `GET /v1/projects/{projectId}/forms/{xmlFormId}/submissions?limit=50&offset=0` | Array of submission **metadata**, not approved form-field values |
| `GET /v1/projects/{projectId}/forms/{xmlFormId}.svc` | OData service document, listing `Submissions` and any repeat tables |

Project/form list APIs are not paginated in the pinned contract. An unauthenticated project-list request can legitimately return HTTP 200 with `[]`, so a successful empty project-list response is not an authentication proof. Connection testing should verify the session and explicitly configured project/form access. Form `publishedAt: null` means unpublished; do not silently read draft data as live evidence. Draft OData requires the separate `/forms/{xmlFormId}/draft.svc/...` path. [Project source](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/projects.js), [form source](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/forms.js), [pinned API contract](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/docs/api.yaml)

REST submission metadata includes `instanceId`, `createdAt`, nullable `updatedAt`, nullable `deletedAt`, nullable `reviewState`, and a `currentVersion` object; it can also include personal device/submitter information. The pinned contract still contains an outdated description saying no paging, but its parameters and implementation support **`limit`/`offset`**. It supplies no continuation envelope/count. Offset pagination starts with the latest submission and is vulnerable to changes during a crawl; prefer cursor-based OData for operational field extraction. The optional XML endpoint `/submissions/{instanceId}.xml` contains the full submission and is unnecessary for the normal whitelist-based OData client. [REST submission implementation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/submissions.js), [REST contract](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/docs/api.yaml)

## OData approved-field extraction

For a configured published form, request the root `Submissions` table:

```text
GET /v1/projects/7/forms/hubos-inspection.svc/Submissions
    ?$top=50
    &$select=__id,__system/submissionDate,__system/updatedAt,__system/status,__system/reviewState,__system/deletedAt,site_code,reported_at,fault_count,usable_devices
```

This is an illustrative configuration, **not a claim that every ODK form has those fields**. `site_code`, `reported_at`, `fault_count`, and `usable_devices` are HubOS-approved custom form fields. Build the actual selection from the configured form's whitelist and validated paths. Optional `$filter` can restrict supported system metadata, such as a time window; it cannot arbitrarily filter custom form fields. [Official OData data document](https://docs.getodk.org/central-api-odata-endpoints/#data-document), [pinned endpoint authorization](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/odata.js)

Synthetic example of the selected response shape:

```json
{
  "@odata.context":"https://central.example.invalid/v1/projects/7/forms/hubos-inspection.svc/$metadata#Submissions",
  "value":[{
    "__id":"uuid:11111111-1111-4111-8111-111111111111",
    "__system":{
      "submissionDate":"2026-10-13T10:00:00.000Z",
      "updatedAt":null,
      "status":null,
      "reviewState":null,
      "deletedAt":null
    },
    "site_code":"UG-DEMO-01",
    "reported_at":"2026-10-12T15:00:00.000Z",
    "fault_count":1,
    "usable_devices":20
  }],
  "@odata.count":1
}
```

`value` must be an array. Rows have a stable `__id` submission identifier, selected nested `__system` metadata, and selected form fields. `@odata.count` appears only when `$count=true` is requested; `@odata.nextLink` appears only when another page exists. Missing/blank form answers are not zero or healthy. Validate the configured site identifier, ISO timestamps, finite numeric ranges and declared categorical mappings before constructing canonical metrics. Keep submission IDs transient or pseudonymized only when required for idempotency; never retain submitter identity, device ID, raw XML/JSON or unapproved fields. [OData row construction](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/data/odata.js)

`$select` supports specific children of `__system`, allowing identity fields such as `submitterName`, `submitterId`, and `deviceId` to be omitted upstream. Avoid selecting the whole `__system` object. Likewise, selecting a whole form group includes its children, so select approved leaves instead. `$select` cannot be combined with `$expand`, and children of repeats cannot be selected directly; root operational forms should avoid unnecessary repeats. Encrypted/unavailable answers can have `__system.status` equal to `notDecrypted` or `missingEncryptedFormData`; these rows cannot produce healthy evidence. [System-field selection](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/data/odata.js), [selected-field validation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/formats/odata.js)

## Pagination safety

Use a positive bounded `$top`, then follow the server's opaque `$skiptoken` continuation through `@odata.nextLink`. Do not decode or invent cursors and do not replace them with arithmetic `$skip`. Central generates absolute links using its configured public domain, so local fixture domain configuration must match the address the test client is allowed to reach. **The pinned backend rejects combining `$orderby` with `$skiptoken`**, even though both options separately exist. Omit custom ordering for a cursor crawl and select the latest relevant report locally after fetching the bounded configured evidence window. [Continuation generation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/util/odata.js), [query option restriction](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/util/db.js), [official cursor description](https://docs.getodk.org/central-api-odata-endpoints/#data-document)

HubOS safety policy must reject continuations with a different origin, userinfo, fragment, unexpected form/table path or changed approved selection/filter; allow only expected paging changes. Do not follow redirects with credentials. Bound page count, row count, response size and collection duration; detect repeated links/IDs, malformed rows and inconsistent counts. A partial crawl must fail or be explicitly incomplete, never replace the previous full evidence set with a misleading zero. Cursor pagination improves stability while new submissions arrive, but is not a promise of a transactionally frozen snapshot of edits/deletions.

Deleted submissions are excluded by default unless the filter explicitly refers to deletion metadata. Keep them excluded for current operational reports. Review state is JSON `null` or one of `edited`, `hasIssues`, `rejected`, `approved`; the “received” review-count category corresponds to no explicit review state. Approved **fields** and an **approved review state** are different policies. Configure any required review-state restrictions deliberately; never silently use a rejected report to declare healthy conditions. [Deletion filter](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/data/odata-filter.js), [review-state schema](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/docs/api.yaml)

## Evidence time versus collection freshness

Keep these clocks distinct:

- **Report event time:** an explicitly approved field such as `reported_at`, if the form collects it. It is the reporter's claimed event/inspection time and may precede upload because collection was offline. Validate it without pretending it is trusted server time.
- **Server receipt time:** REST `createdAt` maps to OData `__system.submissionDate`. Central writes it from its database clock when receiving the initial submission.
- **Server update time:** REST `updatedAt` maps to `__system.updatedAt`; initially null, changed when XML data **or metadata** changes. A review-state change is not a new inspection.
- **Collector freshness:** HubOS's successful poll completion time. It says the reader recently checked Central, not that a new report exists.

Do not replace report event time with each poll's current clock. Use a configurable **report-validity horizon** separate from the source's poll/freshness threshold: a week-old maintenance report may still be relevant even though polling happens every few minutes. Persist the truthful evidence time and evaluate report age independently. A stale collector is unknown; a fresh collector with no valid relevant report is also unknown. For operational state, prefer the latest valid report per site/form and defined report semantics rather than summing unresolved-looking faults from every historical inspection. A later explicit healthy report can demonstrate recovery; silence or merely rereading the same report cannot. [Metadata mapping](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/data/odata.js), [server timestamp creation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/model/query/submissions.js), [timestamp contract](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/docs/api.yaml)

## Owned local demonstration setup only

Test/setup tooling may perform the following writes **only on an explicitly owned disposable/local demo instance**, never from production collectors:

1. `POST /v1/projects` with JSON `{ "name": "HubOS fictional community inspections" }`; HTTP 200 returns the new project object and numeric ID.
2. `POST /v1/projects/{projectId}/forms?publish=true` with `Content-Type: application/xml` and the bundled XForm XML. The instance root `id` defines `xmlFormId`; a matching explicit version is recommended. Alternatively create a draft and use `POST .../draft/publish`, which returns `{ "success": true }` and removes draft test submissions.
3. `POST /v1/projects/{projectId}/forms/{xmlFormId}/submissions` with XML containing the matching form ID/version, fictional approved-field values and a unique `meta/instanceID`. HTTP 200 returns submission metadata. This REST creation endpoint does not upload attachments.
4. Fixture setup can create a separate reader with `POST /v1/users` and JSON `{ "email": "unique-fixture@example.invalid", "password": "<fixture secret>" }`. This returns a user object with numeric `id` and also dispatches an account-claim email, so disable external delivery or route fixture email only to Mailpit before this step. Read `GET /v1/roles` to locate `system: "viewer"`, then `POST /v1/projects/{projectId}/assignments/viewer/{actorId}` with no request body; the pinned implementation accepts the system role name as well as its numeric ID and returns `{ "success": true }`. These account/assignment writes belong only to owned fixture setup, never collector startup. Verify the resulting reader cannot create/update/delete forms or submissions. [User creation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/users.js), [assignment route](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/assignments.js)

Use a uniquely identified test project and never overwrite a pre-existing form/account on repeat setup. XML parsing by Central is not comprehensive XForm validation: validate the bundled form through an appropriate upstream validator/test tool as well. Invalid submission XML/form version can return 400, duplicate submission IDs 409, and a non-accepting form rejects creation. [Form lifecycle](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/forms.js), [submission creation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/submissions.js), [project creation](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/projects.js)

## Failure and release-test checklist

Cover wrong credentials, expired/revoked session, 403 project/form rights, missing/unpublished form, malformed JSON/XML, unknown selected fields, unavailable encrypted values, unsupported query options, repeated/cross-origin continuation, timeout/cancellation/rate-limit fixtures, unmapped site IDs, numeric zero versus missing answer, fresh polling with old evidence, stale polling with a still-valid report, report correction/recovery, and PII sentinel redaction. Central errors use HTTP status plus problem `code`/`message`/optional `details`; messages/details can echo inputs, so persist only HubOS's bounded diagnostic code. No fixed local rate quota is established by the inspected API: use normal scheduler backoff and bounded `Retry-After` handling rather than inventing one. [Problem definitions](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/util/problem.js)

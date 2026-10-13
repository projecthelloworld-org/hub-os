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

## Reproducible local fixture: addressing, administration and egress

This section is a source-derived setup recommendation, **not** evidence that the fixture has already passed. Use a new uniquely named Compose project and fresh isolated volumes. Do not reuse, restart, reconfigure or remove the user's existing `dep-odk-test` project.

### How OData continuation URLs are derived

The OData handler passes **`config.default.env.domain`** to the formatter. The JSON footer builds `@odata.context` and `@odata.nextLink` by concatenating that configured domain with the service path/continuation URL. It does not infer the public origin from the request's Host header, socket port or `X-Forwarded-Proto`. [OData handler](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/odata.js), [literal footer construction](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/util/odata.js)

The production Compose startup script renders its `config/local.json` using:

```text
BASE_URL = https://DOMAIN               when HTTPS_PORT is exactly 443
BASE_URL = https://DOMAIN:HTTPS_PORT    otherwise
```

`DOMAIN` should be a hostname, without a scheme or embedded port. `HTTPS_PORT` is the **host-facing published port**, while nginx listens on container port 443. The scheme is always HTTPS, independent of `SSL_TYPE`. `SSL_TYPE=upstream` changes nginx to listen on HTTP port 80, removes its redirect listener and forces `X-Forwarded-Proto: https`, because it expects an external TLS terminator. It does **not** turn Central's generated domain into HTTP. Thus simply publishing `service:8383` on a host HTTP port produces incorrect HTTPS continuation links unless the configured domain is also overridden. [Service startup](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/service/scripts/start-odk.sh), [configuration template](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/service/config.json.template), [Compose port mapping](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/docker-compose.yml), [nginx upstream mode](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/nginx/setup-odk.sh)

The backend itself supports an isolated plain-HTTP fixture: its upstream default configuration uses HTTP `http://localhost:8989` as the public domain and server port 8383. A test can publish the backend on a private host address such as `127.0.0.1:18383` **and explicitly override** `default.env.domain` to `http://127.0.0.1:18383`. This does not require a TLS proxy for session-bearer/OData client tests. It is not suitable for remote production exposure, Basic authentication, or proving a complete Central web deployment. [Backend defaults](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/config/default.json), [HTTP listener](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/bin/run-server.js)

A fixture-only `NODE_CONFIG` JSON override can set that domain while retaining the upstream service image and normal migration startup. `node-config` supports JSON environment overrides; validate the effective nonsecret `default.env.domain` in the started service rather than assuming an environment variable was consumed. The override must also be present for administrative CLI processes, and must not override the already configured database credentials by accident. [node-config environment contract](https://github.com/node-config/node-config/wiki/Environment-Variables#node_config), [pinned dependency](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/package-lock.json)

Alternatively use upstream nginx with **customssl** and a test CA/certificate trusted only by the fixture client, or upstream SSL mode behind a local TLS terminator, with the exact reachable hostname and `HTTPS_PORT`. Do not disable global certificate verification. The selfsign helper creates a CN=localhost certificate without an explicit SAN in its command; do not assume every strict TLS client accepts it. Keep all HTTP/HTTPS fixture bindings on loopback. HTTP redirect behavior is not a reliable way to discover the configured HTTPS port: the pinned redirect template constructs `https://$http_host$request_uri`, which can retain the incoming HTTP port. Use the explicitly configured canonical endpoint. [Certificate/SSL modes](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/nginx/setup-odk.sh), [redirect template](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/nginx/redirector.conf)

### Initial administrator through the upstream CLI

After the isolated service has completed migrations, create a **unique fixture** Web User and promote it with the packaged upstream wrapper:

```text
docker compose -p <owned-fixture-project> exec -T service odk-cmd --email <fixture-email> user-create
docker compose -p <owned-fixture-project> exec -T service odk-cmd --email <fixture-email> user-promote
```

Include the fixture's explicit Compose files/path in the runner so these commands cannot resolve another project's service. `user-create` in this pinned version has **no password flag**: it always invokes the `prompt` library for hidden password input when OIDC is disabled. An automated fixture runner can supply one password line through the child process's standard input with `exec -T`; this avoids browser interaction and avoids putting the password in command arguments, shell history or public output. Use a bounded process timeout and do not print captured input/output indiscriminately. This stdin path still needs local verification; do not invent an unsupported `--password` option. `user-promote` accepts the email and grants the system-wide `admin` assignment. Use only on the owned disposable account, never on an existing production identity. [Packaged wrapper](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/service/odk-cmd), [CLI argument and prompt handling](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/bin/cli.js), [account tasks](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/task/account.js)

The CLI create-user task stores the account/password directly and **does not send a claim email**, unlike `POST /v1/users`. It emits its task result to stdout; retain only a safe success/ID summary. Log in using the chosen fixture credentials, not credentials extracted from a browser or container's existing accounts. On repeat tests, verify and reuse the fixture account only within the matching owned project; do not silently reset an arbitrary account's password.

### Suppress external email, error telemetry and usage reporting

Upstream production Compose starts a real Exim mail relay by default, and configures a default Sentry destination. Empty `.env` Sentry values are **not enough**: expressions such as `${SENTRY_KEY:-<default>}` substitute the default when the variable is empty. The fixture must use an explicit service/config override with an empty Sentry key, rather than accidentally retaining those defaults. [Production defaults](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/docker-compose.yml)

For the API-only HTTP fixture, the following nonsecret configuration illustrates the required overrides (replace the port/host only with the fixture's actual private endpoint):

```json
{
  "default": {
    "env": {"domain": "http://127.0.0.1:18383"},
    "external": {
      "sentry": {"key": "", "project": "", "orgSubdomain": "", "traceRate": 0},
      "analytics": {"url": "", "formId": "", "version": ""},
      "mailingListOptIn": {"url": "", "formId": "", "version": ""}
    },
    "email": {
      "serviceAccount": "no-reply@example.invalid",
      "transport": "smtp",
      "transportOpts": {
        "host": "mailpit", "port": 1025, "secure": false, "ignoreTLS": true,
        "auth": {"user": "", "pass": ""}
      }
    }
  }
}
```

Use a **local Mailpit service** with no outbound relay and no production recipients; do not start or route to upstream Exim for this fixture. For completely disabled delivery, the upstream `email.transport: "json"` makes no SMTP requests, but it prints complete message bodies—including account links/tokens—to the server log. Mailpit plus strict output redaction is preferable for exercising user-creation emails. Neither option permits importing production addresses. [Mail transports](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/external/mail.js)

Sentry's initializer returns a non-network stub when any of key/project/orgSubdomain is missing or empty; setting only the sampling rate to zero does not disable exception reporting. The stub still writes diagnostic details locally, so avoid intentionally sending secret-bearing invalid inputs and don't expose raw upstream logs as HubOS output. If the frontend is included or inspected, also keep `SENTRY_DSN_FRONTEND` explicitly empty; server `NODE_CONFIG` does not govern frontend telemetry. [Sentry disable guard](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/external/sentry.js), [frontend configuration](https://github.com/getodk/central/blob/ee0e4207ab6fb628247f4d5b5b576325782a5a05/files/nginx/client-config.json.template)

With the fixture administrator, explicitly `POST /v1/config/analytics` with `{ "enabled": false }` and verify `GET /v1/config/analytics` has `value.enabled === false`. The scheduled usage-report task reads that state before sending; the blank reporter URL/form/version override is an additional no-network guard even if the setting is accidentally absent. Do not opt into mailing-list reporting. Perform these configuration writes only on the owned fixture, not from the collector. [Config endpoint](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/resources/config.js), [analytics state](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/model/frames/config.js), [usage-report guard](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/task/analytics.js), [reporter no-op guard](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/external/odk-reporter.js)

### Recommended fixture boundaries and acceptance

Reuse pinned **upstream components**, but place them in a distinct test project: fresh PostgreSQL, the upstream backend service image, optional upstream Enketo/Redis and pyxform as needed, plus local Mailpit. Publish only the backend's private port for collector tests. Retain the normal upstream migration startup rather than building a fake ODK API. Prebuild/pull dependencies before any optional runtime egress isolation; disable/restrict external destinations during the actual test run.

An API-only fixture can exercise XML form creation, actual submissions, session authentication and OData without proving Enketo web-form availability. Form creation/publishing attempts bounded Enketo synchronization and schedules retries on failure. If Enketo is included, Central's configured public domain must also be reachable **from its container**, not merely from the host test client; `127.0.0.1` is container-local there. Do not claim a fully working web deployment from successful collector tests alone. [Bounded Enketo sync](https://github.com/getodk/central-backend/blob/bee93414a2215bd73d7f371113c6640c66d90c95/lib/model/query/forms.js)

Before accepting the fixture, require: migration completion; successful unique admin creation/promotion; recorded effective canonical domain; disabled Sentry/analytics; Mailpit-only or no-network mail; a separate viewer credential; at least two OData pages with same-origin continuations and approved-field preservation; rejected viewer management writes; correct reported/server/poll timestamps; and recorded upstream commits/image identities. Stop/cleanup only resources bearing this test project's identity, preserving the user-existing ODK project and all optional production volumes.

## Validate the existing inspection XML with the bundled upstream validator

**Source-derived recipe; not executed by this research task.** Validate `config/odk/hubos-inspection.xml` directly, before relying on Central's upload acceptance. The upstream `ghcr.io/getodk/pyxform-http:v4.5.0` recipe, commit `1cdcd4abbd6e360d25bfa16c3c58ad9450d5c753`, installs Python 3.12, a virtual environment under `/app/.venv`, **pyxform 4.5.0**, and `openjdk8-jre-base`. Its HTTP `/api/v1/convert` route accepts spreadsheet bytes and performs conversion; it is **not** an XML validation endpoint. Do not POST an existing XML form to it as if it were one. [Pinned container recipe](https://github.com/getodk/pyxform-http/blob/1cdcd4abbd6e360d25bfa16c3c58ad9450d5c753/Dockerfile), [pinned Python dependency](https://github.com/getodk/pyxform-http/blob/1cdcd4abbd6e360d25bfa16c3c58ad9450d5c753/pyproject.toml), [HTTP conversion implementation](https://github.com/getodk/pyxform-http/blob/1cdcd4abbd6e360d25bfa16c3c58ad9450d5c753/app/main.py)

The packaged validator's expected location in that image is:

```text
/app/.venv/lib/python3.12/site-packages/pyxform/validators/odk_validate/bin/ODK_Validate.jar
```

pyxform's actual invocation is `java -Djava.awt.headless=true -jar <jar> <xform-path>`. The bundled JAR is a dependency-inclusive executable archive whose manifest specifies **`org.opendatakit.validate.FormValidator`** as its main class; there is no additional classpath to construct. Equivalent explicit-class syntax is `java -Djava.awt.headless=true -cp <jar> org.opendatakit.validate.FormValidator <xform-path>`. Supply an XML path: starting without a path selects the GUI instead. [pyxform invocation and package-relative JAR path](https://github.com/XLSForm/pyxform/blob/51e5bfecc306febe03b3c4791ad0dbdecad208a4/pyxform/validators/odk_validate/__init__.py), [JAR assembly/main class](https://github.com/getodk/validate/blob/9d95e1893473f13c18e8e5fc824fbdf79cc7e2c0/build.gradle)

A future verification runner may execute this **disposable one-shot** command, without starting or changing any existing Central service:

```bash
docker run --rm --network none \
  --mount type=bind,source=/Users/naxic/Documents/Codex/hubos/config/odk/hubos-inspection.xml,target=/fixtures/hubos-inspection.xml,readonly \
  --entrypoint java \
  ghcr.io/getodk/pyxform-http:v4.5.0 \
  -Djava.awt.headless=true \
  -jar /app/.venv/lib/python3.12/site-packages/pyxform/validators/odk_validate/bin/ODK_Validate.jar \
  /fixtures/hubos-inspection.xml --fail-fast
```

The repository path shown is the current workspace; use an independently verified absolute path in other environments. Mount it read-only and disable container networking, since this standalone bundled form needs no external attachments or network access. Pre-pull/build the image before the offline run. Record the image digest and form checksum. Before treating this as a release gate, confirm the actual container has the expected JAR and version rather than relying only on its mutable tag/path derivation.

The pyxform 4.5.0 source bundle's `installed.json` identifies **ODK Validate v1.20.0**. Its recorded release-asset SHA-256 is `92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3`; hashing the JAR in the pinned source checkout produced that same value. Confirm the image's bundled JAR independently against it. This is a validator-artifact check, not a claim that the inspection form has passed. [Bundled version/digest metadata](https://github.com/XLSForm/pyxform/blob/51e5bfecc306febe03b3c4791ad0dbdecad208a4/pyxform/validators/odk_validate/bin/installed.json), [official Validate release](https://github.com/getodk/validate/releases/tag/v1.20.0)

Exit semantics from the pinned Java CLI:

- **0:** the validator considers the supplied forms valid; capture and review warnings from stdout/stderr rather than requiring completely empty output.
- **1:** one or more supplied forms failed; `--fail-fast`/`--failFast` stops after the first invalid form. A missing/unreadable path is also a failure, not a skipped test.
- **Any other nonzero exit, timeout, signal termination, missing JAR/Java, or missing validation-start evidence:** infrastructure/validation failure; do not pass the gate. Use an explicit bounded runner deadline and cancel only this owned validation process/container if necessary.

The Java implementation prints `Validating: <path>` before reading the form and explicitly exits 1 on invalid results. Verify that marker and preserve sanitized diagnostics alongside the exit code. The Python `check_xform()` wrapper is not sufficient as an exit-code-only release gate: it returns a warning list for a 100-second timeout or negative return code rather than necessarily raising an exception. A direct Java invocation with fail-closed deadline handling avoids accepting that timeout as success. [Java argument/result handling](https://github.com/getodk/validate/blob/9d95e1893473f13c18e8e5fc824fbdf79cc7e2c0/src/org/opendatakit/validate/FormValidator.java), [Python timeout handling](https://github.com/XLSForm/pyxform/blob/51e5bfecc306febe03b3c4791ad0dbdecad208a4/pyxform/validators/odk_validate/__init__.py)

This validates XML/XForms semantics supported by that JavaRosa/Validate version. It does not replace actual ODK submission/OData tests, privacy checks, permission checks, or verification of the form in the chosen data-collection client.

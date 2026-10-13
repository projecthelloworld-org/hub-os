# Headwind Community: read-only connector notes

Research checked 13 October 2026 against official upstream source. These notes describe a client contract to exercise against HubOS's isolated local Headwind installation; source inspection alone is not an integration-test result.

## Pinned deployment and source boundary

`scripts/vendor-ecosystem.sh` defaults to **hmdm-docker v0.1.8**. Its upstream commit is `f572a16890dda6cbc351ad98d71242ce1d3f83f9`; the Dockerfile and HubOS's example environment select **hmdm-5.39.2-os.war**. `os` is the open-source variant; no premium analytics is required for the calls below. The official server repository has a commit explicitly labelled v5.39.2, **`05810c09cb4ef30829c4bb75f8345841de9bf1e9`**, but no v5.39.2 tag was listed during this check. Citations below pin that commit rather than floating `master`. A Docker recipe tag is not a checksum of the WAR downloaded at startup: local tests must record the actual WAR/version and should not claim binary equivalence from source inspection. [Dockerfile](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/Dockerfile), [Compose recipe](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/docker-compose.yaml), [v5.39.2 server commit](https://github.com/h-mdm/hmdm-server/commit/05810c09cb4ef30829c4bb75f8345841de9bf1e9)

The Community server declares the JWT module as a normal dependency. Use core authentication/device/group/configuration lookup APIs, not proprietary analytics plugins. [Community server dependencies](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/pom.xml)

## Base URL and authentication

The REST servlet is mounted at `<webapp-context>/rest/*`; the Docker recipe deploys `ROOT.war`. Configure the installation origin and optional context explicitly, then append `/rest/...`. Require HTTPS for external installations; loopback/isolated Compose HTTP is appropriate only for local demonstrations/tests. [Servlet mapping](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/webapp/WEB-INF/web.xml), [Docker entrypoint](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/docker-entrypoint.sh)

Recommended programmatic authentication is JWT:

```http
POST /rest/public/jwt/login
Content-Type: application/json

{"login":"hubos-reader","password":"<UPPERCASE MD5 hexadecimal digest of actual password>"}
```

Successful authentication returns HTTP 200 with a **bare** token object, not the normal application response envelope:

```json
{"id_token":"<secret JWT>"}
```

The response also includes `Authorization: Bearer <token>`. Subsequent private calls must send that bearer header. This upstream login protocol expects **uppercase MD5** of the actual password; do not send the raw password or Headwind's stored salted hash. Case matters: the upstream comparison hashes the supplied MD5 plus a salt, so lowercase hexadecimal is not interchangeable. Both the upstream hash helper and browser login uppercase the MD5 value. The MD5 value is credential-equivalent and must receive the same secret handling as the password. [JWT login implementation](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/rest/JWTAuthResource.java), [token object](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/rest/JWTToken.java), [password comparison](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/util/PasswordUtil.java), [uppercase helper](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/util/CryptoUtil.java)

Default normal JWT validity is **86,400 seconds (24 hours)**, configurable by `jwt.validity`. Login invokes token creation with remember-me false. Private requests validate both the JWT and the current account's internal `authToken`; deleted accounts, token changes or password-reset requirements can deny access even before expiration. If `jwt.secretkey` is not explicitly configured, the server generates a new key during initialization, making an application restart another possible invalidation event. Cache tokens only in memory and allow at most one reauthentication attempt after a private 401/403 before reporting access failure. Never log login bodies, token responses, Authorization headers or decoded token contents. [Token lifetime/signing](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/TokenProvider.java), [JWT account validation](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/JWTFilter.java), [private authentication filter](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/filter/AuthFilter.java)

Login itself performs ordinary authentication bookkeeping: it records login/failure metadata and may initialize an account's missing internal auth token. “Read-only collector” means no device/configuration management operations, not literally no authentication-side database changes. Supply an already configured dedicated service account with minimum appropriate visibility; HubOS must not create or change production accounts. This contract does not establish OIDC/MFA compatibility. [Authentication bookkeeping](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/rest/JWTAuthResource.java)

The separate browser endpoint `/rest/public/auth/login` establishes a servlet session and returns a user object in the application envelope; it also has deployment-specific password-transmission/two-factor behavior. A JWT client does not need cookies or this browser flow. Do not silently fall back to it. [Browser authentication](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/AuthResource.java)

## Inventory and pagination

Device search is **POST but read-only**:

```http
POST /rest/private/devices/search
Authorization: Bearer <secret JWT>
Content-Type: application/json

{"pageSize":50,"pageNum":1,"sortBy":"NUMBER","sortDir":"ASC"}
```

`pageNum` is one-based, defaults to 1; `pageSize` defaults to 50. Optional numeric `groupId` or `configurationId` filter a scoped collection. Omit text `value` when collecting a complete permitted inventory. The server ignores client-provided `customerId`/`userId` and derives those scopes from the authenticated account. SQL uses `(pageNum - 1) * pageSize` for offset. No authoritative maximum page size is enforced by the inspected request DTO, so HubOS should impose its own conservative bounds rather than making enormous requests. [Search request](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/domain/DeviceSearchRequest.java), [account-scoped DAO](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/DeviceDAO.java), [pagination SQL](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/DeviceMapper.xml)

Synthetic, privacy-projected example of the response structure:

```json
{
  "status":"OK",
  "message":null,
  "data":{
    "configurations":{"7":{"id":7,"name":"Fictional shared devices"}},
    "devices":{
      "items":[{
        "id":11,
        "configurationId":7,
        "groups":[{"id":3,"name":"Fictional community site"}],
        "lastUpdate":1791885600000
      }],
      "totalItemsCount":1
    }
  }
}
```

The actual response can contain substantially more fields. `data.devices.items` is the page array and `data.devices.totalItemsCount` is the overall count, **not** `data.items`, `totalCount`, a cursor, or a Unix timestamp. `data.configurations` is a map keyed by configuration ID strings. Normal responses have `status`, optional `message`, and endpoint-specific `data`; the client must require `status === "OK"` in addition to HTTP success. [Device search resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java), [list wrapper](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceListView.java), [pagination wrapper](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/json/PaginatedData.java), [response envelope](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/json/Response.java)

Important edge case: the resource removes devices whose referenced configuration cannot be found **after** the database computes `totalItemsCount`. A short page is therefore not necessarily the final page, and visible item counts can differ from the total. Increment page numbers according to the declared total/page size with hard bounds, validate duplicate IDs and changing totals, and fail or explicitly mark incomplete collection if complete coverage cannot be established. Do not loop until a misleading total is reached, and do not present filtered/incomplete inventory as a healthy full fleet. [Post-query filtering](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java)

For projection, validate positive integer device/configuration/group IDs where present, an items array, a nonnegative integer total, and the relevant optional timestamp type. `DeviceView` uses non-null serialization, so missing optional fields are expected; do not invent “required” rules from Java primitive defaults. Multiple matching group/configuration mappings may point to the same HubOS site, but one device must be counted once per source/site. Conflicting site assignments need an explicit mapping policy or rejection, not double counting. Names must not be used as stable identifiers. [Device view](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceView.java)

## Group and configuration lookup

| Read-only endpoint | Response data | Use |
|---|---|---|
| `GET /rest/private/groups/search` | Array of group objects containing integer `id`, string `name` and possibly `customerId` | Mapping discovery |
| `GET /rest/private/configurations/list` | Array of lookup objects `{id,name}` | Preferred minimal configuration discovery |
| `GET /rest/private/configurations/search` | Array of full configuration objects | Avoid for normal collector |

Lookup lists are not paginated in the inspected resource methods. Full configuration search explicitly checks the `configurations` permission and can return extensive configuration/enrollment/application data; it is unnecessary for aggregate monitoring. Configuration `/list` avoids that explicit permission check, but the DAO's account visibility still applies. Device search returns `groups` lookup objects and `configurationId`, sufficient for configured mappings. Controller/source scope must be part of every external identifier; group `3` on one server is unrelated to group `3` on another. Prefer separate namespaces such as `group:3` and `configuration:7` within each source. [Group resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/GroupResource.java), [configuration resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/ConfigurationResource.java), [lookup DTO](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/json/LookupItem.java)

## Check-in timestamp semantics

`DeviceView.lastUpdate` is explicitly documented as last synchronization time in **milliseconds since Unix epoch**. The server sets it using PostgreSQL server time when processing device `/rest/public/sync/info`; it is not device-provided time, enrollment time, a battery measurement, a last lesson/app-use time, or proof of community internet service. No management call is needed to read it. [Timestamp DTO](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceView.java), [server receipt timestamp](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/DeviceMapper.java), [device sync handler](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/SyncResource.java)

Recommended metrics per source/site: inventory count, recent check-in count, stale check-in count, and unknown check-in count. Use a configurable recent-age threshold, a single collection clock, and a bounded future-clock tolerance. `null`, omitted, zero, malformed or implausibly future values are unknown; an empty legitimately mapped inventory is zero inventory, not healthy device activity. Save aggregated numeric counts plus their evidence/collection times, not individual device numbers or identifiers. If the entire collection ages past its source freshness threshold, all current check-in counts become unavailable/unknown rather than remaining current indefinitely.

Headwind's `statusCode` is a color-coded operational summary, not an enum of supported community connectivity states. Calculate check-in freshness explicitly instead of treating `green` as universal health. [Device status field](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceView.java)

## Privacy, failures and local verification

Device responses can expose device numbers/descriptions, IMEI, phone, public IP, serial, custom fields, old numbers and device info. The embedded configurations map can expose QR enrollment keys, base URLs, app and file metadata. Do not persist/log these bodies. Project identifiers only transiently for pagination/mapping, and persist the aggregate whitelist. [Device fields](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceView.java), [configuration fields](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/ConfigurationView.java)

JWT login can return 400 for missing credentials, 401 for invalid credentials and 500 for unexpected errors. Private endpoints can return **403**, including invalid/expired authentication, password reset, account-token invalidation, or IP allowlist restrictions. A normal HTTP 200 envelope may still contain `ERROR` and messages such as `error.permission.denied` or `error.internal.server`; do not mistake it for successful collection. There is no fixed local request quota or mandatory retry header established by these sources. [Login failures](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/rest/JWTAuthResource.java), [auth filter](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/filter/AuthFilter.java), [IP restrictions](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/filter/PrivateIPFilter.java), [application errors](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/json/Response.java)

Local release verification should exercise the actual deployed WAR: correct/incorrect JWT login, missing bearer, expiry/revocation or equivalent failure fixtures, empty and multipage inventory, group/configuration lookup and mapping, never-checked-in devices, recent/stale timestamps, malformed responses, missing configurations/count mismatch, and explicit privacy sentinels. A disposable fixture may create fictional devices and submit synthetic check-ins to demonstrate server timestamp behavior; keep those writes isolated from the production collector, which must never call device/configuration PUT/DELETE, push commands, public sync, or enrollment endpoints.

## Exact disposable-fixture setup recipe

These are **fixture-only administrative writes**, not production bootstrap behavior. Require an explicitly owned disposable instance, fresh isolated database/storage and loopback-only access. Refuse to use this recipe on an arbitrary configured Headwind URL. Use unique run-prefixed names; on repeat setup, lookup and verify the fixture's existing resources rather than overwriting unrelated accounts/configurations.

### 1. Disable outbound email and record the deployed artifact

Headwind's `EmailService.isConfigured()` is false when the Tomcat context parameter `smtp.host` is absent or an empty string. Its send method then returns false before attempting SMTP. The pinned Docker context template does not set SMTP parameters. Preserve that default in the fixture, or explicitly set `<Parameter name="smtp.host" value=""/>`; also use a fictional `ADMIN_EMAIL` under `example.invalid`. Do not enable an external SMTP host or invoke password recovery to a real address. Verify `GET /rest/public/auth/options` reports `status: "OK"` with `data.recover: false`. The deprecated `/rest/public/passwordReset/canRecover` instead returns application `status: "ERROR"` when email is disabled, not a boolean data value. Checking the option is stronger than assuming an email-looking setting disables delivery. [Email guard](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/service/EmailService.java), [SMTP parameter defaults](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/guice/module/ConfigureModule.java), [Docker context](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/templates/conf/context_template.xml), [auth options](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/AuthResource.java), [legacy recovery check](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/PasswordResetResource.java)

Record, without credentials: Docker image digest, the selected public `HMDM_URL`, SHA-256 of **both** `/usr/local/tomcat/work/cache/hmdm-5.39.2-os.war` and `/usr/local/tomcat/webapps/ROOT.war`, and the application version displayed by the deployed About screen. The source's `APP_VERSION` constant is `5.39.2`; if the matching deployed asset is available, record that too. The cached download may differ from the deployed WAR after an upstream in-app update, so the deployed WAR hash is authoritative for the test. Hash recording alone does not authenticate a download: this research found no published immutable WAR digest to compare against. Do not trigger in-app updates in the fixture. [WAR cache/copy](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/docker-entrypoint.sh), [in-app update replacement](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/update-web-app-docker.sh), [version constant](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/webapp/app/app.js)

### 2. Complete the fresh administrator reset

The public upstream default account is **`admin` / `admin`**. Its uppercase MD5 is `21232F297A57A5A743894A0E4A801FC3`. However, the Docker initialization SQL sets `passwordReset=true` and creates a reset token. A JWT login can therefore succeed while subsequent private requests still fail with 403; do not “fix” this by clearing database flags. [Default administrator](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/resources/liquibase/db.changelog.xml), [Docker reset requirement](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/templates/sql/hmdm_init.en.sql), [private reset guard](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/filter/AuthFilter.java)

For **this fresh owned fixture only**, use the same first-login reset flow as the upstream UI:

1. `POST /rest/public/auth/login` with JSON `{ "login": "admin", "password": "21232F297A57A5A743894A0E4A801FC3" }`. The default template does not enable `transmit.password`, so this is the MD5 profile, not RSA-encrypted login.
2. Require `status: "OK"`; expect `data.passwordReset: true` and a secret `data.passwordResetToken`. Read these privately in memory; the response also contains sensitive authentication/user fields and must not be printed.
3. `POST /rest/public/passwordReset/reset` with JSON `{ "passwordResetToken": "<token>", "newPassword": "<UPPERCASE MD5 of unique fixture administrator password>" }`. Require `status: "OK"`. The handler clears reset state/token and returns a user object; discard it without logging.
4. Authenticate through `/rest/public/jwt/login` using that new fixture password's uppercase MD5, then verify a private inventory request succeeds. Browser cookies are not needed afterward.

The browser controller explicitly directs first-login users to this reset flow, and `UserView` exposes the reset token in the authenticated login response. Do not use this administrative reset flow as an automatic production collector fallback. [Login/reset transition](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/webapp/app/components/main/controller/login.controller.js), [login response fields](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/user/UserView.java), [reset handler](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/PasswordResetResource.java)

### 3. Create fictional groups, configuration and devices

Use the fixture administrator bearer token and JSON content type for private writes:

| Request | Minimal fixture body | Result and lookup |
|---|---|---|
| `PUT /rest/private/groups` | `{ "name": "<run>-community-group" }` | `status: "OK"`, normally no returned ID; lookup the exact name in `GET /rest/private/groups/search` |
| `PUT /rest/private/configurations` | `{ "name": "<run>-community-config", "description": "Fictional fixture only", "applications": [], "files": [], "permissive": false, "useDefaultDesignSettings": true, "pushOptions": "mqttAlarm", "defaultFilePath": "/" }` | `status: "OK"`, `data` is the created configuration including numeric ID and sensitive configuration fields; take ID only |
| `PUT /rest/private/devices` | `{ "number": "<run>-tablet-never", "configurationId": 7, "groups": [{ "id": 3 }] }` with real fixture-created IDs | `status: "OK"`, normally no returned ID; lookup by inventory/`GET /rest/private/devices/number/{number}` |

Configuration defaults in the pinned Java DTO supply empty application lists, default design enums and conservative tracking values; the resource supplies `disableLocation=false`. **Local fixture correction:** the earlier source-derived body without `pushOptions` and `defaultFilePath` failed against the actual owned 5.39.2 instance. Supply the values shown above because the mapper explicitly inserts nullable DTO fields into non-null columns, bypassing SQL defaults. This correction is a local-test finding, not a claim that every variant is compatible. Never copy production configuration secrets into a fixture. Device creation assigns `lastUpdate=0` regardless of a caller-supplied value, producing a genuinely never-checked-in case. Groups are inserted from the provided lookup IDs. [Group creation](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/GroupResource.java), [configuration creation](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/ConfigurationResource.java), [explicit configuration insertion](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/ConfigurationMapper.xml), [device creation](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java), [group insertion](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/DeviceDAO.java)

Create additional uniquely named devices for recent/stale and pagination cases. For a synthetic check-in, issue **fixture-only** `POST /rest/public/sync/info` with `{ "deviceId": "<run>-tablet-recent" }`; `deviceId` here is the device's textual **number**, not its numeric inventory ID. The pinned handler returns `status: "OK"` and updates `lastUpdate` using server time. It does not require a browser/JWT token or a request-signature header in this handler; do not assume the same for device configuration/enrollment APIs. Create the fictional device first, because the sync handler can otherwise create devices on demand in a single-customer setup. [Info sync handler](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/SyncResource.java)

A supported API cannot backdate `lastUpdate`. To exercise stale behavior without direct database edits, use a short **test-only** collector check-in threshold, check in one fixture device, allow that threshold to pass, then check in another and collect. Compare returned server timestamps with the test's bounded clock tolerance. Do not change a real source's thresholds or clocks.

### 4. Create a minimum reader role and scoped service account

Do not assume the stock **Observer** label means strictly read-only: an upstream migration grants `edit_device_desc` to all existing roles, including Observer. Create a new fixture role **after initialization** with **`permissions: []`**; do not add `settings`, `configurations`, `add_config`, `edit_devices`, `edit_device_desc`, application/file edit permissions, or super-admin privileges. The earlier instruction to select a `devices` permission was incorrect: no such permission is defined in the pinned source. Permission ID 4 is actually `edit_devices`; the Docker English description “Access to devices” is not its permission name. [Observer initialization/descriptions](https://github.com/h-mdm/hmdm-docker/blob/f572a16890dda6cbc351ad98d71242ce1d3f83f9/templates/sql/hmdm_init.en.sql), [initial permission names and later migration](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/resources/liquibase/db.changelog.xml)

Source rationale: `/devices/search`, `/groups/search`, and `/configurations/list` do not call `hasPermission` for access. They require valid private authentication and derive customer/group/configuration visibility from the account's scope. Thus a custom non-super-admin role with no explicit permissions is the **source-supported candidate** for these read-only collection routes; verify that exact profile against the deployed WAR before claiming compatibility. `/roles/permissions` merely selects permissions where `superAdmin=false`; it is not hiding an implicit selectable `devices` permission. [Inventory resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java), [group resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/GroupResource.java), [minimal configuration lookup](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/ConfigurationResource.java), [scope SQL](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/DeviceMapper.xml), [permission-list SQL](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/UserRoleMapper.xml)

1. As fixture admin, optionally inspect `GET /rest/private/roles/permissions` to confirm selectable names; do not grant any of them for the minimal profile.
2. `PUT /rest/private/roles` with `{ "name": "<run>-HubOS-reader", "description": "Fixture aggregate reader", "permissions": [] }`. It returns `status: "OK"`, normally no new ID; lookup the unique name in `GET /rest/private/roles/all` and verify it is non-super-admin with no granted permissions. The insertion code skips permission rows when the array is empty, and the mapper forces new custom roles to `superAdmin=false`.
3. `PUT /rest/private/users` with `{ "login": "<unique-fixture-login>", "name": "Fictional HubOS reader", "email": "reader@example.invalid", "newPassword": "<UPPERCASE MD5 of fixture reader password>", "userRole": { "id": <roleId> }, "allDevicesAvailable": false, "allConfigAvailable": false, "groups": [{ "id": <fixtureGroupId> }], "configurations": [{ "id": <fixtureConfigurationId> }] }`. Require `status: "OK"`; find its ID through admin `GET /rest/private/users/all?filter=<unique-login>` and an exact match.
4. **Pinned implementation nuance:** user insertion persists group access but does not insert the supplied configuration-access rows. Repeat `PUT /rest/private/users` with the same full scope/role body plus the returned `id` and **omit `newPassword`**; the update path now persists both group and configuration access. This is not optional if `allConfigAvailable=false` is used.
5. Fresh initialization defaults password-reset policy to false for newly created users, but verify the reader's actual state; if this owned fixture has enabled mandatory reset, complete its supported reset before authenticating. Do not weaken a production policy.
6. Log in as the reader with JWT, exercise `/devices/search`, `/groups/search` and `/configurations/list`, and verify only the fixture's permitted devices/configurations are returned. Never give the runtime collector the administrator token.

Role creation requires org-admin/super-admin access in the single-customer fixture; user creation likewise requires administrator authority. The collector's minimal lookup endpoints do not require the `configurations` edit permission. [Role resource](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/UserRoleResource.java), [role mapper](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/mapper/UserRoleMapper.java), [user create/update](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/UserResource.java), [access-row insertion/update distinction](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/persistence/UserDAO.java)

### 5. Verify management rejection without touching a real device

With the reader bearer token, attempt `PUT /rest/private/devices` using a uniquely named **new fictional sentinel** such as `{ "number": "<run>-MUST-NOT-BE-CREATED", "configurationId": <fixtureConfigurationId>, "groups": [{ "id": <fixtureGroupId> }] }`. The resource checks `edit_devices` before processing the object and must return an application rejection:

```json
{"status":"ERROR","message":"error.permission.denied","data":null}
```

The HTTP response can still be 200. Verify the sentinel is absent with a subsequent admin inventory lookup and the reader's valid inventory remains unchanged. If it is created, fail the gate and clean it up only within this owned fixture; do not reinterpret HTTP success as a passed access test. A similar group-creation sentinel should fail due to missing `settings`. Missing JWT must independently return 403 on private inventory. [Device permission check](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java), [permission-denied envelope](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/common/src/main/java/com/hmdm/rest/json/Response.java)

This rejects the tested management operations; it is not a claim that every upstream endpoint has been security-audited or that a reader account cannot update its own profile/password. Release evidence must state the exact tested routes, actual WAR hash/version and account permissions.

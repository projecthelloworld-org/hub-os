# UniFi local Network API: connector implementation notes

Research checked 13 October 2026 against Ubiquiti's first-party documentation and machine-readable contracts. This is a compatibility/design note, not evidence of testing against deployed UniFi hardware.

## Supported surface and compatibility boundary

HubOS should use the official local **Network Integration API**, not Site Manager, the cloud Connector proxy, login cookies, or undocumented `/api/s/...` endpoints. Ubiquiti distinguishes local application APIs from its cloud Site Manager API, and directs administrators to their installed Network application's Integrations documentation. [Official API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)

The contracts examined were **9.1.120**, **9.4.17**, and **10.6.106**. All contain the read-only endpoints below and the same pagination envelope and principal statistic names. The developer index lists 9.1.120 as its earliest available Network version; that does not establish universal compatibility with every later build. The hotspot guide identifies 9.1.105 Early Access as an early API/key-generation release, not a suitable blanket minimum for production support. [Version index](https://developer.ui.com/llms.txt), [9.1.120 contract](https://developer.ui.com/network/v9.1.120/openapi.json), [9.4.17 contract](https://developer.ui.com/network/v9.4.17/openapi.json), [10.6.106 contract](https://developer.ui.com/network/v10.6.106/openapi.json), [initial API availability](https://help.ui.com/hc/en-us/articles/31228198640023-External-Hotspot-API-for-Authorization-Clients)

Recommended release claim: “Fixture-tested against the official Network 9.1.120, 9.4.17 and 10.6.106 contracts; a reachable official local API and an API key are required. Hardware/deployment compatibility remains to be confirmed.” A successful version probe is not proof that every model exposes every statistic.

## Base path, credentials, and connection testing

The official specifications declare this local server:

```text
https://<console-host>/proxy/network/integration
```

Append the documented `/v1/...` paths. Permit an explicit port in the administrator's configured URL. Require HTTPS and certificate validation; support a trusted private CA rather than a general insecure-TLS option. The cloud server also present in those specifications is outside HubOS v0.2.0 scope. [Declared servers](https://developer.ui.com/network/v10.6.106/openapi.json)

Authentication is `X-API-Key` with `Accept: application/json`. For a direct local integration, consult **Network → Control Plane → Integrations** for key generation and the deployment-specific documentation. The public developer onboarding also mentions Site Manager key creation; do not assume a cloud account key works against every local installation. Never implement a silent cookie-login or cloud fallback. [Local key instructions](https://help.ui.com/hc/en-us/articles/31228198640023-External-Hotspot-API-for-Authorization-Clients), [developer onboarding](https://developer.ui.com/network/v10.6.106/gettingstarted)

Self-hosting needs a distinction: **UniFi OS Server** is now Ubiquiti's self-hosted replacement for the classic **UniFi Network Server**. The official public contracts examined do not establish that a classic standalone Network Server exposes `/integration` or local API-key authentication. Therefore do not advertise generic standalone support solely from its Network version. An explicitly supplied deployment-local base path may be accepted only after `/v1/info` and `/v1/sites` capability checks succeed; document unverified variants. HubOS must not migrate or upgrade controllers. [Self-hosting distinction](https://help.ui.com/hc/en-us/articles/34210126298775-Self-Hosting-UniFi)

`GET /v1/info` returns an object containing the required string `applicationVersion`. Record the version for diagnostics without logging the credential. Use separate HubOS source connections for multiple controllers, with each controller's site UUID mapped to a canonical HubOS site. `internalReference` is a legacy internal name, not the canonical site ID. [Application information](https://developer.ui.com/network/v10.6.106/getinfo), [local site inventory](https://developer.ui.com/network/v10.6.106/getsiteoverviewpage)

## Read-only endpoint recipe

| Endpoint, relative to the base | Monitoring use |
|---|---|
| `GET /v1/info` | Version/capability probe |
| `GET /v1/sites` | Local site UUID inventory |
| `GET /v1/sites/{siteId}/devices` | Adopted-device counts by state/features |
| `GET /v1/sites/{siteId}/clients` | Connected-client counts by type |
| `GET /v1/sites/{siteId}/devices/{deviceId}/statistics/latest` | Optional device health and uplink measurements |

These are supported in all three inspected contracts. Avoid device/client action, adoption, deletion, voucher, and configuration endpoints entirely. [9.1.120 endpoint contract](https://developer.ui.com/network/v9.1.120/openapi.json), [current endpoint index](https://developer.ui.com/network/v10.6.106/llms.txt)

Site/device/client lists use `offset` and `limit`: offset starts at zero; default limit is 25 and maximum 200. Responses require `offset`, `limit`, `count`, `totalCount`, and `data`. Traverse pages rather than interpreting the first page as complete. As HubOS defensive policy, validate nonnegative integer counts, matching array length, expected offset, unique identifiers and progress; impose page/item bounds. Changing inventory is not an atomic snapshot: inconsistent pagination should fail collection instead of reporting an artificially low healthy count. [Sites](https://developer.ui.com/network/v10.6.106/getsiteoverviewpage), [devices](https://developer.ui.com/network/v10.6.106/getadopteddeviceoverviewpage), [clients](https://developer.ui.com/network/v10.6.106/getconnectedclientoverviewpage)

## Numeric projection and interpretation

### Minimum response validation

Validate the following source fields before producing counts; required source fields can be discarded after validation. A sanitized persisted projection is deliberately smaller than a complete vendor response.

| Object | Required fields in the inspected contracts |
|---|---|
| Application info | `applicationVersion` string |
| Each page | `offset`, `limit`, `count`, `totalCount` integers; `data` array |
| Site | `id` UUID string; `internalReference`, `name` strings |
| Adopted device, 9.1.120/9.4.17 | `id` UUID; `name`, `model`, `macAddress`, `ipAddress`, `state` strings; `features`, `interfaces` arrays |
| Adopted device, 10.6.106 | The preceding fields plus `firmwareUpdatable` and `supported` booleans; `firmwareVersion` remains optional |
| Common client | `id` UUID; `name`, `type` strings; `access` object |
| Wired/wireless client | Common fields plus `macAddress` string and `uplinkDeviceId` UUID; `access.type` is required |
| Device statistics | `interfaces` object; all listed numeric/timestamp fields optional |

Client discriminators are `WIRED`, `WIRELESS`, `VPN`, and `TELEPORT`; VPN/Teleport inherit common required fields but do not require MAC or uplink device fields. Local wired/wireless access discriminators are `DEFAULT` and `GUEST`; do not require guest authorization on a `DEFAULT` object. Device states in both inspected 9.x contracts are `ONLINE`, `OFFLINE`, `PENDING_ADOPTION`, `UPDATING`, `GETTING_READY`, `ADOPTING`, `DELETING`, `CONNECTION_INTERRUPTED`, and `ISOLATED`. 10.6.106 additionally declares `U5G_INCORRECT_TOPOLOGY`. Device feature values are `switching`, `accessPoint`, `gateway`; interface values are `ports`, `radios`. Unknown future states/types must never be counted as online or healthy: either report an explicit other/unknown count or fail with an unsupported-schema diagnostic according to the supported version policy. [9.1.120 schemas](https://developer.ui.com/network/v9.1.120/openapi.json), [9.4.17 schemas](https://developer.ui.com/network/v9.4.17/openapi.json), [10.6.106 schemas](https://developer.ui.com/network/v10.6.106/openapi.json)

Aggregate adopted device counts using `state`; `ONLINE` and `OFFLINE` are explicit states, while other states must remain separately classified. `features` can contain `accessPoint`, `switching`, and `gateway`. The newer schema adds `supported`, firmware fields and `U5G_INCORRECT_TOPOLOGY`; older fixtures must not be rejected for missing those newer fields. Connected clients include `WIRED`, `WIRELESS`, `VPN`, and `TELEPORT`: connected clients are not unique people or community participation. Discard client names, MAC/IP addresses and connection identifiers before persistence. [Device overview](https://developer.ui.com/network/v10.6.106/getadopteddeviceoverviewpage), [client overview](https://developer.ui.com/network/v10.6.106/getconnectedclientoverviewpage)

Latest statistics may contain `uptimeSec`, `lastHeartbeatAt`, `nextHeartbeatAt`, `cpuUtilizationPct`, `memoryUtilizationPct`, three load averages, `uplink.txRateBps`, `uplink.rxRateBps`, and radio `txRetriesPct`. **Only `interfaces` is required** in the inspected statistic contracts. Omitted numeric fields are unavailable, not zero. Check finite numbers, plausible ranges and heartbeat freshness; optional or stale statistics cannot clear a fault. Radio `frequencyGHz` is a string enum in 9.1.120/9.4.17 but a numeric enum in 10.6.106. [Older statistics contract](https://developer.ui.com/network/v9.4.17/getdevicelateststatistics), [newer statistics contract](https://developer.ui.com/network/v10.6.106/getadopteddevicelateststatistics)

Device uptime is time since device restart—not service-availability percentage. A device's uplink is its link to its parent in the topology; summing every device's rates double-counts network traffic and does not measure ISP upload/download. Preserve the API's `Bps` designation unless deployment documentation confirms its expanded unit. These local contracts do not expose per-client cumulative byte totals or authoritative WAN outage/latency measurements through the selected endpoints. Even the newer `/wans` endpoint supplies interface identifiers/names, not internet-health evidence. Community connectivity remains unknown unless separately measured by an explicitly configured reachable community monitor or another approved evidence source. [Device uplink definition](https://developer.ui.com/network/v10.6.106/getadopteddevicedetails), [statistics](https://developer.ui.com/network/v10.6.106/getadopteddevicelateststatistics), [WAN definitions](https://developer.ui.com/network/v10.6.106/getwansoverviewpage)

## Sanitized fixture shapes

The following are **synthetic projections**, not captured production responses. Fields are taken from the cited contracts; personal/address/name fields intentionally omitted from device/client projections. A full contract-validation fixture must include each contract's required fields using fictional values.

```json
{
  "offset": 0,
  "limit": 25,
  "count": 1,
  "totalCount": 1,
  "data": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "internalReference": "demo-local",
    "name": "Fictional community site"
  }]
}
```

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "state": "ONLINE",
  "features": ["accessPoint"],
  "interfaces": ["radios"]
}
```

```json
{
  "uptimeSec": 3600,
  "lastHeartbeatAt": "2026-10-13T10:00:00Z",
  "nextHeartbeatAt": "2026-10-13T10:00:30Z",
  "cpuUtilizationPct": 12.5,
  "memoryUtilizationPct": 40,
  "uplink": {"txRateBps": 1000, "rxRateBps": 2000},
  "interfaces": {"radios": [{"frequencyGHz": 5, "txRetriesPct": 2}]}
}
```

Client aggregation needs only transient `type` and, when relevant, `access.type`/`access.authorized`; UUIDs may be used transiently to deduplicate pagination, never as a person identifier. [Site response](https://developer.ui.com/network/v10.6.106/getsiteoverviewpage), [device response](https://developer.ui.com/network/v10.6.106/getadopteddeviceoverviewpage), [statistic response](https://developer.ui.com/network/v10.6.106/getadopteddevicelateststatistics), [client response](https://developer.ui.com/network/v10.6.106/getconnectedclientoverviewpage)

## Failure handling and tests

Ubiquiti documents error fields `code`, `message`, `requestId`, `requestPath`, `statusCode`, `statusName`, and `timestamp`. Error text and paths can contain sensitive details, so HubOS should persist its own bounded diagnostic codes rather than vendor bodies. The local error reference does not promise a fixed request quota, retry schedule or mandatory `Retry-After` header; do not borrow cloud Site Manager rate limits. [Official local error reference](https://developer.ui.com/network/v10.6.106/error-handling)

Recommended HubOS policy: fail 401/403 as credential/access errors; treat 404 as missing capability/resource without legacy fallback; handle 429 with a bounded `Retry-After` delay when present and backoff otherwise; retry transient 5xx/timeouts through the scheduler. Reject malformed JSON, wrong shapes, invalid statistics and pagination loops. No failed/incomplete collection may emit a healthy state or zero-filled measurements. Test multiple controllers, overlapping local external IDs, unmapped sites, empty legitimate inventories, optional/missing/stale statistics, newer state enums, both radio types, authentication failures, rate limits, cancellation and response size limits.

API-key privileges must be minimized using capabilities actually available on the deployment. A collector that only issues GET requests does not prove that the key itself is read-only; verify privileges separately and disclose this limitation.

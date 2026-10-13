# UniFi connector

The `unifi` module reads the official local UniFi Network Integration API. Each controller is a separate source connection. Cloud Site Manager, the cloud Connector proxy and undocumented cookie-based APIs are not supported fallback paths.

## Requirements and configuration

Use a reachable local API and a dedicated API key with the minimum privileges the installed system supports. Verify certificate trust, including any private CA. Do not disable TLS validation.

The usual base URL is `https://<console>/proxy/network/integration/`. Confirm the exact path and local key-generation procedure in the installed Network application's Integrations documentation. Classic standalone Network Server compatibility must not be inferred from a version number alone.

```json
{
  "credential_refs": {"apiKey": "env:UNIFI_LOCAL_API_KEY"},
  "statistics_max_age_seconds": 300
}
```

Map the controller's external site UUID to a canonical HubOS site. Identical UUIDs on different controllers remain source-scoped. Several controller-site mappings can describe one community site.

## Collected interfaces

| Endpoint relative to the base URL | Purpose |
|---|---|
| `GET v1/info` | Application version and capability check |
| `GET v1/sites` | Controller-local site identifiers |
| `GET v1/sites/{id}/devices` | Adopted-device counts and states |
| `GET v1/sites/{id}/clients` | Connected-client aggregates |
| `GET v1/sites/{id}/devices/{deviceId}/statistics/latest` | Optional fresh device-health statistics |

The collector uses `X-API-Key` and JSON responses. Lists are paginated using offset/limit; counts, offsets, unique IDs and completion are checked. Inconsistent or incomplete pagination fails collection rather than producing an artificially low inventory. Requests never adopt, restart, delete or reconfigure devices.

## What the metrics mean

Device state and client counts are aggregates, not unique people or community participation. Optional CPU/memory statistics require recent heartbeat evidence. Missing or stale optional fields are unavailable, not zero.

Device uptime means time since restart, not service-availability percentage. Device uplink rates describe topology links; summing them would double-count traffic and does not establish ISP usage. These selected endpoints do not provide authoritative community WAN outage, latency or packet-loss evidence.

Community internet availability therefore needs a separately configured measurement with a clear vantage point. A controller or access point being online is not enough.

## Compatibility and privacy

Contract tests cover official Network 9.1.120, 9.4.17 and 10.6.106 shapes. They do not certify every hardware model, operating environment or later version. Confirm capabilities and privileges on the target deployment before enabling collection.

Client/device names, MAC/IP addresses and individual connection identifiers are used only where needed for transient validation/deduplication and are not persisted in reporting. Authentication, schema, pagination, timeout and rate-limit failures use bounded HubOS diagnostics, not upstream response bodies.

## Upstream references

- [Official API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Local API/key guidance](https://help.ui.com/hc/en-us/articles/31228198640023-External-Hotspot-API-for-Authorization-Clients)
- [Network 9.1.120 contract](https://developer.ui.com/network/v9.1.120/openapi.json)
- [Network 9.4.17 contract](https://developer.ui.com/network/v9.4.17/openapi.json)
- [Network 10.6.106 contract](https://developer.ui.com/network/v10.6.106/openapi.json)
- [UniFi self-hosting](https://help.ui.com/hc/en-us/articles/34210126298775-Self-Hosting-UniFi)

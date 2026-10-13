# Headwind Community connector

The `headwind` module reads aggregate device inventory and check-in evidence from Headwind Community. Headwind remains responsible for enrolment, applications, policy and remote management; HubOS performs no device-management commands.

## Requirements and configuration

Configure the installation origin and optional web-application context as the base URL. Remote instances require verified HTTPS. Complete upstream administrator/password setup before creating a dedicated collection account.

```json
{
  "credential_refs": {
    "username": "env:HMDM_READER",
    "password": "env:HMDM_READER_PASSWORD"
  },
  "check_in_max_age_seconds": 86400
}
```

The password reference contains the account's actual password. The connector applies Headwind's uppercase-MD5 login protocol itself; the resulting digest is also a secret. JWT tokens stay in memory and never enter reporting data.

## Reader account

Use a non-super-admin account restricted to the required groups and configurations. For Community 5.39.2, a custom role without management permissions can read the required inventory/lookup interfaces. Verify access on the deployed version rather than trusting a role label such as Observer.

Do not grant `edit_devices`, `edit_device_desc`, settings/configuration administration, application/file editing or super-admin privileges for collection. A collector issuing only read operations does not prove that its credentials cannot write; check account permissions separately.

## Mappings and endpoints

Map stable numeric IDs using namespaces such as `group:3` or `configuration:7`. Names are not stable identifiers. Multiple matching mappings to one site count a device once; conflicting mappings to different sites fail collection.

| Endpoint | Purpose |
|---|---|
| `POST rest/public/jwt/login` | Read-session authentication |
| `POST rest/private/devices/search` | Paginated, account-scoped inventory query |
| `GET rest/private/groups/search` | Group lookup |
| `GET rest/private/configurations/list` | Minimal configuration lookup |

Send and accept JSON explicitly. Inventory searches use POST but are read-only. Responses require application `status: "OK"` as well as HTTP success. Pagination is one-based with a declared total; duplicate IDs, changing totals or missing-configuration/count mismatches are collection failures.

## Check-in interpretation

`lastUpdate` is Headwind's server receipt time in milliseconds since Unix epoch. It is not enrolment time, device charging evidence, app use or a participant count.

HubOS produces inventory, recent, stale and unknown check-in counts. Missing, zero or implausibly future timestamps are unknown. A stale collector makes its current counts unavailable even when an earlier inventory was complete. Device colour/status summaries are not universal community connectivity states.

## Compatibility and privacy

Integration tests exercise Community 5.39.2, multi-page inventory, minimum reader access, management rejection and server-timestamp check-ins. Other deployments need capability/access verification, especially where custom authentication or policies are enabled. Browser-cookie fallback and premium analytics are not required.

Device numbers, descriptions, IMEIs, addresses, serials, custom fields and enrolment secrets are discarded before persistence. Only approved numeric aggregates reach reporting storage. Headwind may update its ordinary authentication metadata when an account logs in; read-only collection means no infrastructure management changes.

## Upstream references

- [Headwind open-source edition](https://h-mdm.com/open-source/)
- [Community 5.39.2 source](https://github.com/h-mdm/hmdm-server/commit/05810c09cb4ef30829c4bb75f8345841de9bf1e9)
- [JWT authentication](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/jwt/src/main/java/com/hmdm/security/jwt/rest/JWTAuthResource.java)
- [Inventory API](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/resource/DeviceResource.java)
- [Device timestamp fields](https://github.com/h-mdm/hmdm-server/blob/05810c09cb4ef30829c4bb75f8345841de9bf1e9/server/src/main/java/com/hmdm/rest/json/view/devicelist/DeviceView.java)

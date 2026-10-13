# Operator and machine access

HubOS separates people using the console from machines submitting evidence. This guide covers a trusted single installation; it is not a multi-partner access model or security certification. Use the [security policy](../SECURITY.md) to report vulnerabilities.

## Operator access

Caddy protects the console, reporting API, API documentation and administrator actions with Basic authentication. Choose an operator username and a unique password, then configure its bcrypt hash:

```sh
docker run --rm -it --network none caddy:2.11.4-alpine caddy hash-password --algorithm bcrypt
```

Store the result as a single-quoted `HUBOS_OPERATOR_PASSWORD_HASH` in the private deployment `.env`. Set `HUBOS_OPERATOR_USERNAME` separately. Do not put a plaintext password in the hash field. An empty or invalid hash makes Caddy refuse startup.

After successful authentication, Caddy removes the browser's Authorization header and supplies an internal administrator key to HubOS. Client-supplied admin headers are overwritten; an admin key cannot bypass public operator login. The browser does not need the internal key.

Basic authentication has no general logout/session-management facility. On shared devices, use separate browser profiles and close sessions appropriately. Operator mutations reject foreign/opaque origins and cross-site requests, require JSON and enforce a 1 MiB body limit.

### Community site administration

The v0.2.0 source tree supports `POST /api/v1/sites` and `PATCH /api/v1/sites/{siteId}` through the authenticated operator entry point. These endpoints are not part of the published v0.1.0 API. The API description at `/api/v1/openapi.json` lists their request fields.

Create a site with its existing organisation UUID, a non-personal site code, name and two-letter country code. Classification defaults to `other`; `school`, `community_centre` and `library` are examples, not an exhaustive list. Time zones and optional coordinates are validated. Live mode rejects synthetic sites.

Edits can change the name, country, classification, time zone and coordinates. A coordinate can be cleared with JSON `null`. The canonical UUID, organisation, site code and synthetic/live classification are immutable through this endpoint, keeping existing observations and mappings attached to their original identity. Duplicate codes within one organisation are rejected. Creating a site does not create a controller mapping, a monitor or healthy evidence.

All operators in this single-installation access model have the same administrative authority. Organisation identifiers group records; they do not provide partner isolation. Source and mapping administration must retain their separate validation and privacy boundaries.

## Machine access

Only these explicit POST routes bypass operator login:

- `/api/v1/ingest/observations:batch`, requiring `x-hubos-ingest-key`.
- `/api/v1/source-connections/{sourceId}/webhook`, requiring that source's `x-hubos-webhook-key`.

Bypassing operator login does not bypass HubOS authentication. Browser credentials cannot substitute for a machine key. Wrong methods, unrelated paths and configuration/reporting endpoints remain operator-protected. Minimal GET health/readiness endpoints are public for service checks.

Use distinct, strong administrator, ingestion and per-source webhook credentials. Production configuration rejects placeholder, weak or reused administrator/ingestion keys. Source passwords and tokens use environment or mounted-file references; never place literal credentials in reporting fields.

## Network and TLS boundary

Keep the API/database private and use Caddy as the external HubOS entry point. Default host bindings are loopback; standalone Bun development also defaults to loopback. Do not publish Caddy's administrative port 2019.

Local `HUBOS_SITE_ADDRESS=:80` is for loopback use only. A remote HubOS binding requires an explicit HTTPS origin such as `https://monitoring.example.org`, correct DNS, a reviewed 80/443 listener configuration and certificate provisioning. Do not reuse the public installer hostname for a deployment without a deliberate domain decision.

Setting a hostname alone does not configure remote TLS for Metabase, Kuma, ODK or Headwind. Keep their direct ports private and review each upstream application's exposure. Never publish example credentials or remove TLS verification to make a connection work.

Caddy certificate/configuration volumes contain sensitive material. Preserve them securely. Use upstream TLS procedures for optional applications and a trusted private CA where appropriate.

## Data protection and responsibilities

- Collect only approved operational fields and aggregate numeric metrics.
- Keep raw vendor bodies, personal identifiers and browsing records out of reporting.
- Treat site/infrastructure identities as sensitive operational data where appropriate.
- Restrict local secret files to their owner; exclude them from Git and issue reports.
- Back up databases, tool storage, configuration and encryption secrets to protected storage.
- Test restoration in isolated volumes before depending on a backup.
- Assign responsibility for patching, credential rotation, retention and incident response.

Trusted plugins execute with the process's privileges. Private Docker networks and Basic login do not sandbox plugins or provide tenant isolation. Deployments needing separate partners, SSO/MFA, advanced roles or stronger compliance controls must implement those boundaries explicitly rather than assume them.

## References

- [Caddy Basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [Caddy header handling](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers)
- [Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Compose environment interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

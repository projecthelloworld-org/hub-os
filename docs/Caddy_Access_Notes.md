# Caddy operator and machine access: implementation notes

Primary-source research checked 13 October 2026. **Examples below are not executed or validated configurations.** They define the intended boundary for the next implementation/tests; this note does not change runtime, Compose, credentials or services.

## Development implementation and local verification

The repository's `config/caddy/Caddyfile` now implements this boundary. Local tests
used Caddy **2.11.4**, image digest
`sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648`.
The separate `hubos-v02-access-test` project runs the actual HubOS API with an
in-memory fictional dataset behind the same Caddyfile. Tests passed for missing/wrong
operator authentication, protected read/write routes, spoofed/duplicate admin keys,
browser Authorization removal, stripping unrelated machine keys, source-scoped
hooks, ingestion credentials, wrong methods/paths and minimal health endpoints.
Validation also rejected an empty operator hash without changing the running proxy.

Operator writes reject foreign/opaque origins and cross-site browser requests, and
require the exact JSON media type. JSON bodies are stream-bounded to 1 MiB regardless
of a missing or misleading Content-Length header. Non-browser requests without an Origin header
still require authenticated operator routing or an internal administrator key.
The API uses the explicit HTTPS site origin for remote-origin checks; configuration
rejects remote bindings without HTTPS and rejects weak/reused production machine keys.
Caddy stores certificate/configuration state in persistent volumes and exposes no
administrative port. These are basic single-installation controls, not multi-partner
isolation, OIDC/MFA, a trusted-plugin sandbox or a completed production-security audit.

Manual development startup requires `HUBOS_OPERATOR_USERNAME` and a valid bcrypt
`HUBOS_OPERATOR_PASSWORD_HASH` in `.env`. Keep the hash single-quoted and the file
private. The public `v0.1.0` installer remains unchanged; interactive operator setup,
remote TLS rollout checks and the other v0.2.0 release gates are still pending.
The remaining illustrative/source material below records the research basis.

## Operator password and environment syntax

Caddy 2.8 renamed `basicauth` to **`basic_auth`**. Current syntax is `basic_auth [matcher] [hash_algorithm [realm]] { username hashed_password }`; default algorithm is bcrypt. It requires a password hash, not plaintext. `{env.NAME}` placeholders are explicitly supported for usernames/hashes, resolved when the configuration is loaded. [Official basic-auth reference](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

```caddyfile
basic_auth bcrypt "HubOS operators" {
    {env.HUBOS_OPERATOR_USERNAME} {env.HUBOS_OPERATOR_PASSWORD_HASH}
}
```

Generate the bcrypt hash with the selected Caddy image's `caddy hash-password --algorithm bcrypt`; omit `--plaintext` so the installer/test runner supplies the password through standard input, avoiding process arguments/history. Caddy's documented default bcrypt cost is 14. Handle a nonzero result as a failed installation step. Retain only the hash in protected configuration; never echo the input password or share adapted configuration containing machine keys. [Hashing command](https://caddyserver.com/docs/command-line#caddy-hash-password)

Caddyfile `{$NAME}` substitution happens **before parsing** and can expand to multiple tokens/lines. Use it for a validated site address, not unchecked user input. `{env.NAME}` is deferred replacement and not supported by every field; do not interchange the two forms blindly. Site addresses need the parse-time form. Validate installer-provided usernames/site addresses against line breaks and syntax injection. Fail closed if username/hash/internal key are missing or empty; Caddy will not enforce HubOS's credential-separation policy for us. [Environment substitution](https://caddyserver.com/docs/caddyfile/concepts#environment-variables)

Bcrypt hashes contain dollar signs. In a Compose `.env` file, single-quoted values are literal, while unquoted/double-quoted values undergo interpolation. Preserve the exact hash using a supported literal environment-file value or secret-file mechanism, and verify what reaches Caddy without printing it. YAML inline values require their own interpolation handling; do not assume shell quoting and Compose quoting are identical. [Compose interpolation rules](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

## Mutually exclusive route boundary

At the same nesting level, `handle` blocks are mutually exclusive; a matcherless `handle` is the fallback. Named matcher sets AND their different matcher types, so an exact path plus method restriction is appropriate. Exact `path` does not require `*`; broad path wildcards risk exempting unrelated operator administration. `path_regexp` uses RE2 and the decoded path. Avoid `handle_path`: it strips a prefix, changing the `/api/v1` URLs that must remain stable. A `route` group can preserve explicit branch ordering. [Handle semantics](https://caddyserver.com/docs/caddyfile/directives/handle), [matcher semantics](https://caddyserver.com/docs/caddyfile/matchers), [directive ordering](https://caddyserver.com/docs/caddyfile/directives#directive-order)

Illustrative configuration, **not yet executed**:

```caddyfile
{$HUBOS_SITE_ADDRESS} {
    @health {
        method GET
        path /healthz /readyz
    }
    @ingest {
        method POST
        path /api/v1/ingest/observations:batch
    }
    @source_webhook {
        method POST
        path_regexp source_webhook ^/api/v1/source-connections/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/webhook$
    }

    route {
        handle @health {
            reverse_proxy api:3000 {
                header_up -Authorization
                header_up -X-HubOS-Admin-Key
                header_up -X-HubOS-Ingest-Key
                header_up -X-HubOS-Webhook-Key
            }
        }
        handle @ingest {
            reverse_proxy api:3000 {
                header_up -Authorization
                header_up -X-HubOS-Admin-Key
                header_up -X-HubOS-Webhook-Key
            }
        }
        handle @source_webhook {
            reverse_proxy api:3000 {
                header_up -Authorization
                header_up -X-HubOS-Admin-Key
                header_up -X-HubOS-Ingest-Key
            }
        }
        handle {
            basic_auth bcrypt "HubOS operators" {
                {env.HUBOS_OPERATOR_USERNAME} {env.HUBOS_OPERATOR_PASSWORD_HASH}
            }
            reverse_proxy api:3000 {
                header_up -Authorization
                header_up -X-HubOS-Ingest-Key
                header_up -X-HubOS-Webhook-Key
                header_up X-HubOS-Admin-Key {env.HUBOS_ADMIN_KEY}
            }
        }
    }
}
```

The machine branches bypass **operator Basic auth**, not HubOS authentication: the app must continue validating its ingestion key or the source-scoped webhook key. The health branch exposes only deliberately minimal health/readiness answers, never administration. Wrong methods, trailing paths and every other `/api/v1` resource fall into the protected operator branch. Demo probes, if exposed, need a separate explicit demo-only policy—not a blanket `/demo/*` exception. Consider keeping readiness private when deploying publicly.

The UUID route restricts syntax only; it does not authorize a source or validate the body. The backend must reject unknown/disabled sources, wrong keys, invalid payloads and excessive request size. Keep this credential check independent of an operator browser session.

## Header overwrite and Authorization behavior

`reverse_proxy` forwards incoming headers by default, including `Authorization`, except for its documented treatment of `X-Forwarded-*`. Consequently successful `basic_auth` must **not** be assumed to remove the browser's Basic credentials before proxying. Explicit `header_up -Authorization` drops that header from the upstream request after Caddy has authenticated it. The operator username is available as `{http.auth.user.id}` if a future audit feature needs it, but it is not an independent authorization credential. [Proxy defaults/header manipulation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers), [authenticated-user placeholder](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

`header_up X-HubOS-Admin-Key <trusted-value>` **sets/replaces** the header, overwriting all preexisting client values; do not use the `+` form, which appends. In the operator branch, this overwrites a spoofed or duplicate incoming internal-admin header with Caddy's trusted value. In every exempt branch, remove that header outright. Preserve only the ingestion/webhook key relevant to that branch. If HubOS later authenticates machines with Authorization bearer tokens instead of its current separate headers, revisit this explicit removal policy rather than silently dropping required credentials. [Set/delete semantics](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers)

The internal admin key must be different from the operator password, ingestion key and all source webhook keys, and must never be delivered to browser JavaScript. This scheme makes Caddy a trusted administrator credential broker for authenticated operators; it is not per-user RBAC or multi-partner isolation. Do not expose the API's port directly or leave another unprotected proxy route to it. Trusted plugins/containers on the backend network remain inside the trust boundary; network membership is not an application sandbox.

## Explicit HTTPS, listeners and persistence

For remote exposure, use a validated address such as **`https://monitoring.example.org`**. A hostname activates automatic HTTPS; `http://...` or `:80` explicitly selects HTTP and must be limited to loopback local testing. Do not repurpose the existing public installer hostname for this operator service without a deliberate deployment/domain decision. Basic auth over plain HTTP does not protect the password from interception. [Site addresses](https://caddyserver.com/docs/caddyfile/concepts#addresses), [Basic-auth transport warning](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

The container must publish/forward appropriate TCP **443** for HTTPS and usually **80** for automatic redirect and HTTP ACME challenges; optional UDP 443 enables HTTP/3. DNS and public challenge reachability must match the actual deployment. Nonstandard local host-port mappings do not automatically make public ACME work. DNS challenges require an explicitly configured provider module and separate credentials; the default image is not a Cloudflare DNS configuration. Local `tls internal` requires deliberate trust of Caddy's local CA, not globally disabling TLS verification. [Automatic HTTPS prerequisites/challenges](https://caddyserver.com/docs/automatic-https)

Official container recipes set `XDG_DATA_HOME=/data` and `XDG_CONFIG_HOME=/config`. Persist both locations in writable volumes, particularly `/data` for certificate/private-key/CA material. The mounted Caddyfile itself can remain read-only. Back up certificate/CA storage with appropriate secret protection. The current repository's `caddy:2-alpine` is a moving tag: choose/record the actual Caddy version and image digest and verify `basic_auth` exists before release testing. [Official container recipe](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile), [certificate storage](https://caddyserver.com/docs/automatic-https#storage)

Do not publish Caddy's administrative API port **2019** to the host; it can load sensitive configuration and change routing. Keep administration local to the container or use an explicitly hardened control channel. Do not include `caddy adapt --pretty` output or full effective Compose configuration in routine logs because expanded credentials may appear there.

## Verification gates

Run `caddy validate --config <fixture-Caddyfile> --adapter caddyfile` using the selected image and fixture environment. Validation provisions configuration without starting its HTTP listeners; successful adaptation alone is weaker and does not verify hashes, missing certificate files or all runtime behavior. Use sanitized results only. [Validation versus adaptation](https://caddyserver.com/docs/command-line#caddy-adapt)

Then exercise an owned isolated proxy fixture: operator UI/read/admin routes reject missing/wrong Basic auth; correct Basic succeeds; spoofed/duplicate admin headers never pass through; machine requests cannot use Basic to substitute for ingestion/source keys; correct machine keys work only on their intended endpoint; invalid source/method/path remain rejected; Authorization never reaches a header-observing backend; health has no elevated header; operator credentials do not appear in responses/logs; remote exposure requires valid TLS; and repeated startup preserves certificate storage. Test encoded/trailing paths, case variants and matcher ordering rather than assuming the example has passed. Browser Basic auth has no general logout/session-management or CSRF-token feature; verify the backend rejects unwanted cross-origin mutation requests and document that limitation. No account or service changes were made during this research.

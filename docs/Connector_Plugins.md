# Connector plugins

HubOS imports trusted local JavaScript packages; it does not download code, provide a marketplace or sandbox plugins. A plugin has the same privileges as the HubOS process. Review the package and its dependencies before enabling it.

Built-ins are discovered from connector directories. Additional packages are enabled explicitly in a configuration file selected by `HUBOS_PLUGIN_CONFIG`. Copy `config/plugins/local.example.json`, provide a local package path and set `enabled` to `true`, then restart API and worker. Container installation must mount both the configuration and the reviewed package paths; a package is never fetched automatically.

The standard Compose configuration already mounts `config/plugins` at `/config/plugins` and `plugins` at `/plugins`, read-only. Install a reviewed package in `plugins/<name>`, enable `/plugins/<name>` in `config/plugins/local.json`, and set `HUBOS_PLUGIN_CONFIG=/config/plugins/local.json` in `.env`. There is no need to edit core imports or Compose for an ordinary new connector. Optional credentials can be added to the private `config/source-secrets.env`, loaded by API and worker; keep it mode 600. This optional-env-file mechanism requires Docker Compose 2.24 or later.

The package declares `hubos.connector` in `package.json` and exports its lifecycle object as the default export. The entry point must stay inside that package. The example in `examples/starter-connector` is deliberately synthetic and produces a new metric through the canonical observation store without core changes.

## Protocol 1.0

The manifest declares `id`, `name`, semantic `version`, `protocolVersion`, `collectionModes` and `capabilities`. Required methods are `validateConfig`, `collect`, `normalize` and `health`. Optional `provision` and `webhook` methods use the same injected context; provisioning must be restricted to HubOS-owned tools, never an externally managed production source.

Collectors receive one source connection and its verified site mappings, non-secret configuration, resolved credentials, a bounded JSON request client, collection time and cancellation signal. The scheduler can scope a job to one connection; several connections can use the same plugin. Collectors may make read-only upstream requests, including APIs whose read-only searches use POST.

Normalization returns `envelopes` and optionally `statuses`. Each envelope contains `schema_version: "1.0"`, connector/source IDs, an external site identifier, a stable external record ID, observation time and numeric metric records. A metric uses a dotted name, value, unit and quality. Several external identifiers can map to one canonical site. Unmapped identifiers are rejected; a plugin cannot override the canonical mapping by supplying its own HubOS ID.

`checkConnectorConformance()` exercises a plugin with a sanitized fixture. It establishes shape/mapping compatibility only, not real-deployment compatibility. Run fixture and upstream integration tests for each supported version.

## Privacy and reliability

Credential settings use `credential_refs`, for example `{ "apiKey": "env:UNIFI_API_KEY" }` or `{ "password": "file:/run/secrets/source-password" }`. Never put literal credentials in configuration or returned observations. Keep device names, MACs, IMEIs, respondent fields and browsing histories out of normalization. Raw vendor responses are not persisted: retained evidence is a projection of accepted numeric observations and allowlisted attributes.

The runtime validates source/mapping identities before ingestion, preserves newer status evidence, renews job leases and fences completion/failure from abandoned workers. HTTP requests have deadlines and response-size limits; redirects are refused, failures use redacted codes and rate-limit delays inform scheduling retries. These safeguards do not make arbitrary third-party code safe.

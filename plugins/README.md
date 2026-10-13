# Trusted local connector packages

Install reviewed packages in this directory. HubOS mounts it read-only at `/plugins`.
Packages are ignored by Git and are not downloaded automatically.

For the synthetic starter, copy `examples/starter-connector` into
`plugins/starter-connector`, copy `config/plugins/local.example.json` to
`config/plugins/local.json`, enable the package, and set
`HUBOS_PLUGIN_CONFIG=/config/plugins/local.json` in the deployment `.env`.
Restart API and worker after package or loader-configuration changes.

Optional credential variables belong in the private, Git-ignored
`config/source-secrets.env`; source settings use `env:NAME` references. A
plugin's configuration and verified mappings are separate from its installation.
See `docs/Connector_Plugins.md` for the lifecycle and trust requirements.

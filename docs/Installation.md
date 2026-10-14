# Install HubOS

HubOS provides an interactive terminal installer and a modular Docker Compose environment. Choose a published release for a reproducible installation; use a source checkout when contributing or evaluating unreleased capabilities.

**Security notice:** v0.1.0 includes Metabase 0.60.7, affected by a critical upstream advisory. Do not expose it publicly or use it for sensitive data. Read [Metabase upgrade guidance](Metabase_Compatibility.md) and the [upstream advisory](https://github.com/metabase/metabase/security/advisories/GHSA-vwf4-m7j8-wcjf).

## Requirements

- A supported operating system with a running Docker engine and Compose plugin.
- Enough memory/storage for the selected services, persistent data and backups.
- Network access to download release assets and container images.
- Git when fetching optional upstream ODK/Headwind deployments.
- A person responsible for credentials, source access, updates and restoration.

The installer does not install Docker silently. Supported Ubuntu/Debian installation requires approval; on macOS, install and start your chosen Docker application first. Compose 2.24 or later is required by the optional environment-file configuration used by the source stack.

## Stable one-command installation

```sh
curl -fsSL https://hubos.myhellohub.org/install.sh | bash
```

Review a downloaded script before execution. The installer reads answers from the terminal even when piped, verifies the embedded archive checksum and extracts the selected package. It asks for bind/port settings and Metabase administrator details, generates independent service secrets and creates an owner-readable `.env`.

The public endpoint follows GitHub's latest stable release, excluding drafts/prereleases. It currently serves v0.1.0, a demonstration package—not the full upcoming monitoring release. [The roadmap](Roadmap.md) defines that distinction.

For a fixed release:

```sh
curl -fsSL https://hubos.myhellohub.org/releases/v0.1.0/install.sh | bash
```

The installer is a separate release asset, excluded from the checksum-sealed archive. Download it alongside an unpacked release, or use the versioned URL above. From a release checkout containing the script, run `./install.sh`. Use `./install.sh --help` for its exact options. `--profile ecosystem` includes optional ODK Central and Headwind MDM; these require additional resources and upstream configuration.

## Source checkout and demonstration

Follow [contributor setup](Local_Development.md) rather than assuming that an installer from an unreleased checkout has the same contract as a published package. Configure operator authentication and private credentials before starting the source Compose stack.

Default local addresses are HubOS `http://localhost:8080`, Metabase `http://localhost:3001`, Kuma `http://localhost:3002` and Mailpit `http://localhost:8025`. Tool availability depends on the installed release and enabled layers.

The v0.2.0 source installer offers `--mode demo` and `--mode live`. Demonstration mode includes fictional community sites; live mode excludes the seed layer and unconfigured sources. These options are not available in the published v0.1.0 installer.

```sh
./install.sh --mode live
```

Interactive setup collects operator, Metabase and Kuma account details. It generates independent service/reporting and source-webhook credentials, hashes the operator password with the pinned Caddy image and keeps administrator passwords in `.hubos-credentials`, readable only by its owner. Passwords are not printed to terminal logs. Protect that file alongside `.env`; do not commit, share or source it as a shell script.

The source installer includes the monitoring layer and waits for successful migration, dashboard and Kuma provisioning as well as application health. A failed provisioning task is an installation failure, even if a dashboard application is already reachable. `--no-start` prepares and validates configuration but does not prove that provisioning or connections have succeeded.

Synthetic demonstration records must stay separate from live data. Do not reseed a live deployment or interpret generated faults as field observations.

## Unattended installation

Provide release-supported settings through a protected environment or secret manager. For the v0.1.0 installer:

```sh
METABASE_ADMIN_EMAIL=operator@example.org \
METABASE_ADMIN_PASSWORD='replace-with-a-private-secret' \
HUBOS_BIND_ADDRESS=127.0.0.1 \
./install.sh --non-interactive --yes
```

Do not store actual secrets in shell history, shared logs or example files. Omitted supported service secrets are generated. `--no-start` prepares configuration without starting containers; `--install-dir PATH` selects the installation directory.

A reviewed mirror archive requires both `HUBOS_RELEASE_URL` and its verified `HUBOS_RELEASE_SHA256`. Changing the URL does not waive checksum validation.

## Existing installations and upgrades

The installer preserves an existing `.env` rather than silently rotating credentials attached to persistent databases. Changing a database password in `.env` alone does not rotate the password in that database.

The source installer adds missing monitoring settings without replacing existing database passwords, application encryption keys or tool accounts. Repeated setup preserves those settings. An installation cannot silently change from demonstration to live mode: use a separate directory and fresh volumes so fictional history is not mistaken for operational evidence.

Before an upgrade, preserve:

- HubOS PostgreSQL and Metabase application databases.
- Installation configuration, `.hubos-credentials`, source secret files and encryption keys.
- Kuma data and HubOS-managed secret storage where present.
- Caddy certificate/configuration storage.
- Optional ODK/Headwind data according to upstream backup procedures.

Restore rehearsal must use fresh isolated volumes, not the running installation. Preserve tool encryption secrets and use matching images when restoring. Follow [Metabase upgrade/rollback guidance](Metabase_Compatibility.md); do not attach an experimental version to an original database.

## Remote exposure

Keep direct tool/database ports private. Remote access needs verified TLS, deliberate DNS/listener configuration, strong credentials, reviewed firewall exposure and a tested recovery plan. [The access guide](Security_and_Access.md) explains the trusted boundary and its limitations.

Docker's published ports can interact with host firewall rules differently from ordinary host processes. Review the effective exposure rather than assuming a host firewall protects every published port.

## Installer publication

Release maintainers use the `Release` and `Publish installer` workflows. Publication validates installer metadata, archive checksums and Bash syntax before deploying the Pages payload. Archives, SBOMs and checksum manifests stay in GitHub release assets.

The public installer domain is distinct from operator deployment domains. Its Pages custom-domain/DNS settings belong to project maintenance, not a requirement for self-hosting HubOS. See the [release checklist](../.github/RELEASE_CHECKLIST.md).

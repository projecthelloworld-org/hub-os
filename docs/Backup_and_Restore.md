# Backup and restore

Protect the installation's data, configuration and tool state together. Store encrypted copies off the host, restrict access, monitor backup failures and rehearse restoration before relying on a snapshot. A checksum is an integrity check, not proof that a backup came from a trusted operator.

These commands belong to the v0.2.0 source tree; they are not included in the published v0.1.0 package. The recovery command requires Bun 1.3.14 or later and access to the deployment's Docker engine. Use the matching HubOS package, image architecture and exact installed images for restoration, then perform upgrades separately.

The snapshot records image identities but does not embed container images. Preserve those exact images separately in a protected registry or `docker image save` archive, especially the locally built HubOS image. Load them into the recovery engine before restoration; rebuilding an image or pulling a moving tag may produce a different identity and will be rejected.

## Scope

The core snapshot contains:

- HubOS PostgreSQL and the Metabase application database, including accounts and saved resources.
- Kuma's persistent data, including its SQLite database and sidecar files.
- HubOS-managed secret storage and Caddy certificate/configuration volumes.
- `.env`, `.hubos-credentials`, `config` and trusted local `plugins`, where present.
- A manifest of image identities and SHA-256 checksums for every artifact.

Optional ODK/Headwind databases and volumes are **not** included. Secret files outside the installation, external secret managers, custom Compose overrides, host configuration and externally managed source systems need separate protection. Symlinks in the copied configuration are rejected rather than followed.

## Create a consistent snapshot

Schedule a maintenance window and prevent other administrators from starting provisioning or writing directly to the databases. The command stops API, worker, Caddy, Metabase and Kuma writers; the two PostgreSQL servers remain available for logical dumps. This briefly interrupts operator access, collection and reachability checks. It does not establish a community connectivity outage.

```sh
bun scripts/backup.js create \
  --directory /srv/hubos \
  --output /srv/private-backups/hubos-snapshot-01 \
  --confirm-pause
bun scripts/backup.js verify --backup /srv/private-backups/hubos-snapshot-01
```

Choose a new output directory outside the installation. The command rejects active migrations, provisioning or demonstration seeding. It waits for writers to stop before copying Kuma storage, then resumes only services that were running before the snapshot. Do not replace this process with a copy of live SQLite files.

Snapshot files are owner-readable and the directory is owner-accessible only. They are **not encrypted**. Encrypt and transfer the completed directory using your organisation's approved storage process; keep encryption keys separately available for disaster recovery. Do not upload the snapshot to an issue, pull request or public CI artifact.

## Interrupted or failed backups

SIGINT/SIGTERM request cancellation after the current operation finishes; service resumption may take time. A directory without `manifest.json` is incomplete and must not be used. A nonzero exit status requires investigation even if the snapshot has a manifest: resumption may have failed.

Power loss or a forced process termination can leave services stopped. Inspect the original deployment and `.hubos-recovery.lock/owner.json`. Do not remove a lock based only on its age. Confirm the recorded process is no longer active, resume the original services with the same Compose layers and verify health before removing the lock. Never run two maintenance operations concurrently.

## Restore to isolated storage

1. Obtain a trusted snapshot, matching HubOS package and the original images. Verify the snapshot before accessing Docker.
2. Unpack the matching package into a new directory with no private `.env` or credentials. Move its bundled `config` and `plugins` directories aside, preserving them as package defaults; the snapshot supplies the installation's copies.
3. Choose a distinct Docker project with no containers or volumes. Do not use the original project's name or storage.

```sh
bun scripts/backup.js verify --backup /srv/private-backups/hubos-snapshot-01
bun scripts/backup.js restore \
  --backup /srv/private-backups/hubos-snapshot-01 \
  --directory /srv/hubos-restored \
  --project hubos-restored-01 \
  --confirm-isolated
```

Restore checks artifact integrity, archive paths, target namespace and image identities. It imports both databases into fresh storage and restores the four core volumes. Existing target configuration or storage is rejected. It does not overwrite the original deployment or silently download replacement images.

Successful restoration leaves **all applications stopped**, records `restored-not-started` in `.hubos-restore.json` and disables HubOS notification delivery. A failed restore can leave an incomplete, stopped target; retain it for diagnosis or deliberately discard only that isolated project's storage before trying again. It is not safe to rerun imports into a partially restored database.

## Review before startup

Review these settings before running the installer or starting the same Compose layers:

- Use separate loopback ports and a reviewed operator origin; do not compete with the original deployment's listeners or certificates.
- Review every source connection and Kuma monitor target. Disable live sources during a rehearsal so collectors do not contact production systems.
- Review Kuma/Metabase notification destinations, including operator-added destinations. Disabling HubOS SMTP does not disable every upstream notification channel.
- Restore external secret references, keep tool encryption keys unchanged and protect restored administrator credentials.
- Keep the new project name saved in `.env`; changing it selects different storage.

For a live core installation, the startup layers are `compose.yaml`, `compose/mel.compose.yaml` and `compose/monitoring.compose.yaml`. Add the demonstration or TLS layer only when appropriate to the saved configuration. Normal provisioning recreates the read-only analytics role and verifies retained tool resources; do not reset accounts or delete customized dashboards to bypass a failure.

Verify canonical site identities, observations, mappings, incident history, reporting permissions, account access, dashboard customizations, Kuma monitor identities and collection freshness. Enable intended sources and delivery only after the restore is accepted. A running container alone is not a successful recovery test.

## Optional applications

**ODK Central:** follow the [official backup and restore guide](https://docs.getodk.org/central-backup/). Its database backup does not preserve Enketo Redis/configuration keys needed for existing web-form links, or attachments offloaded to external storage. Protect these separately and test the relevant upstream restoration procedure with a compatible Central version. Central restoration replaces its target data; never rehearse against the original instance.

**Headwind Community:** follow the [upstream backup guidance](https://qa.h-mdm.com/5032/how-to-make-a-backup-of-headwind-mdm) and [migration guidance](https://qa.h-mdm.com/1986/how-to-migrate-from-dev-server-to-production-server). Preserve PostgreSQL data, application/file/plugin storage, deployed application and Tomcat configuration. Adapt paths and ownership to the actual container mounts rather than copying host-installation examples unchanged. Keep enrolment domains and MQTT settings consistent where device continuity is required. Restore into an isolated upstream deployment before accepting the backup.

See [installation](Installation.md), [operator access](Security_and_Access.md) and [Metabase upgrades](Metabase_Compatibility.md) for related responsibilities.

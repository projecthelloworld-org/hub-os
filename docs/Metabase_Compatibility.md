# Metabase compatibility and upgrades

HubOS uses Metabase Open Source for analytical dashboards and data-based alerts. Upstream maintenance status and HubOS compatibility are separate: a pinned image provides reproducibility, not a guarantee of security. Review advisories and promote a maintained replacement after dashboard, alert, access-control and upgrade checks pass. A working health endpoint alone does not establish compatibility.

## Selecting a maintained version

The v0.2.0 source tree pins Metabase Open Source `0.64.1.7` by its multi-platform image digest. Its native compatibility checks cover fresh/repeat provisioning, all four dashboards and filters, actual alert delivery and an application-database upgrade from `0.60.7` that preserves encrypted connections and operator-owned resources. This does not replace a backup/restore rehearsal for a particular installation. The published v0.1.0 package remains unchanged.

Metabase's security policy normally provides maintenance updates for the latest release, with discretionary security hotfixes for older releases. Do not interpret an older downloadable image or an occasional backport as a continuing support commitment. Check the [upstream security policy](https://github.com/metabase/metabase/blob/v0.64.1.7/SECURITY.md) and [stable releases](https://github.com/metabase/metabase/releases) when preparing a HubOS release.

The stable 64.1 release advertises the OSS image `metabase/metabase:v0.64.1.x`. The final `.x` is a moving alias for the latest hotfix in that point release, not an immutable version. Metabase uses `License.Major.Point.Hotfix`: `0` identifies the open-source edition; `1` identifies its commercial edition. Resolve the alias to an explicit hotfix tag and pin its multi-platform image digest for reproducible installations. Keep the image reference, running application version and upstream source tag in the dependency record. See the [64.1 release](https://github.com/metabase/metabase/releases/tag/v0.64.1), [versioning guide](https://github.com/metabase/metabase/blob/v0.64.1.7/docs/developers-guide/versioning.md) and [official image tags](https://hub.docker.com/r/metabase/metabase/tags).

Metabase `0.60.7` is not a safe baseline for new deployments. The critical [CVE-2026-72898 advisory](https://github.com/metabase/metabase/security/advisories/GHSA-vwf4-m7j8-wcjf) identifies an unauthenticated SQL-injection vulnerability against the application database; its stated minimum fixed 0.60 release is `0.60.17`. That minimum addresses this advisory, not all future issues or ongoing maintenance. Prefer a maintained line after compatibility verification. If an affected instance's password-reset endpoint has been publicly accessible, follow the advisory's post-upgrade account, session, credential and log-review guidance; absence of an observed attack is not evidence of safety.

## Webhook destination policy in Metabase 64.1

For the Compose-private HubOS webhook destination, use:

```yaml
MB_HTTP_CHANNEL_ALLOWED_NETWORKS: allow-private
```

The setting is environment-only. Its default, `external-only`, rejects private-network destinations; `allow-private` permits public and private destinations but not loopback or link-local addresses. `allow-all` removes network restrictions and should not be used merely to make a Compose webhook work. The setting is a network-category policy, not a per-host allowlist; preserve network isolation and restrict who can edit webhook destinations. See the [environment-variable documentation](https://www.metabase.com/docs/latest/configuring-metabase/environment-variables#mb_http_channel_allowed_networks) and [address-policy implementation](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/util/http.clj).

In the 64.1 source, `http-channel-host-strategy` is a deprecated alias for `http-channel-allowed-networks`. Adopt the new environment name rather than depending on that alias indefinitely. Invalid policy values fail startup validation. HTTP notification delivery checks the destination and applies a DNS resolver that checks every resolved address at connection time, so a hostname resolving to a prohibited address can fail even if its URL looks valid. See [channel settings](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/channel/settings.clj) and the [HTTP channel implementation](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/channel/impl/http.clj).

## Provisioning API boundaries

Metabase's API is unversioned and may change. Use the deployed instance's `/api/docs` and the [API changelog](https://www.metabase.com/docs/latest/developers-guide/api-changelog) when updating the HubOS adapter; see the [API compatibility notice](https://www.metabase.com/docs/latest/api).

Direct saved-question queries in 64.1 require each supplied filter parameter to include a nonblank `id`, alongside its type, target and value. Use the saved question's template-tag ID, not an unrelated dashboard parameter ID. HubOS declares stable tag IDs for its provisioned questions. See the [card-query endpoint](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/queries_rest/api/card.clj) and [official template-tag parameter mapping](https://github.com/metabase/metabase/blob/v0.64.1.7/frontend/src/metabase-lib/v1/parameters/utils/template-tags.ts).

The 64.1 HTTP-channel schema accepts `type: "channel/http"`, a nonblank name, optional description/active values, and these details:

```json
{
  "url": "http://api:3000/api/v1/source-connections/<source-id>/webhook",
  "method": "post",
  "auth-method": "header",
  "fe-form-type": "api-key",
  "auth-info": { "x-hubos-webhook-key": "<dedicated-machine-secret>" }
}
```

This illustrates the upstream request schema, not installation credentials. Keep secrets out of reporting views, logs and published examples. Channel creation requires settings permission; duplicate channel names return HTTP 409, and readers without write permission do not receive channel details. See the [channel API](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/channel/api/channel.clj) and [detail schema](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/channel/schema.clj).

HubOS's native alert contract uses `payload_type: "notification/card"`, a card ID, `send_condition: "has_result"`, `send_once: false`, a saved HTTP `channel_id`, and a cron subscription. The upstream schema retains these fields. In Metabase 64, manually sending a saved notification requires write access: use its creator or an administrator, not a read-only viewer. Notification updates identify the object by its URL and replace handler/subscription sets; they are not sparse patches. Inline channels and templates have additional permission checks. Retest both provisioning and delivery under the intended service account. See the [notification API](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/notification/api/notification.clj), [notification schemas](https://github.com/metabase/metabase/blob/v0.64.1.7/src/metabase/notification/models.clj) and [documented 64 API changes](https://github.com/metabase/metabase/blob/v0.64.1.7/docs/developers-guide/api-changelog.md).

Webhook alerts include `type: "alert"`, question metadata and `data.raw_data.cols`/`rows`; `alert_id` can be null for test alerts. The envelope also includes creator information and a rendered image. HubOS should retain only approved operational fields, validate rows against known question identities and avoid persisting the full envelope. See the [documented webhook payload](https://www.metabase.com/docs/latest/configuring-metabase/webhooks#webhook-payload). Sending a connection test is not equivalent to sending a real alert or validating its rows.

## Upgrade and rollback procedure

1. Read security advisories, release notes and API changes for the target version. Rehearse both a fresh installation and an upgrade of a restored application-database backup in isolated storage. Do not attach an experimental image to the original application database.
2. Back up the **Metabase application database**, which contains accounts, questions, dashboards, alerts and connection settings. A HubOS analytics-data backup alone does not preserve those resources. Preserve the deployment configuration and encryption secret securely.
3. Keep the existing `MB_ENCRYPTION_SECRET_KEY` unchanged. The key is required to decrypt stored connection details. Adding a key to an existing unencrypted database is a separate, stopped-service `enable-encryption` procedure; changing it requires the documented rotation procedure. See [encryption guidance](https://github.com/metabase/metabase/blob/v0.64.1.7/docs/databases/encrypting-details-at-rest.md).
4. Stop the old Metabase process and start one instance of the exact new image against the restored database. Allow migrations to complete without premature health-check termination. The official image includes its Java runtime; the 64.1 Dockerfile uses Java 25, so a separate host Java installation is not required for this container deployment. See the [Dockerfile](https://github.com/metabase/metabase/blob/v0.64.1.7/bin/docker/Dockerfile).
5. Verify retained accounts and database connections, existing dashboard customizations, repeated provisioning without duplicates, every provisioned question and site/country/date filter, genuine fault/recovery delivery, blocked loopback/link-local destinations, least-privilege analytics access and backup restoration. Missing/stale operational data must still display as unknown, not healthy.
6. Schedule the real upgrade only after those checks pass. Roll back by restoring the pre-upgrade application database with the previous image and matching configuration. Do not simply start an older image against a migrated database.

Upstream permits a direct upgrade from the latest version 40 or later to the current version; older installations require intermediate steps. When stepping through major versions, use the latest point release of each destination. Metabase migrates automatically at startup. Its recommended rollback is a backup restore; the alternative `migrate down` must use the **higher-version** executable. These are upstream upgrade capabilities, not a promise that every HubOS adapter works with every Metabase version. See the [upgrade guide](https://www.metabase.com/docs/latest/installation-and-operation/upgrading-metabase).

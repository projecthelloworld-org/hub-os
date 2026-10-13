# HubOS release checklist

Use this checklist for a release candidate. Record results in the release's CI artifacts and review, not in user documentation. Publish only when the applicable checks pass.

## Installation and compatibility

- [ ] Fresh installation completes migrations and all required provisioning, not just container health checks.
- [ ] Repeat startup preserves tool accounts, dashboards, monitor edits and managed identities without duplicates.
- [ ] Upgrade tests preserve canonical identifiers, mappings, observations and existing tool resources.
- [ ] Demonstration mode is clearly synthetic; live mode does not seed fictional sites or enable unconfigured sources.
- [ ] Every required upstream image/version is pinned, maintained and tested with the release's adapter.
- [ ] Connector compatibility claims match actual tests; unverified hardware/deployment variants are disclosed.
- [ ] Optional ODK and Headwind deployments retain their documented upstream lifecycle.

## Monitoring, reliability and safety

- [ ] Dashboard questions and site/country/date controls execute correctly on desktop and narrow layouts.
- [ ] Missing, stale, invalid, paused and future evidence remains unknown.
- [ ] Uptime is reported with observation coverage; infrastructure checks are not labelled community internet availability.
- [ ] Repeated/out-of-order signals, explicit recovery, notification retries and worker restart recovery behave correctly.
- [ ] Authentication, pagination, rate limits, timeouts, malformed responses and unmapped identifiers are tested.
- [ ] An additional trusted test plugin works through canonical metrics without core query/schema edits.
- [ ] Unauthorized requests are rejected; credentials and personal fields are absent from reporting and logs.
- [ ] Analytics credentials are read-only; operator and machine credentials are distinct.
- [ ] Default bindings are private; remote exposure requires verified TLS.
- [ ] Core/configuration/tool backups restore successfully into fresh isolated volumes.
- [ ] Kuma backup observes its documented consistency-safe maintenance pause.

## Repository and publication

- [ ] CI, dependency checks, Compose validation and Bash syntax checks pass.
- [ ] Public documentation, examples, roadmap and changelog match the release.
- [ ] Version metadata is updated only after verification.
- [ ] Archive, SPDX SBOM and checksum manifest are built; installer archive checksum is sealed.
- [ ] Published tags and assets are immutable; previous releases remain unchanged.
- [ ] Release and Pages workflows succeed.
- [ ] Latest/versioned HTTPS installers match the tagged script byte-for-byte.
- [ ] Downloaded archive matches the embedded checksum; downloaded installer `--help` succeeds.

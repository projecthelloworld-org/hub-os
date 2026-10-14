import { SQL } from "bun";

import { randomId } from "../ids.js";
import { StoreError } from "./errors.js";
import { safeError, sanitizeAttributes } from '../privacy.js';
import * as monitoring from './monitoring-postgres.js';
import { currentSource, currentStatus } from './freshness.js';

function jsonValue(value) {
  return JSON.stringify(value ?? {});
}

function parseJsonValue(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateIncident(row) {
  return { ...row, details: parseJsonValue(row.details) };
}

export class PostgresStore {
  constructor({ databaseUrl }) {
    this.db = new SQL({ url: databaseUrl, max: 10, idleTimeout: 30, connectionTimeout: 15 });
  }

  async ready() {
    await this.db`SELECT 1 AS ready`;
    return true;
  }

  async close() {
    await this.db.close();
  }

  async listOrganisations() {
    return this.db`SELECT id, slug, name, created_at, updated_at FROM organisations ORDER BY slug`;
  }

  async createSite(site) {
    try {
      const [created] = await this.db`
        INSERT INTO sites (organisation_id, site_code, name, country_code, timezone, latitude, longitude, is_demo, site_type)
        VALUES (${site.organisation_id}, ${site.site_code}, ${site.name}, ${site.country_code}, ${site.timezone},
          ${site.latitude}, ${site.longitude}, ${site.is_demo}, ${site.site_type})
        RETURNING id, organisation_id, site_code, name, country_code, timezone, latitude, longitude, is_demo, site_type, created_at, updated_at
      `;
      return created;
    } catch (error) {
      if (error.errno === '23503') throw new StoreError(422, 'Organisation not found');
      if (error.errno === '23505') throw new StoreError(409, 'Site code already exists in this organisation');
      throw error;
    }
  }

  async updateSite(siteId, changes) {
    // Explicit presence flags distinguish omitted fields from coordinate clears,
    // without a read-modify-write that could lose concurrent unrelated changes.
    const [updated] = await this.db`
      UPDATE sites SET
        name = CASE WHEN ${Object.hasOwn(changes, 'name')} THEN ${changes.name ?? null} ELSE name END,
        country_code = CASE WHEN ${Object.hasOwn(changes, 'country_code')} THEN ${changes.country_code ?? null} ELSE country_code END,
        timezone = CASE WHEN ${Object.hasOwn(changes, 'timezone')} THEN ${changes.timezone ?? null} ELSE timezone END,
        latitude = CASE WHEN ${Object.hasOwn(changes, 'latitude')} THEN ${changes.latitude ?? null}::double precision ELSE latitude END,
        longitude = CASE WHEN ${Object.hasOwn(changes, 'longitude')} THEN ${changes.longitude ?? null}::double precision ELSE longitude END,
        site_type = CASE WHEN ${Object.hasOwn(changes, 'site_type')} THEN ${changes.site_type ?? null} ELSE site_type END
      WHERE id = ${siteId}
      RETURNING id, organisation_id, site_code, name, country_code, timezone, latitude, longitude, is_demo, site_type, created_at, updated_at
    `;
    if (!updated) throw new StoreError(404, 'Site not found');
    return updated;
  }

  async listSites(countryCode = null) {
    if (countryCode) {
      return this.db`
        SELECT id, organisation_id, site_code, name, country_code, timezone,
               latitude, longitude, is_demo, site_type, created_at, updated_at
        FROM sites
        WHERE country_code = ${countryCode.toUpperCase()}
        ORDER BY country_code, site_code
      `;
    }
    return this.db`
      SELECT id, organisation_id, site_code, name, country_code, timezone,
             latitude, longitude, is_demo, site_type, created_at, updated_at
      FROM sites
      ORDER BY country_code, site_code
    `;
  }

  async getSiteStatus(siteId) {
    const sites = await this.db`
      SELECT id, organisation_id, site_code, name, country_code, timezone,
             latitude, longitude, is_demo, site_type, created_at, updated_at
      FROM sites WHERE id = ${siteId} LIMIT 1
    `;
    if (sites.length === 0) throw new StoreError(404, "Site not found");
    const statuses = await this.db`
      SELECT ss.domain, ss.status, ss.reason, ss.observed_at, ss.rule_version, ss.source_connection_id,
             coalesce(sc.enabled, false) AS source_active
      FROM status_snapshots ss LEFT JOIN source_connections sc ON sc.id = ss.source_connection_id
        AND sc.organisation_id = ${sites[0].organisation_id}
        AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
        AND EXISTS (SELECT 1 FROM external_identifiers ei WHERE ei.source_connection_id = sc.id
          AND ei.entity_type = 'site' AND ei.entity_id = ss.site_id AND ei.verified)
      WHERE ss.site_id = ${siteId} ORDER BY ss.domain
    `;
    return { site: sites[0], statuses: statuses.map((status) => currentStatus(status)) };
  }

  async listSourceConnections() {
    const rows = await this.db`
      SELECT id, organisation_id, name, connector_type, collection_mode,
             status, base_url, plugin_id, enabled, is_demo, poll_interval_seconds,
             freshness_seconds, last_success_at, created_at, updated_at
      FROM source_connections ORDER BY name
    `;
    return rows.map((source) => currentSource(source));
  }

  async createSource(source) {
    try {
      const [created] = await this.db`INSERT INTO source_connections (organisation_id, name, connector_type, plugin_id, collection_mode,
        base_url, config, enabled, status, is_demo, poll_interval_seconds, freshness_seconds)
        VALUES (${source.organisation_id}, ${source.name}, ${source.plugin_id}, ${source.plugin_id}, ${source.collection_mode},
          ${source.base_url}, ${JSON.stringify(source.config)}::text::jsonb, false, 'disabled', ${source.is_demo},
          ${source.poll_interval_seconds}, ${source.freshness_seconds})
        RETURNING id, organisation_id, name, connector_type, plugin_id, collection_mode, base_url,
          enabled, status, is_demo, poll_interval_seconds, freshness_seconds, last_success_at, created_at, updated_at`;
      return created;
    } catch (error) {
      if (error.errno === '23503') throw new StoreError(422, 'Organisation not found');
      if (error.errno === '23505') throw new StoreError(409, 'Source name already exists in this organisation');
      throw error;
    }
  }

  async editSource(sourceId, validate) {
    try {
      return await this.db.begin(async (tx) => {
        const [prior] = await tx`SELECT * FROM source_connections WHERE id = ${sourceId} FOR UPDATE`;
        if (!prior) throw new StoreError(404, 'Source not found');
        if (prior.enabled) throw new StoreError(409, 'Disable the source before changing settings');
        const source = await validate({ ...prior, config: parseJsonValue(prior.config) });
        const [updated] = await tx`UPDATE source_connections SET name = ${source.name}, base_url = ${source.base_url},
          config = ${JSON.stringify(source.config)}::text::jsonb, poll_interval_seconds = ${source.poll_interval_seconds},
          freshness_seconds = ${source.freshness_seconds}, last_success_at = NULL WHERE id = ${sourceId}
          RETURNING id, organisation_id, name, connector_type, plugin_id, collection_mode, base_url, enabled, status, is_demo,
            poll_interval_seconds, freshness_seconds, last_success_at, created_at, updated_at`;
        return updated;
      });
    } catch (error) {
      if (error.errno === '23505') throw new StoreError(409, 'Source name already exists in this organisation');
      throw error;
    }
  }

  async listMappings(sourceId) {
    if (!(await this.db`SELECT id FROM source_connections WHERE id = ${sourceId}`).length) throw new StoreError(404, 'Source not found');
    return this.db`SELECT id, source_connection_id, entity_type, entity_id, external_id, verified, mapping_method, created_at
      FROM external_identifiers WHERE source_connection_id = ${sourceId} AND entity_type = 'site' ORDER BY external_id`;
  }

  async getSourceAdminContext(sourceId) {
    const [source] = await this.db`SELECT * FROM source_connections WHERE id = ${sourceId}`;
    if (!source) throw new StoreError(404, 'Source not found');
    const mappings = await this.db`SELECT ei.external_id, s.id AS site_id, s.site_code, s.is_demo
      FROM external_identifiers ei JOIN sites s ON s.id = ei.entity_id AND s.organisation_id = ${source.organisation_id}
      WHERE ei.source_connection_id = ${sourceId} AND ei.entity_type = 'site' AND ei.verified ORDER BY ei.external_id`;
    const monitors = await this.db`SELECT * FROM monitors WHERE source_connection_id = ${sourceId} ORDER BY external_id`;
    return { source: { ...source, config: parseJsonValue(source.config) }, mappings, monitors };
  }

  async enableSource(sourceId, expected) {
    return this.db.begin(async (tx) => {
      const [source] = await tx`SELECT * FROM source_connections WHERE id = ${sourceId} FOR UPDATE`;
      if (!source) throw new StoreError(404, 'Source not found');
      if (!source.enabled) {
        const [settings] = await tx`SELECT config = ${JSON.stringify(expected.config)}::text::jsonb
          AND base_url IS NOT DISTINCT FROM ${expected.base_url} AND poll_interval_seconds = ${expected.poll_interval_seconds}
          AND freshness_seconds = ${expected.freshness_seconds} AS unchanged FROM source_connections WHERE id = ${sourceId}`;
        if (!settings.unchanged) throw new StoreError(409, 'Source settings changed during the connection test; test again');
        if (source.collection_mode !== 'webhook' && !(await tx`SELECT ei.id FROM external_identifiers ei JOIN sites s
          ON s.id = ei.entity_id AND s.organisation_id = ${source.organisation_id}
          WHERE ei.source_connection_id = ${sourceId} AND ei.entity_type = 'site' AND ei.verified LIMIT 1`).length) {
          throw new StoreError(422, 'Verify at least one community-site mapping before enabling collection');
        }
        await tx`UPDATE source_connections SET enabled = true, status = 'unknown', last_success_at = NULL WHERE id = ${sourceId}`;
        if (source.collection_mode !== 'webhook') await tx`INSERT INTO connector_jobs (connector_id, source_connection_id, job_type,
          schedule_interval_seconds, status) VALUES (${source.plugin_id}, ${sourceId}, 'collect', ${source.poll_interval_seconds}, 'pending')
          ON CONFLICT (source_connection_id, job_type) WHERE source_connection_id IS NOT NULL DO UPDATE SET
            connector_id = EXCLUDED.connector_id, schedule_interval_seconds = EXCLUDED.schedule_interval_seconds, status = 'pending',
            next_run_at = now(), attempts = 0, locked_at = NULL, locked_by = NULL, lease_token = NULL, last_error = NULL`;
      }
      const [publicSource] = await tx`SELECT id, organisation_id, name, connector_type, plugin_id, collection_mode, base_url,
        enabled, status, is_demo, poll_interval_seconds, freshness_seconds, last_success_at, created_at, updated_at
        FROM source_connections WHERE id = ${sourceId}`;
      return currentSource(publicSource);
    });
  }

  async disableSource(sourceId) {
    return this.db.begin(async (tx) => {
      const [source] = await tx`UPDATE source_connections SET enabled = false, status = 'disabled', last_success_at = NULL
        WHERE id = ${sourceId} RETURNING id, organisation_id, name, connector_type, plugin_id, collection_mode, base_url,
          enabled, status, is_demo, poll_interval_seconds, freshness_seconds, last_success_at, created_at, updated_at`;
      if (!source) throw new StoreError(404, 'Source not found');
      await tx`UPDATE connector_runs SET status = 'failed', finished_at = now(), error = 'SOURCE_DISABLED'
        WHERE status = 'running' AND connector_job_id IN (SELECT id FROM connector_jobs WHERE source_connection_id = ${sourceId})`;
      await tx`UPDATE connector_jobs SET status = 'dead', locked_at = NULL, locked_by = NULL, lease_token = NULL
        WHERE source_connection_id = ${sourceId}`;
      return source;
    });
  }

  async createMapping(sourceId, metadata) {
    try {
      return await this.db.begin(async (tx) => {
        const [source] = await tx`SELECT organisation_id, enabled, config FROM source_connections WHERE id = ${sourceId} FOR UPDATE`;
        if (!source) throw new StoreError(404, 'Source not found');
        if (source.enabled) throw new StoreError(409, 'Disable the source before changing mappings');
        if (parseJsonValue(source.config).mapping_policy === 'canonical_site_ids') throw new StoreError(409, 'Tool-owned mappings follow canonical provisioning');
        const [site] = await tx`SELECT id FROM sites WHERE id = ${metadata.site_id} AND organisation_id = ${source.organisation_id}`;
        if (!site) throw new StoreError(422, 'Site is not in the source organisation');
        const [mapping] = await tx`INSERT INTO external_identifiers (source_connection_id, entity_type, entity_id, external_id, verified, mapping_method)
          VALUES (${sourceId}, 'site', ${site.id}, ${metadata.external_id}, ${metadata.verified},
            ${metadata.verified ? 'operator_verified' : 'operator_pending'}) RETURNING *`;
        await tx`UPDATE source_connections SET last_success_at = NULL WHERE id = ${sourceId}`;
        return mapping;
      });
    } catch (error) {
      if (error.errno === '23505') throw new StoreError(409, 'External identifier already has a mapping in this source');
      throw error;
    }
  }

  async editMapping(sourceId, mappingId, changes) {
    return this.db.begin(async (tx) => {
      const [source] = await tx`SELECT organisation_id, enabled, config FROM source_connections WHERE id = ${sourceId} FOR UPDATE`;
      const [mapping] = await tx`SELECT * FROM external_identifiers WHERE id = ${mappingId}
        AND source_connection_id = ${sourceId} AND entity_type = 'site' FOR UPDATE`;
      if (!source || !mapping) throw new StoreError(404, 'Mapping not found in this source');
      if (source.enabled) throw new StoreError(409, 'Disable the source before changing mappings');
      if (parseJsonValue(source.config).mapping_policy === 'canonical_site_ids') throw new StoreError(409, 'Tool-owned mappings follow canonical provisioning');
      const siteId = changes.site_id ?? String(mapping.entity_id);
      if (!(await tx`SELECT id FROM sites WHERE id = ${siteId} AND organisation_id = ${source.organisation_id}`).length) {
        throw new StoreError(422, 'Site is not in the source organisation');
      }
      const verified = changes.verified ?? (siteId !== String(mapping.entity_id) ? false : mapping.verified);
      const [updated] = await tx`UPDATE external_identifiers SET entity_id = ${siteId}, verified = ${verified},
        mapping_method = ${verified ? 'operator_verified' : 'operator_pending'} WHERE id = ${mappingId} RETURNING *`;
      await tx`UPDATE source_connections SET last_success_at = NULL WHERE id = ${sourceId}`;
      return updated;
    });
  }

  async listIncidents({ status = null, countryCode = null } = {}) {
    if (status && countryCode) {
      const rows = await this.db`
        SELECT i.* FROM incidents i JOIN sites s ON s.id = i.site_id
        WHERE i.status = ${status} AND s.country_code = ${countryCode.toUpperCase()}
        ORDER BY i.started_at DESC
      `;
      return rows.map(hydrateIncident);
    }
    if (status) {
      const rows = await this.db`SELECT * FROM incidents WHERE status = ${status} ORDER BY started_at DESC`;
      return rows.map(hydrateIncident);
    }
    if (countryCode) {
      const rows = await this.db`
        SELECT i.* FROM incidents i JOIN sites s ON s.id = i.site_id
        WHERE s.country_code = ${countryCode.toUpperCase()}
        ORDER BY i.started_at DESC
      `;
      return rows.map(hydrateIncident);
    }
    const rows = await this.db`SELECT * FROM incidents ORDER BY started_at DESC`;
    return rows.map(hydrateIncident);
  }

  async getDashboardData() {
    const sites = await this.listSites();
    const statuses = await this.db`
      SELECT ss.site_id, ss.domain, ss.status, ss.reason, ss.observed_at, ss.rule_version, ss.source_connection_id,
             coalesce(sc.enabled, false) AS source_active
      FROM status_snapshots ss JOIN sites s ON s.id = ss.site_id
      LEFT JOIN source_connections sc ON sc.id = ss.source_connection_id AND sc.organisation_id = s.organisation_id
        AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
        AND EXISTS (SELECT 1 FROM external_identifiers ei WHERE ei.source_connection_id = sc.id
          AND ei.entity_type = 'site' AND ei.entity_id = ss.site_id AND ei.verified)
      ORDER BY ss.site_id, ss.domain
    `;
    const incidents = await this.db`
      SELECT i.*, s.name AS site_name, s.country_code
      FROM incidents i LEFT JOIN sites s ON s.id = i.site_id
      WHERE i.status NOT IN ('resolved', 'closed')
      ORDER BY i.started_at DESC
    `;
    const statusesBySite = Map.groupBy(statuses.map((status) => currentStatus(status)), (status) => String(status.site_id));
    return {
      sites: sites.map((site) => ({ ...site, statuses: statusesBySite.get(String(site.id)) ?? [] })),
      incidents: incidents.map(hydrateIncident),
    };
  }

  async acknowledgeIncident(incidentId, owner) {
    const rows = await this.db`
      UPDATE incidents
      SET owner = ${owner}, acknowledged_at = COALESCE(acknowledged_at, now()),
          status = 'acknowledged', updated_at = now()
      WHERE id = ${incidentId} AND status NOT IN ('resolved', 'closed')
      RETURNING *
    `;
    if (rows.length) return hydrateIncident(rows[0]);
    const existing = await this.db`SELECT status FROM incidents WHERE id = ${incidentId}`;
    if (!existing.length) throw new StoreError(404, "Incident not found");
    throw new StoreError(409, "Resolved incidents cannot be acknowledged");
  }

  async resolveIncident(incidentId, resolution) {
    const rows = await this.db`
      UPDATE incidents
      SET resolution = ${resolution}, resolved_at = now(), status = 'resolved', updated_at = now()
      WHERE id = ${incidentId} AND status NOT IN ('resolved', 'closed')
      RETURNING *
    `;
    if (rows.length) return hydrateIncident(rows[0]);
    const existing = await this.db`SELECT status FROM incidents WHERE id = ${incidentId}`;
    if (!existing.length) throw new StoreError(404, "Incident not found");
    throw new StoreError(409, "Incident is already resolved");
  }

  async ingestObservations(observations) {
    return this.db.begin(async (tx) => {
      const result = { accepted: 0, duplicates: 0, rejected: 0, errors: [] };
      for (const [index, item] of observations.entries()) {
        const sites = item.site_id
          ? await tx`SELECT id, organisation_id FROM sites WHERE id = ${item.site_id} LIMIT 1`
          : await tx`SELECT id, organisation_id FROM sites WHERE site_code = ${item.site_code} ORDER BY id LIMIT 2`;
        if (sites.length === 0) {
          result.rejected += 1;
          result.errors.push(`observations[${index}]: Unknown ${item.site_id ? "site_id" : "site_code"}`);
          continue;
        }
        if (sites.length > 1) {
          result.rejected += 1;
          result.errors.push(`observations[${index}]: site_code is ambiguous; use site_id`);
          continue;
        }
        const siteId = sites[0].id;
        const sources = await tx`SELECT id, organisation_id FROM source_connections
          WHERE id = ${item.source_connection_id} AND enabled AND status <> 'disabled' FOR SHARE`;
        if (sources.length === 0 || String(sources[0].organisation_id) !== String(sites[0].organisation_id)) {
          result.rejected += 1;
          result.errors.push(`observations[${index}]: Unknown or disabled source_connection_id`);
          continue;
        }
        const mappings = await tx`
          SELECT id FROM external_identifiers
          WHERE source_connection_id = ${item.source_connection_id}
            AND entity_type = 'site' AND entity_id = ${siteId} AND verified = true
            AND (${item.external_entity_id ?? null}::text IS NULL OR external_id = ${item.external_entity_id ?? null})
          LIMIT 1
        `;
        if (mappings.length === 0) {
          result.rejected += 1;
          result.errors.push(`observations[${index}]: Source is not verified for this site`);
          continue;
        }
        const inserted = await tx`
          INSERT INTO observations (
            site_id, source_connection_id, external_record_id, metric, value,
            unit, quality, observed_at, attributes
          ) VALUES (
            ${siteId}, ${item.source_connection_id}, ${item.external_record_id}, ${item.metric},
            ${item.value}, ${item.unit}, ${item.quality}, ${item.observed_at}, ${jsonValue(sanitizeAttributes(item.attributes))}::text::jsonb
          )
          ON CONFLICT (source_connection_id, external_record_id, metric) DO NOTHING
          RETURNING id
        `;
        if (inserted.length) result.accepted += 1;
        else result.duplicates += 1;
      }
      return result;
    });
  }

  async listConnectorTargets(job) {
    const sources = await this.db`
      SELECT id, organisation_id, name, plugin_id, base_url, config, is_demo, poll_interval_seconds
      FROM source_connections WHERE enabled AND status <> 'disabled' AND plugin_id = ${job.connector_id}
      AND (${job.source_connection_id ?? null}::uuid IS NULL OR id = ${job.source_connection_id ?? null}::uuid)
      ORDER BY id
    `;
    const targets = [];
    for (const source of sources) {
      if (parseJsonValue(source.config).mapping_policy === 'canonical_site_ids') {
        await this.db`INSERT INTO external_identifiers (source_connection_id, entity_type, entity_id, external_id, verified, mapping_method)
          SELECT ${source.id}, 'site', id, id::text, true, 'owned_canonical_policy' FROM sites WHERE organisation_id = ${source.organisation_id}
          ON CONFLICT (source_connection_id, entity_type, external_id) DO NOTHING`;
      }
      const mappings = await this.db`
        SELECT ei.external_id, s.id AS site_id, s.site_code, s.is_demo
        FROM external_identifiers ei JOIN sites s ON s.id = ei.entity_id
        WHERE ei.source_connection_id = ${source.id} AND ei.entity_type = 'site' AND ei.verified
          AND s.organisation_id = ${source.organisation_id}
        ORDER BY ei.external_id
      `;
      targets.push({ source: { ...source, config: parseJsonValue(source.config) }, mappings });
      targets.at(-1).monitors = await this.db`SELECT * FROM monitors WHERE source_connection_id = ${source.id} ORDER BY external_id`;
    }
    return targets;
  }

  async getSourceContext(sourceId) {
    const [source] = await this.db`SELECT id, organisation_id, name, plugin_id, base_url, config, is_demo, enabled, poll_interval_seconds
      FROM source_connections WHERE id = ${sourceId}`;
    if (!source || !source.enabled) throw new StoreError(404, 'Enabled source not found');
    const [target] = await this.listConnectorTargets({ connector_id: source.plugin_id, source_connection_id: sourceId });
    if (!target) throw new StoreError(404, 'Enabled source not found');
    return target;
  }

  async registerMonitor(monitor) { return monitoring.registerMonitor(this.db, monitor); }
  async ingestMonitorSamples(sourceId, samples) { return monitoring.ingestMonitorSamples(this.db, sourceId, samples); }
  async applySignal(sourceId, signal) { return monitoring.applySignal(this.db, sourceId, signal); }
  async claimNotification(leaseSeconds) { return monitoring.claimNotification(this.db, leaseSeconds); }
  async finishNotification(job, error) { return monitoring.finishNotification(this.db, job, error); }

  async markSourceCollected(sourceId, observedAt) {
    await this.db`
      UPDATE source_connections SET last_success_at = ${observedAt}, status = 'healthy'
      WHERE id = ${sourceId} AND enabled AND (last_success_at IS NULL OR last_success_at <= ${observedAt})
    `;
  }

  async upsertStatuses(statuses) {
    await this.db.begin(async (tx) => {
      for (const status of statuses) {
        if (status.source_connection_id) {
          const [source] = await tx`SELECT enabled FROM source_connections WHERE id = ${status.source_connection_id} FOR SHARE`;
          if (!source?.enabled) continue;
        }
        await tx`
          INSERT INTO status_snapshots (
            id, site_id, domain, status, reason, observed_at, rule_version, source_connection_id
          ) VALUES (
            ${randomId()}, ${status.site_id}, ${status.domain}, ${status.status},
            ${status.reason}, ${status.observed_at}, ${status.rule_version}, ${status.source_connection_id ?? null}
          )
          ON CONFLICT (site_id, domain) DO UPDATE SET
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            observed_at = EXCLUDED.observed_at,
            rule_version = EXCLUDED.rule_version,
            source_connection_id = EXCLUDED.source_connection_id,
            updated_at = now()
          WHERE EXCLUDED.observed_at >= status_snapshots.observed_at
        `;
      }
    });
  }

  async recordRawPayload({ sourceConnectionId, connectorRunId, externalRecordId, observedAt, payload }) {
    await this.db`
      INSERT INTO raw_payloads (
        source_connection_id, connector_run_id, external_record_id, observed_at, payload
      ) VALUES (
        ${sourceConnectionId}, ${connectorRunId}, ${externalRecordId}, ${observedAt}, ${jsonValue(payload)}::text::jsonb
      ) ON CONFLICT (source_connection_id, external_record_id) DO NOTHING
    `;
  }

  async claimConnectorJob(workerId, leaseSeconds) {
    const rows = await this.db`
      WITH candidate AS (
        SELECT id FROM connector_jobs
        WHERE (status IN ('pending', 'failed') OR
               (status = 'running' AND locked_at < now() - make_interval(secs => ${leaseSeconds})))
          AND attempts < max_attempts
          AND next_run_at <= now()
          AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => ${leaseSeconds}))
        ORDER BY next_run_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), abandoned AS (
        UPDATE connector_runs r SET status = 'failed', finished_at = now(), error = 'WORKER_LEASE_EXPIRED'
        FROM candidate WHERE r.connector_job_id = candidate.id AND r.status = 'running'
        RETURNING r.id
      )
      UPDATE connector_jobs j
      SET status = 'running', locked_at = now(), locked_by = ${workerId},
          lease_token = gen_random_uuid(), updated_at = now()
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING j.*
    `;
    return rows[0] ? { ...rows[0], payload: parseJsonValue(rows[0].payload) } : null;
  }

  async startConnectorRun(job, workerId) {
    const rows = await this.db`
      INSERT INTO connector_runs (connector_job_id, connector_id, worker_id, status, started_at)
      VALUES (${job.id}, ${job.connector_id}, ${workerId}, 'running', now())
      RETURNING id
    `;
    return rows[0].id;
  }

  async finishConnectorRun(runId, summary) {
    await this.db`
      UPDATE connector_runs SET status = 'succeeded', finished_at = now(), summary = ${jsonValue(summary)}::text::jsonb
      WHERE id = ${runId} AND status = 'running'
    `;
  }

  async failConnectorRun(runId, error) {
    await this.db`
      UPDATE connector_runs SET status = 'failed', finished_at = now(), error = ${safeError(error)}
      WHERE id = ${runId} AND status = 'running'
    `;
  }

  async completeConnectorJob(job) {
    await this.db`
      UPDATE connector_jobs
      SET status = CASE WHEN schedule_interval_seconds IS NULL THEN 'completed' ELSE 'pending' END,
          next_run_at = CASE
            WHEN schedule_interval_seconds IS NULL THEN next_run_at
            ELSE now() + make_interval(secs => schedule_interval_seconds)
          END,
          attempts = 0, locked_at = NULL, locked_by = NULL, lease_token = NULL, last_error = NULL, updated_at = now()
      WHERE id = ${job.id} AND lease_token = ${job.lease_token}::uuid
    `;
  }

  async failConnectorJob(job, error) {
    await this.db`
      UPDATE connector_jobs
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'failed' END,
          next_run_at = now() + make_interval(secs => ${Math.min(86400, Math.max(30, Number(error?.retryAfterSeconds) || 30))}),
          locked_at = NULL, locked_by = NULL, lease_token = NULL, last_error = ${safeError(error)}, updated_at = now()
      WHERE id = ${job.id} AND lease_token = ${job.lease_token}::uuid
    `;
  }

  async renewConnectorLease(job) {
    const rows = await this.db`
      UPDATE connector_jobs SET locked_at = now()
      WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.lease_token}::uuid
      RETURNING id
    `;
    return rows.length === 1;
  }

  async seedDemo(state) {
    await this.db.begin(async (tx) => {
      const organisation = state.organisation;
      await tx`
        INSERT INTO organisations (id, slug, name)
        VALUES (${organisation.id}, ${organisation.slug}, ${organisation.name})
        ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, updated_at = now()
      `;
      for (const source of state.sourceConnections) {
        await tx`
          INSERT INTO source_connections (
            id, organisation_id, name, connector_type, plugin_id, collection_mode, status,
            enabled, is_demo, config, poll_interval_seconds, freshness_seconds, last_success_at
          ) VALUES (
            ${source.id}, ${source.organisation_id}, ${source.name}, ${source.connector_type},
            ${source.plugin_id ?? source.connector_type}, ${source.collection_mode}, ${source.status},
            ${source.enabled ?? false}, ${source.is_demo ?? false}, ${jsonValue(source.config)}::text::jsonb,
            ${source.poll_interval_seconds ?? 60}, ${source.freshness_seconds ?? 300}, ${source.last_success_at}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, connector_type = EXCLUDED.connector_type,
            collection_mode = EXCLUDED.collection_mode, status = EXCLUDED.status,
            plugin_id = EXCLUDED.plugin_id, enabled = EXCLUDED.enabled, is_demo = EXCLUDED.is_demo,
            config = EXCLUDED.config, poll_interval_seconds = EXCLUDED.poll_interval_seconds,
            freshness_seconds = EXCLUDED.freshness_seconds,
            last_success_at = EXCLUDED.last_success_at, updated_at = now()
        `;
      }
      for (const site of state.sites) {
        await tx`
          INSERT INTO sites (
            id, organisation_id, site_code, name, country_code, timezone,
            latitude, longitude, is_demo, site_type
          ) VALUES (
            ${site.id}, ${site.organisation_id}, ${site.site_code}, ${site.name},
            ${site.country_code}, ${site.timezone}, ${site.latitude}, ${site.longitude}, ${site.is_demo}, ${site.site_type ?? 'other'}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, country_code = EXCLUDED.country_code,
            timezone = EXCLUDED.timezone, latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude, is_demo = EXCLUDED.is_demo, site_type = EXCLUDED.site_type, updated_at = now()
        `;
      }
      for (const mapping of state.mappings) {
        await tx`
          INSERT INTO external_identifiers (
            id, source_connection_id, entity_type, entity_id, external_id,
            mapping_method, verified
          ) VALUES (
            ${mapping.id}, ${mapping.source_connection_id}, ${mapping.entity_type},
            ${mapping.entity_id}, ${mapping.external_id}, ${mapping.mapping_method}, ${mapping.verified}
          ) ON CONFLICT (id) DO NOTHING
        `;
      }
      for (const observation of state.observations) {
        await tx`
          INSERT INTO observations (
            site_id, source_connection_id, external_record_id, metric, value,
            unit, quality, observed_at, attributes
          ) VALUES (
            ${observation.site_id}, ${observation.source_connection_id},
            ${observation.external_record_id}, ${observation.metric}, ${observation.value},
            ${observation.unit}, ${observation.quality}, ${observation.observed_at},
            ${jsonValue(observation.attributes)}::text::jsonb
          ) ON CONFLICT (source_connection_id, external_record_id, metric) DO NOTHING
        `;
      }
      for (const status of state.statuses) {
        await tx`
          INSERT INTO status_snapshots (
            id, site_id, domain, status, reason, observed_at, rule_version, source_connection_id
          ) VALUES (
            ${status.id}, ${status.site_id}, ${status.domain}, ${status.status},
            ${status.reason}, ${status.observed_at}, ${status.rule_version}, ${status.source_connection_id ?? null}
          )
          ON CONFLICT (site_id, domain) DO UPDATE SET
            status = EXCLUDED.status, reason = EXCLUDED.reason,
            observed_at = EXCLUDED.observed_at, rule_version = EXCLUDED.rule_version,
            source_connection_id = EXCLUDED.source_connection_id,
            updated_at = now()
        `;
      }
      for (const incident of state.incidents) {
        await tx`
          INSERT INTO incidents (
            id, site_id, title, severity, status, owner, started_at, details
          ) VALUES (
            ${incident.id}, ${incident.site_id}, ${incident.title}, ${incident.severity},
            ${incident.status}, ${incident.owner}, ${incident.started_at}, ${jsonValue(incident.details)}::text::jsonb
          ) ON CONFLICT (id) DO NOTHING
        `;
      }
      for (const job of state.connectorJobs) {
        await tx`
          INSERT INTO connector_jobs (
            id, connector_id, job_type, payload, status, next_run_at,
            schedule_interval_seconds, max_attempts
          ) VALUES (
            ${job.id}, ${job.connector_id}, ${job.job_type}, ${jsonValue(job.payload)}::text::jsonb,
            ${job.status}, ${job.next_run_at}, ${job.schedule_interval_seconds}, ${job.max_attempts}
          ) ON CONFLICT (id) DO NOTHING
        `;
      }
    });
  }
}

import { randomId } from "../ids.js";
import { StoreError } from "./errors.js";
import { safeError, sanitizeAttributes } from '../privacy.js';

function clone(value) {
  return structuredClone(value);
}

export class MemoryStore {
  constructor(state) {
    this.state = clone(state);
  }

  async ready() {
    return true;
  }

  async close() {}

  async listSites(countryCode = null) {
    return clone(
      this.state.sites
        .filter((site) => !countryCode || site.country_code === countryCode.toUpperCase())
        .sort((a, b) => `${a.country_code}:${a.site_code}`.localeCompare(`${b.country_code}:${b.site_code}`)),
    );
  }

  async getSiteStatus(siteId) {
    const site = this.state.sites.find((item) => item.id === siteId);
    if (!site) throw new StoreError(404, "Site not found");
    const statuses = this.state.statuses
      .filter((item) => item.site_id === siteId)
      .sort((a, b) => a.domain.localeCompare(b.domain));
    return clone({ site, statuses });
  }

  async listSourceConnections() {
    return clone([...this.state.sourceConnections].sort((a, b) => a.name.localeCompare(b.name))
      .map(({ config, key, ...source }) => source));
  }

  async listIncidents({ status = null, countryCode = null } = {}) {
    const siteById = new Map(this.state.sites.map((site) => [site.id, site]));
    return clone(
      this.state.incidents
        .filter((incident) => !status || incident.status === status)
        .filter((incident) => !countryCode || siteById.get(incident.site_id)?.country_code === countryCode.toUpperCase())
        .sort((a, b) => b.started_at.localeCompare(a.started_at)),
    );
  }

  async getDashboardData() {
    const sites = await this.listSites();
    const siteRows = sites.map((site) => ({
      ...site,
      statuses: this.state.statuses
        .filter((status) => status.site_id === site.id)
        .sort((a, b) => a.domain.localeCompare(b.domain)),
    }));
    const incidents = await this.listIncidents();
    const siteById = new Map(sites.map((site) => [site.id, site]));
    return {
      sites: siteRows,
      incidents: incidents
        .filter((incident) => !["resolved", "closed"].includes(incident.status))
        .map((incident) => ({
          ...incident,
          site_name: siteById.get(incident.site_id)?.name,
          country_code: siteById.get(incident.site_id)?.country_code,
        })),
    };
  }

  async acknowledgeIncident(incidentId, owner) {
    const incident = this.state.incidents.find((item) => item.id === incidentId);
    if (!incident) throw new StoreError(404, "Incident not found");
    if (["resolved", "closed"].includes(incident.status)) {
      throw new StoreError(409, "Resolved incidents cannot be acknowledged");
    }
    incident.owner = owner;
    incident.acknowledged_at ??= new Date().toISOString();
    incident.status = "acknowledged";
    return clone(incident);
  }

  async resolveIncident(incidentId, resolution) {
    const incident = this.state.incidents.find((item) => item.id === incidentId);
    if (!incident) throw new StoreError(404, "Incident not found");
    if (["resolved", "closed"].includes(incident.status)) {
      throw new StoreError(409, "Incident is already resolved");
    }
    incident.resolution = resolution;
    incident.resolved_at = new Date().toISOString();
    incident.status = "resolved";
    return clone(incident);
  }

  async ingestObservations(observations) {
    const result = { accepted: 0, duplicates: 0, rejected: 0, errors: [] };
    for (const [index, observation] of observations.entries()) {
      const candidates = this.state.sites.filter((site) =>
        observation.site_id ? site.id === observation.site_id : site.site_code === observation.site_code,
      );
      if (candidates.length === 0) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: Unknown ${observation.site_id ? "site_id" : "site_code"}`);
        continue;
      }
      if (candidates.length > 1) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: site_code is ambiguous; use site_id`);
        continue;
      }
      const site = candidates[0];
      const source = this.state.sourceConnections.find((item) => item.id === observation.source_connection_id);
      if (!source || source.organisation_id !== site.organisation_id) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: Unknown source_connection_id`);
        continue;
      }
      const verified = this.state.mappings.some(
        (mapping) =>
          mapping.source_connection_id === source.id &&
          mapping.entity_type === "site" &&
          mapping.entity_id === site.id &&
          (!observation.external_entity_id || mapping.external_id === observation.external_entity_id) &&
          mapping.verified,
      );
      if (!verified) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: Source is not verified for this site`);
        continue;
      }
      const duplicate = this.state.observations.some(
        (item) =>
          item.source_connection_id === source.id &&
          item.external_record_id === observation.external_record_id &&
          item.metric === observation.metric,
      );
      if (duplicate) {
        result.duplicates += 1;
        continue;
      }
      this.state.observations.push({ ...clone(observation), id: this.state.observations.length + 1, site_id: site.id });
      this.state.observations.at(-1).attributes = sanitizeAttributes(observation.attributes);
      result.accepted += 1;
    }
    return result;
  }

  async listConnectorTargets(job) {
    return clone(this.state.sourceConnections
      .filter((source) => source.enabled && source.status !== 'disabled' && source.plugin_id === job.connector_id
        && (!job.source_connection_id || source.id === job.source_connection_id))
      .map((source) => ({ source, mappings: this.state.mappings
        .filter((mapping) => mapping.source_connection_id === source.id && mapping.entity_type === 'site' && mapping.verified)
        .flatMap((mapping) => {
          const site = this.state.sites.find((site) => site.id === mapping.entity_id && site.organisation_id === source.organisation_id);
          return site ? [{ external_id: mapping.external_id, site_id: site.id, site_code: site.site_code, is_demo: site.is_demo }] : [];
        }) })));
  }

  async markSourceCollected(sourceId, observedAt) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (source && (!source.last_success_at || Date.parse(source.last_success_at) <= Date.parse(observedAt))) {
      source.last_success_at = new Date(observedAt).toISOString();
      source.status = 'healthy';
    }
  }

  async upsertStatuses(statuses) {
    for (const status of statuses) {
      const existing = this.state.statuses.find(
        (item) => item.site_id === status.site_id && item.domain === status.domain,
      );
      if (existing) {
        if (Date.parse(existing.observed_at) <= Date.parse(status.observed_at)) Object.assign(existing, clone(status));
      } else this.state.statuses.push({ id: randomId(), ...clone(status) });
    }
  }

  async claimConnectorJob(workerId, leaseSeconds) {
    const now = Date.now();
    const job = (this.state.connectorJobs ?? []).find((job) => job.attempts < job.max_attempts
      && Date.parse(job.next_run_at) <= now
      && (['pending', 'failed'].includes(job.status)
          || (job.status === 'running' && Date.parse(job.locked_at) < now - leaseSeconds * 1000)));
    if (!job) return null;
    for (const run of this.state.connectorRuns ?? []) {
      if (run.connector_job_id === job.id && run.status === 'running') {
        Object.assign(run, { status: 'failed', error: 'WORKER_LEASE_EXPIRED' });
      }
    }
    Object.assign(job, { status: 'running', locked_at: new Date(now).toISOString(), locked_by: workerId, lease_token: randomId() });
    return clone(job);
  }

  async renewConnectorLease(job) {
    const current = this.state.connectorJobs?.find((item) => item.id === job.id && item.lease_token === job.lease_token && item.status === 'running');
    if (current) current.locked_at = new Date().toISOString();
    return Boolean(current);
  }

  async startConnectorRun(job, workerId) {
    this.state.connectorRuns ??= [];
    const run = { id: this.state.connectorRuns.length + 1, connector_job_id: job.id, worker_id: workerId, status: 'running' };
    this.state.connectorRuns.push(run);
    return run.id;
  }

  async finishConnectorRun(id, summary) {
    const run = this.state.connectorRuns.find((run) => run.id === id && run.status === 'running');
    if (run) Object.assign(run, { status: 'succeeded', summary: clone(summary) });
  }

  async failConnectorRun(id, error) {
    const run = this.state.connectorRuns.find((run) => run.id === id && run.status === 'running');
    if (run) Object.assign(run, { status: 'failed', error: safeError(error) });
  }

  async completeConnectorJob(job) {
    const current = this.state.connectorJobs.find((item) => item.id === job.id && item.lease_token === job.lease_token);
    if (!current) return;
    Object.assign(current, { status: current.schedule_interval_seconds ? 'pending' : 'completed',
      next_run_at: new Date(Date.now() + (current.schedule_interval_seconds ?? 0) * 1000).toISOString(),
      attempts: 0, locked_at: null, locked_by: null, lease_token: null, last_error: null });
  }

  async failConnectorJob(job, error) {
    const current = this.state.connectorJobs.find((item) => item.id === job.id && item.lease_token === job.lease_token);
    if (!current) return;
    current.attempts += 1;
    Object.assign(current, { status: current.attempts >= current.max_attempts ? 'dead' : 'failed',
      next_run_at: new Date(Date.now() + Math.min(86400, Math.max(30, Number(error?.retryAfterSeconds) || 30)) * 1000).toISOString(),
      locked_at: null, locked_by: null, lease_token: null, last_error: safeError(error) });
  }

  async recordRawPayload(item) {
    this.state.rawPayloads ??= [];
    if (!this.state.rawPayloads.some((entry) => entry.sourceConnectionId === item.sourceConnectionId && entry.externalRecordId === item.externalRecordId)) {
      this.state.rawPayloads.push(clone(item));
    }
  }
}

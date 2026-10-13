import { randomId } from "../ids.js";
import { StoreError } from "./errors.js";
import { safeError, sanitizeAttributes } from '../privacy.js';
import { rules, validateSignal, decideSignalTransition } from '../alerts/signals.js';
import { currentSource, currentStatus, isCurrentEvidence } from './freshness.js';

function clone(value) {
  return structuredClone(value);
}

export class MemoryStore {
  constructor(state) {
    this.state = clone(state);
    this.state.monitors ??= [];
    this.state.monitorSamples ??= [];
    this.state.signalStates ??= [];
    this.state.notifications ??= [];
  }

  async ready() {
    return true;
  }

  async close() {}

  async listOrganisations() {
    return clone((this.state.organisations ?? [this.state.organisation]).filter(Boolean)
      .map(({ id, slug, name, created_at, updated_at }) => ({ id, slug, name, created_at, updated_at }))
      .sort((a, b) => a.slug.localeCompare(b.slug)));
  }

  async createSite(metadata) {
    const organisations = this.state.organisations ?? [this.state.organisation];
    if (!organisations.some((organisation) => organisation?.id === metadata.organisation_id)) {
      throw new StoreError(422, 'Organisation not found');
    }
    if (this.state.sites.some((site) => site.organisation_id === metadata.organisation_id && site.site_code === metadata.site_code)) {
      throw new StoreError(409, 'Site code already exists in this organisation');
    }
    const now = new Date().toISOString();
    const site = { ...clone(metadata), id: randomId(), created_at: now, updated_at: now };
    this.state.sites.push(site);
    return clone(site);
  }

  async updateSite(siteId, changes) {
    const site = this.state.sites.find((item) => item.id === siteId);
    if (!site) throw new StoreError(404, 'Site not found');
    Object.assign(site, clone(changes), { updated_at: new Date().toISOString() });
    return clone(site);
  }

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
    return clone({ site, statuses: statuses.map((status) => this.currentStatus(status)) });
  }

  currentStatus(status) {
    const source = this.state.sourceConnections.find((source) => source.id === status.source_connection_id);
    const site = this.state.sites.find((site) => site.id === status.site_id);
    return currentStatus({ ...status, source_active: Boolean(source?.enabled && site?.organisation_id === source.organisation_id
      && isCurrentEvidence(source.last_success_at, source.freshness_seconds ?? 300)) });
  }

  async listSourceConnections() {
    return clone([...this.state.sourceConnections].sort((a, b) => a.name.localeCompare(b.name))
      .map(({ config, key, ...source }) => currentSource(source)));
  }

  async createSource(metadata) {
    if (!(this.state.organisations ?? [this.state.organisation]).some((organisation) => organisation?.id === metadata.organisation_id)) {
      throw new StoreError(422, 'Organisation not found');
    }
    if (this.state.sourceConnections.some((source) => source.organisation_id === metadata.organisation_id && source.name === metadata.name)) {
      throw new StoreError(409, 'Source name already exists in this organisation');
    }
    const now = new Date().toISOString();
    const source = { ...clone(metadata), id: randomId(), connector_type: metadata.plugin_id, enabled: false,
      status: 'disabled', last_success_at: null, created_at: now, updated_at: now };
    this.state.sourceConnections.push(source);
    const { config, ...publicSource } = source;
    return clone(publicSource);
  }

  async editSource(sourceId, validate) {
    this.sourceEdits ??= new Map();
    const work = (this.sourceEdits.get(sourceId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const source = this.state.sourceConnections.find((source) => source.id === sourceId);
      if (!source) throw new StoreError(404, 'Source not found');
      if (source.enabled) throw new StoreError(409, 'Disable the source before changing settings');
      const updated = await validate(clone(source));
      if (source.enabled) throw new StoreError(409, 'Source was enabled while its settings were being validated');
      if (this.state.sourceConnections.some((item) => item.id !== sourceId && item.organisation_id === source.organisation_id && item.name === updated.name)) {
        throw new StoreError(409, 'Source name already exists in this organisation');
      }
      Object.assign(source, clone(updated), { last_success_at: null, updated_at: new Date().toISOString() });
      const { config, key, ...publicSource } = source;
      return clone(publicSource);
    });
    this.sourceEdits.set(sourceId, work);
    try { return await work; }
    finally { if (this.sourceEdits.get(sourceId) === work) this.sourceEdits.delete(sourceId); }
  }

  async listMappings(sourceId) {
    if (!this.state.sourceConnections.some((source) => source.id === sourceId)) throw new StoreError(404, 'Source not found');
    return clone(this.state.mappings.filter((mapping) => mapping.source_connection_id === sourceId && mapping.entity_type === 'site')
      .sort((a, b) => a.external_id.localeCompare(b.external_id)));
  }

  async getSourceAdminContext(sourceId) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!source) throw new StoreError(404, 'Source not found');
    return clone({ source, monitors: this.state.monitors.filter((monitor) => monitor.source_connection_id === sourceId),
      mappings: this.state.mappings.filter((mapping) => mapping.source_connection_id === sourceId && mapping.entity_type === 'site' && mapping.verified)
        .flatMap((mapping) => {
          const site = this.state.sites.find((site) => site.id === mapping.entity_id && site.organisation_id === source.organisation_id);
          return site ? [{ external_id: mapping.external_id, site_id: site.id, site_code: site.site_code, is_demo: site.is_demo }] : [];
        }) });
  }

  async enableSource(sourceId, expected) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!source) throw new StoreError(404, 'Source not found');
    if (!source.enabled) {
      if (source.base_url !== expected.base_url || JSON.stringify(source.config) !== JSON.stringify(expected.config)
        || source.poll_interval_seconds !== expected.poll_interval_seconds || source.freshness_seconds !== expected.freshness_seconds) {
        throw new StoreError(409, 'Source settings changed during the connection test; test again');
      }
      if (source.collection_mode !== 'webhook' && !this.state.mappings.some((mapping) => mapping.source_connection_id === sourceId
        && mapping.entity_type === 'site' && mapping.verified && this.state.sites.some((site) => site.id === mapping.entity_id
          && site.organisation_id === source.organisation_id))) {
        throw new StoreError(422, 'Verify at least one community-site mapping before enabling collection');
      }
      Object.assign(source, { enabled: true, status: 'unknown', last_success_at: null, updated_at: new Date().toISOString() });
      if (source.collection_mode !== 'webhook') {
        let job = this.state.connectorJobs.find((job) => job.source_connection_id === sourceId && (job.job_type ?? 'collect') === 'collect');
        if (!job) { job = { id: randomId(), source_connection_id: sourceId, connector_id: source.plugin_id, job_type: 'collect', max_attempts: 5, payload: {} };
          this.state.connectorJobs.push(job); }
        Object.assign(job, { status: 'pending', attempts: 0, locked_at: null, locked_by: null, lease_token: null,
          next_run_at: new Date().toISOString(), schedule_interval_seconds: source.poll_interval_seconds });
      }
    }
    const { config, key, ...publicSource } = source;
    return clone(currentSource(publicSource));
  }

  async disableSource(sourceId) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!source) throw new StoreError(404, 'Source not found');
    Object.assign(source, { enabled: false, status: 'disabled', last_success_at: null, updated_at: new Date().toISOString() });
    for (const job of this.state.connectorJobs.filter((job) => job.source_connection_id === sourceId)) {
      Object.assign(job, { status: 'dead', lease_token: null, locked_at: null, locked_by: null });
      for (const run of this.state.connectorRuns ?? []) if (run.connector_job_id === job.id && run.status === 'running') {
        Object.assign(run, { status: 'failed', error: 'SOURCE_DISABLED' });
      }
    }
    const { config, key, ...publicSource } = source;
    return clone(publicSource);
  }

  async createMapping(sourceId, metadata) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!source) throw new StoreError(404, 'Source not found');
    if (source.enabled) throw new StoreError(409, 'Disable the source before changing mappings');
    if (source.config?.mapping_policy === 'canonical_site_ids') throw new StoreError(409, 'Tool-owned mappings follow canonical provisioning');
    const site = this.state.sites.find((site) => site.id === metadata.site_id && site.organisation_id === source.organisation_id);
    if (!site) throw new StoreError(422, 'Site is not in the source organisation');
    if (this.state.mappings.some((mapping) => mapping.source_connection_id === sourceId && mapping.entity_type === 'site' && mapping.external_id === metadata.external_id)) {
      throw new StoreError(409, 'External identifier already has a mapping in this source');
    }
    const mapping = { id: randomId(), source_connection_id: sourceId, entity_type: 'site', entity_id: site.id,
      external_id: metadata.external_id, verified: metadata.verified, mapping_method: metadata.verified ? 'operator_verified' : 'operator_pending',
      created_at: new Date().toISOString() };
    this.state.mappings.push(mapping);
    source.last_success_at = null;
    return clone(mapping);
  }

  async editMapping(sourceId, mappingId, changes) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    const mapping = this.state.mappings.find((mapping) => mapping.id === mappingId && mapping.source_connection_id === sourceId && mapping.entity_type === 'site');
    if (!source || !mapping) throw new StoreError(404, 'Mapping not found in this source');
    if (source.enabled) throw new StoreError(409, 'Disable the source before changing mappings');
    if (source.config?.mapping_policy === 'canonical_site_ids') throw new StoreError(409, 'Tool-owned mappings follow canonical provisioning');
    const siteId = changes.site_id ?? mapping.entity_id;
    if (!this.state.sites.some((site) => site.id === siteId && site.organisation_id === source.organisation_id)) {
      throw new StoreError(422, 'Site is not in the source organisation');
    }
    const verified = changes.verified ?? (siteId !== mapping.entity_id ? false : mapping.verified);
    Object.assign(mapping, { entity_id: siteId, verified, mapping_method: verified ? 'operator_verified' : 'operator_pending' });
    source.last_success_at = null;
    return clone(mapping);
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
        .sort((a, b) => a.domain.localeCompare(b.domain)).map((status) => this.currentStatus(status)),
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
      if (!source || !source.enabled || source.status === 'disabled' || source.organisation_id !== site.organisation_id) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: Unknown or disabled source_connection_id`);
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
    for (const source of this.state.sourceConnections.filter((source) => source.enabled && source.config?.mapping_policy === 'canonical_site_ids')) {
      for (const site of this.state.sites.filter((site) => site.organisation_id === source.organisation_id)) {
        if (!this.state.mappings.some((mapping) => mapping.source_connection_id === source.id && mapping.external_id === site.id && mapping.entity_type === 'site')) {
          this.state.mappings.push({ id: randomId(), source_connection_id: source.id, entity_type: 'site', entity_id: site.id,
            external_id: site.id, verified: true, mapping_method: 'owned_canonical_policy' });
        }
      }
    }
    return clone(this.state.sourceConnections
      .filter((source) => source.enabled && source.status !== 'disabled' && source.plugin_id === job.connector_id
        && (!job.source_connection_id || source.id === job.source_connection_id))
      .map((source) => ({ source, monitors: this.state.monitors.filter((monitor) => monitor.source_connection_id === source.id), mappings: this.state.mappings
        .filter((mapping) => mapping.source_connection_id === source.id && mapping.entity_type === 'site' && mapping.verified)
        .flatMap((mapping) => {
          const site = this.state.sites.find((site) => site.id === mapping.entity_id && site.organisation_id === source.organisation_id);
          return site ? [{ external_id: mapping.external_id, site_id: site.id, site_code: site.site_code, is_demo: site.is_demo }] : [];
        }) })));
  }

  async getSourceContext(sourceId) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId && source.enabled);
    if (!source) throw new StoreError(404, 'Enabled source not found');
    return (await this.listConnectorTargets({ connector_id: source.plugin_id, source_connection_id: sourceId }))[0];
  }

  async registerMonitor(monitor) {
    const existing = this.state.monitors.find((item) => item.source_connection_id === monitor.source_connection_id && item.external_id === monitor.external_id);
    if (existing) return clone(existing);
    const source = this.state.sourceConnections.find((source) => source.id === monitor.source_connection_id);
    const site = this.state.sites.find((site) => site.id === monitor.site_id);
    if (!source || (monitor.site_id && (!site || site.organisation_id !== source.organisation_id))) {
      throw new StoreError(422, 'Monitor site is not in the source organisation');
    }
    const item = { id: randomId(), enabled: true, interval_seconds: 60, is_demo: false, ...monitor };
    this.state.monitors.push(item);
    return clone(item);
  }

  async ingestMonitorSamples(sourceId, samples) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!source) throw new StoreError(404, 'Source not found');
    if (!source.enabled) throw new StoreError(422, 'Source is disabled');
    let accepted = 0;
    for (const sample of samples) {
      const monitor = this.state.monitors.find((item) => item.id === sample.monitor_id && item.source_connection_id === sourceId && item.enabled);
      if (!monitor || this.state.monitorSamples.some((item) => item.monitor_id === sample.monitor_id && item.observed_at === sample.observed_at)) continue;
      this.state.monitorSamples.push({ ...clone(sample), response_ms: sample.status === 1 ? sample.response_ms ?? null : null });
      accepted += 1;
    }
    return { accepted, duplicates: samples.length - accepted };
  }

  async applySignal(sourceId, incoming) {
    const signal = validateSignal(incoming);
    const activeSource = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (!activeSource) throw new StoreError(404, 'Source not found');
    if (!activeSource.enabled) throw new StoreError(422, 'Source is disabled');
    let subject;
    if (signal.subject_type === 'monitor') {
      const monitor = this.state.monitors.find((item) => item.id === signal.subject_id && item.source_connection_id === sourceId && item.enabled);
      if (monitor) subject = { ...monitor, monitor_id: monitor.id };
    } else {
      const mapping = this.state.mappings.find((item) => item.entity_id === signal.subject_id && item.entity_type === 'site'
        && item.source_connection_id === sourceId && item.verified);
      const source = this.state.sourceConnections.find((source) => source.id === sourceId);
      const site = this.state.sites.find((site) => site.id === mapping?.entity_id && site.organisation_id === source?.organisation_id);
      if (site) subject = { ...site, site_id: site.id, scope: 'community' };
    }
    if (!subject) throw new StoreError(422, 'Signal subject is not mapped to this source');
    let previous = this.state.signalStates.find((item) => item.source_connection_id === sourceId && item.rule_id === signal.rule_id
      && item.subject_type === signal.subject_type && item.subject_id === signal.subject_id);
    const incident = this.state.incidents.find((item) => item.id === previous?.incident_id);
    const transition = decideSignalTransition(previous, signal, incident);
    if (transition === 'ignored') return { transition, incident_id: previous?.incident_id ?? null };
    let incidentId = previous?.incident_id ?? null;
    if (transition === 'opened') {
      incidentId = randomId();
      const rule = rules[signal.rule_id];
      this.state.incidents.push({ id: incidentId, site_id: subject.site_id ?? null, monitor_id: subject.monitor_id ?? null,
        source_connection_id: sourceId, rule_id: signal.rule_id, title: `${rule.title}: ${subject.name}`, severity: rule.severity,
        status: 'open', started_at: signal.observed_at, last_signal_at: signal.observed_at, signal_count: 1,
        details: { synthetic: subject.is_demo, scope: subject.scope } });
    } else if (transition === 'updated') {
      incident.last_signal_at = signal.observed_at;
      incident.signal_count += 1;
    } else if (transition === 'recovered') {
      Object.assign(incident, { status: 'resolved', resolved_at: signal.observed_at, last_signal_at: signal.observed_at,
        resolution: 'Explicit healthy evidence received' });
    }
    if (['opened', 'recovered'].includes(transition) && !this.state.notifications.some((item) => item.incident_id === incidentId && item.event_kind === transition)) {
      this.state.notifications.push({ id: randomId(), incident_id: incidentId, event_kind: transition,
        status: 'pending', attempts: 0, max_attempts: 10, next_attempt_at: new Date().toISOString() });
    }
    if (!previous) {
      previous = { source_connection_id: sourceId, rule_id: signal.rule_id, subject_type: signal.subject_type, subject_id: signal.subject_id };
      this.state.signalStates.push(previous);
    }
    Object.assign(previous, { latest_at: signal.observed_at, state: signal.state, incident_id: incidentId });
    return { transition, incident_id: incidentId };
  }

  async claimNotification(leaseSeconds = 60) {
    const job = this.state.notifications.find((job) => job.attempts < job.max_attempts && Date.parse(job.next_attempt_at) <= Date.now()
      && (job.event_kind === 'opened' || !this.state.notifications.some((opening) => opening.incident_id === job.incident_id
        && opening.event_kind === 'opened' && !['delivered', 'dead'].includes(opening.status)))
      && (['pending', 'failed'].includes(job.status) || (job.status === 'sending' && Date.parse(job.locked_at) < Date.now() - leaseSeconds * 1000)));
    if (!job) return null;
    Object.assign(job, { status: 'sending', lease_token: randomId(), locked_at: new Date().toISOString() });
    return clone({ ...job, incident: this.state.incidents.find((incident) => incident.id === job.incident_id) });
  }

  async finishNotification(job, error = null) {
    const current = this.state.notifications.find((item) => item.id === job.id && item.lease_token === job.lease_token);
    if (!current) return;
    if (error) {
      current.attempts += 1;
      Object.assign(current, { status: current.attempts >= current.max_attempts ? 'dead' : 'failed',
        last_error: safeError(error), next_attempt_at: new Date(Date.now() + Math.min(3600000, 10000 * 2 ** (current.attempts - 1))).toISOString() });
    } else Object.assign(current, { status: 'delivered', delivered_at: new Date().toISOString(), last_error: null });
    current.lease_token = null;
    current.locked_at = null;
  }

  async markSourceCollected(sourceId, observedAt) {
    const source = this.state.sourceConnections.find((source) => source.id === sourceId);
    if (source?.enabled && (!source.last_success_at || Date.parse(source.last_success_at) <= Date.parse(observedAt))) {
      source.last_success_at = new Date(observedAt).toISOString();
      source.status = 'healthy';
    }
  }

  async upsertStatuses(statuses) {
    for (const status of statuses) {
      if (status.source_connection_id) {
        const source = this.state.sourceConnections.find((source) => source.id === status.source_connection_id);
        if (!source?.enabled) continue;
      }
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

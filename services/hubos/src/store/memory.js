import { randomId } from "../ids.js";
import { StoreError } from "./errors.js";

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
    return clone([...this.state.sourceConnections].sort((a, b) => a.name.localeCompare(b.name)));
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
      if (!source) {
        result.rejected += 1;
        result.errors.push(`observations[${index}]: Unknown source_connection_id`);
        continue;
      }
      const verified = this.state.mappings.some(
        (mapping) =>
          mapping.source_connection_id === source.id &&
          mapping.entity_type === "site" &&
          mapping.entity_id === site.id &&
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
      result.accepted += 1;
    }
    return result;
  }

  async listConnectorTargets() {
    const sourceById = new Map(this.state.sourceConnections.map((source) => [source.id, source]));
    return this.state.sites
      .filter((site) => site.is_demo)
      .map((site) => {
        const siteMappings = this.state.mappings.filter((mapping) => mapping.entity_id === site.id);
        const findSource = (types) => {
          const mapping = siteMappings.find((item) => types.includes(sourceById.get(item.source_connection_id)?.connector_type));
          return mapping?.source_connection_id ?? null;
        };
        return {
          site_id: site.id,
          site_code: site.site_code,
          connectivity_source_id: findSource(["unifi", "mikrotik"]),
          power_source_id: findSource(["innovex_remot"]),
          devices_source_id: findSource(["headwind"]),
        };
      });
  }

  async upsertStatuses(statuses) {
    for (const status of statuses) {
      const existing = this.state.statuses.find(
        (item) => item.site_id === status.site_id && item.domain === status.domain,
      );
      if (existing) Object.assign(existing, clone(status));
      else this.state.statuses.push({ id: randomId(), ...clone(status) });
    }
  }
}

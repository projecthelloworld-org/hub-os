import { mockTelemetry, profileFor, statusReason } from "../../demo/data.js";

export const mockSchoolConnector = {
  manifest: {
    id: "mock-school-telemetry",
    name: "Synthetic community-site telemetry",
    version: "1.0.0",
    protocolVersion: "1.0",
    collectionModes: ["scheduled-pull"],
    capabilities: [
      "connectivity-telemetry",
      "power-telemetry",
      "device-management",
      "source-health",
    ],
  },

  async validateConfig(config = {}) {
    return { valid: config.demo !== false, errors: config.demo === false ? ["Demo mode is disabled"] : [] };
  },

  async collect({ target, observedAt = new Date() }) {
    return {
      observed_at: observedAt.toISOString(),
      source_id: target.source.id,
      profile: target.source.config.profile,
      sites: target.mappings.map((mapping) => ({ ...mapping, telemetry: mockTelemetry(mapping.site_code) })),
    };
  },

  async normalize(raw) {
    const envelopes = [];
    const statuses = [];
    for (const site of raw.sites) {
      const t = site.telemetry;
      const definitions = {
        connectivity: [['connectivity.wan.available', t.wan_up, 'boolean'],
          ['connectivity.latency.ms', t.latency_ms, 'ms'],
          ['connectivity.packet_loss.percent', t.packet_loss_percent, 'percent']],
        power: [['power.battery.voltage', t.battery_voltage, 'V'], ['power.solar.output', t.solar_output_watts, 'W']],
        devices: [['devices.active.count', t.active_devices, 'count'],
          ['devices.check_in.recent.count', t.active_devices, 'count'], ['devices.inventory.count', 20, 'count']],
        survey: [['field.report.fault.count', site.site_code === 'AO-DEMO-05' ? 1 : 0, 'count']],
      };
      const records = definitions[raw.profile];
      if (!records) continue;
      envelopes.push({
        schema_version: '1.0', connector_id: 'mock-school-telemetry',
        source_connection_id: raw.source_id,
        external_entity: { type: 'site', id: site.external_id, hubos_id: site.site_id, site_code: site.site_code },
        external_record_id: `mock:${site.site_code}:${raw.observed_at}`, observed_at: raw.observed_at,
        records: records.map(([metric, value, unit]) => ({ metric, value, unit,
          attributes: { synthetic: true, scope: 'synthetic', sample_interval_seconds: 60 } })),
      });
      if (['connectivity', 'power', 'devices'].includes(raw.profile)) {
        const status = profileFor(site.site_code)[raw.profile];
        statuses.push({ site_id: site.site_id, domain: raw.profile, status,
          reason: statusReason(raw.profile, status), observed_at: raw.observed_at, rule_version: 'demo-v3' });
      }
    }
    return { envelopes, statuses };
  },

  async health() {
    return { status: "healthy", checked_at: new Date().toISOString() };
  },
};

export default mockSchoolConnector;

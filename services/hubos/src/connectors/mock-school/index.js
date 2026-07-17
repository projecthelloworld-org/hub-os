import { mockTelemetry, profileFor, statusReason } from "../../demo/data.js";

export const mockSchoolConnector = {
  manifest: {
    id: "mock-school-telemetry",
    name: "Synthetic school telemetry",
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
      site_code: target.site_code,
      observed_at: observedAt.toISOString(),
      telemetry: mockTelemetry(target.site_code),
      target,
    };
  },

  async normalize(raw) {
    const external = {
      type: "site",
      id: raw.site_code,
      hubos_id: raw.target.site_id,
      site_code: raw.site_code,
    };
    const common = {
      schema_version: "1.0",
      connector_id: "mock-school-telemetry",
      external_entity: external,
      external_record_id: `mock:${raw.site_code}:${raw.observed_at}`,
      observed_at: raw.observed_at,
    };
    const envelopes = [
      {
        ...common,
        source_connection_id: raw.target.connectivity_source_id,
        records: [
          { metric: "connectivity.wan.available", value: raw.telemetry.wan_up, unit: "boolean" },
          { metric: "connectivity.latency.ms", value: raw.telemetry.latency_ms, unit: "ms" },
          { metric: "connectivity.packet_loss.percent", value: raw.telemetry.packet_loss_percent, unit: "percent" },
        ],
      },
      {
        ...common,
        source_connection_id: raw.target.power_source_id,
        records: [
          { metric: "power.battery.voltage", value: raw.telemetry.battery_voltage, unit: "V" },
          { metric: "power.solar.output", value: raw.telemetry.solar_output_watts, unit: "W" },
        ],
      },
      {
        ...common,
        source_connection_id: raw.target.devices_source_id,
        records: [
          { metric: "devices.active.count", value: raw.telemetry.active_devices, unit: "count" },
        ],
      },
    ];
    const profile = profileFor(raw.site_code);
    const statuses = ["connectivity", "power", "devices"].map((domain) => ({
      site_id: raw.target.site_id,
      domain,
      status: profile[domain],
      reason: statusReason(domain, profile[domain]),
      observed_at: raw.observed_at,
      rule_version: "demo-v2",
    }));
    return { envelopes, statuses };
  },

  async health() {
    return { status: "healthy", checked_at: new Date().toISOString() };
  },
};

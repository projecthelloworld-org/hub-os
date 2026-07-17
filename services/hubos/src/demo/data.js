import { stableId } from "../ids.js";

export const sourceDefinitions = [
  ["ug-unifi", "Uganda UniFi Controller", "unifi", "controller_pull"],
  ["ug-mikrotik", "Uganda MikroTik Controller", "mikrotik", "controller_pull"],
  ["ao-unifi", "Angola UniFi Controller", "unifi", "controller_pull"],
  ["ao-mikrotik", "Angola MikroTik Controller", "mikrotik", "controller_pull"],
  ["remot", "Innovex REMOT Demo", "innovex_remot", "api_pull"],
  ["headwind", "Headwind MDM Demo", "headwind", "api_pull"],
  ["odk", "ODK Central Demo", "odk", "api_pull"],
  ["isp", "ISP Monthly Import Demo", "isp_file", "file_import"],
];

export const siteDefinitions = [
  ["UG-DEMO-01", "Uganda Demo School 01", "UG", "Africa/Kampala", 0.3476, 32.5825],
  ["UG-DEMO-02", "Uganda Demo School 02", "UG", "Africa/Kampala", 0.671, 30.275],
  ["UG-DEMO-03", "Uganda Demo School 03", "UG", "Africa/Kampala", 1.3733, 32.2903],
  ["UG-DEMO-04", "Uganda Demo School 04", "UG", "Africa/Kampala", 2.7746, 32.299],
  ["UG-DEMO-05", "Uganda Demo School 05", "UG", "Africa/Kampala", -0.6133, 30.6583],
  ["AO-DEMO-01", "Angola Demo School 01", "AO", "Africa/Luanda", -8.839, 13.2894],
  ["AO-DEMO-02", "Angola Demo School 02", "AO", "Africa/Luanda", -12.5763, 13.4055],
  ["AO-DEMO-03", "Angola Demo School 03", "AO", "Africa/Luanda", -12.3833, 16.9333],
  ["AO-DEMO-04", "Angola Demo School 04", "AO", "Africa/Luanda", -14.6585, 17.69],
  ["AO-DEMO-05", "Angola Demo School 05", "AO", "Africa/Luanda", -15.1961, 12.1522],
];

const profiles = {
  "UG-DEMO-03": { connectivity: "degraded", power: "healthy", devices: "healthy" },
  "AO-DEMO-02": { connectivity: "healthy", power: "degraded", devices: "healthy" },
  "AO-DEMO-05": { connectivity: "critical", power: "healthy", devices: "degraded" },
};

export function profileFor(siteCode) {
  return profiles[siteCode] ?? {
    connectivity: "healthy",
    power: "healthy",
    devices: "healthy",
  };
}

export function statusReason(domain, status) {
  const reasons = {
    "connectivity:healthy": "WAN probe and controller data are healthy",
    "connectivity:degraded": "WAN is reachable but latency and packet loss are elevated",
    "connectivity:critical": "Site-perspective WAN probe is failing",
    "power:healthy": "Battery and panel telemetry are within the demo range",
    "power:degraded": "Battery voltage is below the configured demo warning level",
    "devices:healthy": "Managed-device activity is within the demo range",
    "devices:degraded": "Fewer managed devices are active than expected",
  };
  return reasons[`${domain}:${status}`] ?? "No current evidence";
}

export function mockTelemetry(siteCode) {
  const profile = profileFor(siteCode);
  const critical = profile.connectivity === "critical";
  const degraded = profile.connectivity === "degraded";
  return {
    wan_up: critical ? 0 : 1,
    latency_ms: critical ? 0 : degraded ? 420 : 72,
    packet_loss_percent: critical ? 100 : degraded ? 18 : 1.2,
    battery_voltage: profile.power === "degraded" ? 22.8 : 25.4,
    solar_output_watts: profile.power === "degraded" ? 42 : 386,
    active_devices: profile.devices === "degraded" ? 3 : 18,
  };
}

function networkSourceKey(siteCode) {
  const country = siteCode.slice(0, 2).toLowerCase();
  const number = Number.parseInt(siteCode.slice(-2), 10);
  return `${country}-${number <= 3 ? "unifi" : "mikrotik"}`;
}

export function buildDemoState(date = new Date()) {
  const observedAt = new Date(date);
  observedAt.setUTCSeconds(0, 0);
  const now = observedAt.toISOString();
  const organisation = {
    id: stableId("organisation", "phw-demo"),
    slug: "phw-demo",
    name: "Project Hello World Demonstration",
  };

  const sourceConnections = sourceDefinitions.map(([key, name, connectorType, collectionMode]) => ({
    id: stableId("source", key),
    organisation_id: organisation.id,
    key,
    name,
    connector_type: connectorType,
    collection_mode: collectionMode,
    status: "healthy",
    last_success_at: now,
  }));
  const sourcesByKey = Object.fromEntries(sourceConnections.map((source) => [source.key, source]));

  const sites = siteDefinitions.map(([siteCode, name, countryCode, timezone, latitude, longitude]) => ({
    id: stableId("site", siteCode),
    organisation_id: organisation.id,
    site_code: siteCode,
    name,
    country_code: countryCode,
    timezone,
    latitude,
    longitude,
    is_demo: true,
  }));

  const mappings = [];
  const statuses = [];
  const observations = [];

  for (const site of sites) {
    const sourceMappings = [
      [sourcesByKey[networkSourceKey(site.site_code)], `NET-${site.site_code}`],
      [sourcesByKey.remot, `REMOT-${site.site_code}`],
      [sourcesByKey.headwind, `MDM-${site.site_code}`],
      [sourcesByKey.odk, site.site_code],
      [sourcesByKey.isp, `ISP-SUB-${site.site_code}`],
    ];
    for (const [source, externalId] of sourceMappings) {
      mappings.push({
        id: stableId("mapping", `${source.id}:${externalId}`),
        source_connection_id: source.id,
        entity_type: "site",
        entity_id: site.id,
        external_id: externalId,
        mapping_method: "seeded_demo",
        verified: true,
      });
    }

    const profile = profileFor(site.site_code);
    for (const domain of ["connectivity", "power", "devices"]) {
      statuses.push({
        id: stableId("status", `${site.id}:${domain}`),
        site_id: site.id,
        domain,
        status: profile[domain],
        reason: statusReason(domain, profile[domain]),
        observed_at: now,
        rule_version: "demo-v2",
      });
    }

    const telemetry = mockTelemetry(site.site_code);
    const metricDefinitions = [
      [sourcesByKey[networkSourceKey(site.site_code)], "connectivity.wan.available", telemetry.wan_up, "boolean"],
      [sourcesByKey[networkSourceKey(site.site_code)], "connectivity.latency.ms", telemetry.latency_ms, "ms"],
      [sourcesByKey[networkSourceKey(site.site_code)], "connectivity.packet_loss.percent", telemetry.packet_loss_percent, "percent"],
      [sourcesByKey.remot, "power.battery.voltage", telemetry.battery_voltage, "V"],
      [sourcesByKey.remot, "power.solar.output", telemetry.solar_output_watts, "W"],
      [sourcesByKey.headwind, "devices.active.count", telemetry.active_devices, "count"],
    ];
    for (const [source, metric, value, unit] of metricDefinitions) {
      observations.push({
        site_id: site.id,
        site_code: site.site_code,
        source_connection_id: source.id,
        external_record_id: `demo:${site.site_code}:${now}`,
        metric,
        value,
        unit,
        quality: "valid",
        observed_at: now,
        attributes: { synthetic: true, profile: "ten-school-demo" },
      });
    }
  }

  return {
    organisation,
    sourceConnections,
    sites,
    mappings,
    statuses,
    observations,
    incidents: [
      {
        id: stableId("incident", "ao-demo-05-wan"),
        site_id: stableId("site", "AO-DEMO-05"),
        title: "School connectivity unavailable",
        severity: "high",
        status: "open",
        owner: "Angola network support queue",
        started_at: now,
        details: {
          synthetic: true,
          runbook: "runbooks/connectivity-outage.md",
          correlation: "Power healthy; WAN probe failing",
        },
      },
    ],
    connectorJobs: [
      {
        id: stableId("job", "mock-school-refresh"),
        connector_id: "mock-school-telemetry",
        job_type: "collect",
        payload: { demo: true },
        status: "pending",
        next_run_at: now,
        schedule_interval_seconds: 60,
        max_attempts: 5,
      },
    ],
  };
}

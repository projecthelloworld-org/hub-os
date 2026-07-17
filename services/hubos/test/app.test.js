import { beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildDemoState } from "../src/demo/data.js";
import { MemoryStore } from "../src/store/memory.js";

const fixedDate = new Date("2026-07-16T12:00:00.000Z");
const config = loadConfig({
  HUBOS_ENV: "test",
  HUBOS_DEMO_MODE: "true",
  HUBOS_INGEST_KEY: "test-ingest-key",
  HUBOS_ADMIN_KEY: "test-admin-key",
  HUBOS_OPERATOR_CONSOLE_ENABLED: "true",
});

let store;
let app;

function request(path, options = {}) {
  return app(new Request(`http://hubos.test${path}`, options));
}

beforeEach(() => {
  store = new MemoryStore(buildDemoState(fixedDate));
  app = createApp({ store, config });
});

describe("health and operator console", () => {
  test("reports process health and database readiness", async () => {
    expect((await request("/healthz")).status).toBe(200);
    expect(await (await request("/readyz")).json()).toEqual({ status: "ready" });
  });

  test("serves the vanilla console with security headers", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain("Know what needs attention");
    expect((await request("/static/app.css")).headers.get("content-type")).toContain("text/css");
  });
});

describe("read API", () => {
  test("lists ten demo schools and filters by country", async () => {
    const all = await (await request("/api/v1/sites")).json();
    const uganda = await (await request("/api/v1/sites?country=ug")).json();
    expect(all.sites).toHaveLength(10);
    expect(uganda.sites).toHaveLength(5);
    expect(uganda.sites.every((site) => site.country_code === "UG")).toBe(true);
  });

  test("returns three operational status domains for a site", async () => {
    const { sites } = await (await request("/api/v1/sites?country=UG")).json();
    const payload = await (await request(`/api/v1/sites/${sites[0].id}/status`)).json();
    expect(payload.statuses.map((status) => status.domain)).toEqual(["connectivity", "devices", "power"]);
  });

  test("exposes connector and source inventories", async () => {
    const sources = await (await request("/api/v1/source-connections")).json();
    const connectors = await (await request("/api/v1/connectors")).json();
    expect(sources.source_connections).toHaveLength(8);
    expect(connectors.connectors[0].id).toBe("mock-school-telemetry");
  });

  test("builds an operator overview with the active incident", async () => {
    const overview = await (await request("/api/v1/overview")).json();
    expect(overview.sites).toHaveLength(10);
    expect(overview.incidents).toHaveLength(1);
    expect(overview.incidents[0].country_code).toBe("AO");
  });
});

describe("protected write API", () => {
  test("requires an ingest key and makes batches idempotent", async () => {
    const demo = buildDemoState(fixedDate);
    const source = demo.sourceConnections[0];
    const site = demo.sites.find((item) => item.site_code === "UG-DEMO-01");
    const body = JSON.stringify({
      observations: [{
        site_id: site.id,
        source_connection_id: source.id,
        external_record_id: "manual:test:1",
        metric: "connectivity.latency.ms",
        value: 81,
        unit: "ms",
        observed_at: fixedDate.toISOString(),
      }],
    });
    const unauthorised = await request("/api/v1/ingest/observations:batch", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(unauthorised.status).toBe(401);

    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "x-hubos-ingest-key": "test-ingest-key" },
      body,
    };
    expect(await (await request("/api/v1/ingest/observations:batch", options)).json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(await (await request("/api/v1/ingest/observations:batch", options)).json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  test("rejects a source that is not mapped to the selected site", async () => {
    const demo = buildDemoState(fixedDate);
    const body = JSON.stringify({ observations: [{
      site_id: demo.sites[0].id,
      source_connection_id: demo.sourceConnections.find((source) => source.key === "ao-unifi").id,
      external_record_id: "manual:unmapped",
      metric: "connectivity.latency.ms",
      value: 50,
      observed_at: fixedDate.toISOString(),
    }] });
    const result = await (await request("/api/v1/ingest/observations:batch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hubos-ingest-key": "test-ingest-key" },
      body,
    })).json();
    expect(result.rejected).toBe(1);
    expect(result.errors[0]).toContain("not verified");
  });

  test("acknowledges and resolves incidents with the admin key", async () => {
    const incidentId = buildDemoState(fixedDate).incidents[0].id;
    const headers = { "content-type": "application/json", "x-hubos-admin-key": "test-admin-key" };
    const acknowledged = await request(`/api/v1/incidents/${incidentId}/acknowledge`, {
      method: "POST", headers, body: JSON.stringify({ owner: "Network operations" }),
    });
    expect((await acknowledged.json()).status).toBe("acknowledged");
    const resolved = await request(`/api/v1/incidents/${incidentId}/resolve`, {
      method: "POST", headers, body: JSON.stringify({ resolution: "Router power restored" }),
    });
    expect((await resolved.json()).status).toBe("resolved");
  });
});

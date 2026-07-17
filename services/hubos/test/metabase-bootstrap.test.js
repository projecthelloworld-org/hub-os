import { describe, expect, test } from "bun:test";

import {
  bootstrapMetabase,
  buildDatabasePayload,
  buildSetupPayload,
  loadMetabaseBootstrapConfig,
} from "../src/metabase/bootstrap.js";

const config = loadMetabaseBootstrapConfig({
  METABASE_URL: "http://metabase:3000/",
  METABASE_ADMIN_EMAIL: "operator@example.test",
  METABASE_ADMIN_PASSWORD: "test-password-1",
  METABASE_HUBOS_DB_USER: "reporting",
  METABASE_HUBOS_DB_PASSWORD: "reporting-password",
  METABASE_HUBOS_SCHEMAS: "analytics",
});

describe("Metabase bootstrap", () => {
  test("builds the first-run user and HubOS PostgreSQL connection", () => {
    const payload = buildSetupPayload(config, "setup-token");
    expect(config.url).toBe("http://metabase:3000");
    expect(payload.token).toBe("setup-token");
    expect(payload.user.email).toBe("operator@example.test");
    expect(buildDatabasePayload(config)).toMatchObject({
      name: "HubOS PostgreSQL",
      engine: "postgres",
      is_full_sync: true,
      is_on_demand: false,
      connection_source: "admin",
      details: {
        host: "db",
        port: 5432,
        dbname: "hubos",
        user: "reporting",
        "schema-filters-type": "inclusion",
        "schema-filters-patterns": "analytics",
      },
    });
    expect(payload.prefs.site_name).toBe("HubOS Monitoring and Evaluation");
  });

  test("posts setup only when Metabase exposes a setup token", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/api/session/properties")) {
        return Response.json({ "setup-token": "one-time-token" });
      }
      if (url.endsWith("/api/setup")) return Response.json({ id: "session-id" });
      if (options.method === "POST") return Response.json({ id: 2 });
      return Response.json({ data: [{ id: 1, name: "Sample Database" }] });
    };
    const result = await bootstrapMetabase({ config, fetchImpl, logger: { log() {} } });
    expect(result.status).toBe("configured");
    expect(requests).toHaveLength(4);
    expect(requests[1].url).toEndWith("/api/setup");
    expect(requests[3].url).toEndWith("/api/database");
    expect(JSON.parse(requests[3].options.body).engine).toBe("postgres");
  });

  test("is idempotent after initial setup", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push(url);
      if (url.endsWith("/api/session/properties")) return Response.json({ "setup-token": null });
      if (url.endsWith("/api/session")) return Response.json({ id: "session-id" });
      if (!options.method) return Response.json({ data: [{ id: 2, name: "HubOS PostgreSQL" }] });
      throw new Error("Database should not be created again");
    };
    const result = await bootstrapMetabase({ config, fetchImpl, logger: { log() {} } });
    expect(result).toEqual({ status: "already-configured" });
    expect(requests).toHaveLength(3);
  });

  test("reports setup errors without exposing the submitted password", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/session/properties")) {
        return Response.json({ "setup-token": "one-time-token" });
      }
      return Response.json({ message: "Setup failed" }, { status: 400 });
    };
    expect(bootstrapMetabase({ config, fetchImpl, logger: { log() {} } })).rejects.toThrow(
      "Setup failed",
    );
  });

  test("recovers a partially initialized instance with configured admin credentials", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/api/session/properties")) {
        return Response.json({ "setup-token": "stale-token" });
      }
      if (url.endsWith("/api/setup")) {
        return Response.json({ message: "First user already exists" }, { status: 403 });
      }
      if (url.endsWith("/api/session")) return Response.json({ id: "existing-session" });
      if (!options.method) return Response.json({ data: [] });
      return Response.json({ id: 7 });
    };
    const result = await bootstrapMetabase({ config, fetchImpl, logger: { log() {} } });
    expect(result).toEqual({ status: "configured", databaseId: 7 });
    expect(requests).toHaveLength(5);
  });
});

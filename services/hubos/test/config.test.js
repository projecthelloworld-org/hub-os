import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.js";
import { stableId } from "../src/ids.js";

describe("configuration safety", () => {
  test("keeps deterministic canonical identifiers", () => {
    expect(stableId("site", "UG-DEMO-01")).toBe(stableId("site", "UG-DEMO-01"));
    expect(stableId("site", "UG-DEMO-01")).not.toBe(stableId("site", "UG-DEMO-02"));
  });

  test("rejects demo mode and placeholder keys in production", () => {
    expect(() => loadConfig({ HUBOS_ENV: "production", HUBOS_DEMO_MODE: "true" })).toThrow("disabled");
    expect(() => loadConfig({
      HUBOS_ENV: "production",
      HUBOS_DEMO_MODE: "false",
      HUBOS_INGEST_KEY: "local-demo-ingest-key",
      HUBOS_ADMIN_KEY: "strong-admin-key",
    })).toThrow("placeholder");
  });
});

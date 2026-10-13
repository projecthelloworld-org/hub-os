import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.js";
import { stableId } from "../src/ids.js";

describe("configuration safety", () => {
  test("keeps deterministic canonical identifiers", () => {
    expect(stableId("site", "UG-DEMO-01")).toBe(stableId("site", "UG-DEMO-01"));
    expect(stableId("site", "UG-DEMO-01")).not.toBe(stableId("site", "UG-DEMO-02"));
  });
  test('standalone development listens only on loopback unless explicitly changed', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HUBOS_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
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
  test('remote exposure requires an explicit HTTPS origin without syntax or credential injection', () => {
    expect(() => loadConfig({ HUBOS_BIND_ADDRESS: '0.0.0.0' })).toThrow('HTTPS');
    for (const value of ['http://example.org', 'https://user:password@example.org', 'https://example.org/path',
      'https://example.org/?token=secret', 'https://example.org/#fragment', ':80\nrespond unsafe']) {
      expect(() => loadConfig({ HUBOS_SITE_ADDRESS: value })).toThrow('HTTPS origin');
    }
    expect(loadConfig({ HUBOS_BIND_ADDRESS: '0.0.0.0', HUBOS_SITE_ADDRESS: 'https://monitoring.example.org' }).operatorOrigin)
      .toBe('https://monitoring.example.org');
  });
  test('production keys cannot be empty, weak or reused between machine roles', () => {
    const strong = { HUBOS_ENV: 'production', HUBOS_INGEST_KEY: 'i'.repeat(64), HUBOS_ADMIN_KEY: 'a'.repeat(64) };
    expect(() => loadConfig(strong)).not.toThrow();
    for (const value of ['', 'short', strong.HUBOS_INGEST_KEY]) {
      expect(() => loadConfig({ ...strong, HUBOS_ADMIN_KEY: value })).toThrow('distinct');
    }
  });
});

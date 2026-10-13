import { describe, expect, test } from "bun:test";

import { flattenEnvelope, validateConnector } from "../src/connectors/contract.js";
import { mockSchoolConnector } from "../src/connectors/mock-school/index.js";
import { buildDemoState } from "../src/demo/data.js";
import { MemoryStore } from '../src/store/memory.js';

describe("uniform connector contract", () => {
  test("requires the common lifecycle and manifest", () => {
    expect(validateConnector(mockSchoolConnector)).toBe(mockSchoolConnector);
    expect(() => validateConnector({ manifest: { id: "broken" } })).toThrow();
  });

  test("normalizes vendor-shaped data into canonical observations", async () => {
    const state = buildDemoState(new Date("2026-07-16T12:00:00.000Z"));
    const targets = await new MemoryStore(state).listConnectorTargets({ connector_id: 'mock-school-telemetry' });
    const target = targets.find((target) => target.source.key === 'remot');
    const raw = await mockSchoolConnector.collect({ target, observedAt: new Date("2026-07-16T12:00:00.000Z") });
    const normalized = await mockSchoolConnector.normalize(raw);
    const observations = normalized.envelopes.flatMap(flattenEnvelope);
    expect(observations).toHaveLength(20);
    expect(observations.map((item) => item.metric)).toContain("power.battery.voltage");
    expect(normalized.statuses).toHaveLength(10);
  });
});

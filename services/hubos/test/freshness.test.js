import { expect, test } from 'bun:test';
import { currentStatus, currentSource } from '../src/store/freshness.js';

test('freshness distinguishes observed health, stale/missing evidence, future clocks and disabled sources', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  expect(currentStatus({ status: 'healthy', observed_at: '2026-10-13T11:59:00Z' }, now).status).toBe('healthy');
  expect(currentStatus({ status: 'critical', observed_at: '2026-10-13T11:59:00Z' }, now).status).toBe('critical');
  for (const observed_at of [null, 'invalid', '2026-10-13T11:54:00Z', '2026-10-13T12:02:00Z']) {
    expect(currentStatus({ status: 'healthy', observed_at }, now).status).toBe('unknown');
  }
  expect(currentSource({ enabled: false, status: 'healthy' }, now).status).toBe('disabled');
  expect(currentSource({ enabled: true, status: 'healthy', last_success_at: null }, now).status).toBe('unknown');
  expect(currentSource({ enabled: true, status: 'healthy', last_success_at: '2026-10-13T11:59:00Z', freshness_seconds: 30 }, now).status).toBe('unknown');
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresStore } from '../src/store/postgres.js';
import { randomId } from '../src/ids.js';

const url = process.env.HUBOS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('PostgreSQL incident ledger and coverage', () => {
  let store, orgId, sourceId, monitor;
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/hubos_test' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Isolated fixture database required');
    store = new PostgresStore({ databaseUrl: url });
    orgId = randomId(); sourceId = randomId();
    await store.db`INSERT INTO organisations (id, slug, name) VALUES (${orgId}, ${`alert-fixture-${orgId}`}, 'Alert fixture')`;
    await store.db`INSERT INTO source_connections (id, organisation_id, name, connector_type, plugin_id, collection_mode, enabled)
      VALUES (${sourceId}, ${orgId}, 'Fixture monitor source', 'fixture', 'uptime-kuma', 'scheduled_pull', true)`;
    monitor = await store.registerMonitor({ source_connection_id: sourceId, external_id: '42', name: 'Fixture infrastructure', scope: 'infrastructure', interval_seconds: 60 });
  });
  afterAll(async () => {
    if (store) {
      await store.db`DELETE FROM incidents WHERE source_connection_id = ${sourceId}`;
      await store.db`DELETE FROM organisations WHERE id = ${orgId}`;
      await store.close();
    }
  });

  test('concurrent repeated signals create one incident and one opening notification', async () => {
    const base = Date.now() - 10000;
    const signal = { rule_id: 'availability', subject_type: 'monitor', subject_id: String(monitor.id), state: 'active', observed_at: new Date(base).toISOString() };
    const results = await Promise.all(Array.from({ length: 8 }, () => store.applySignal(sourceId, signal)));
    expect(results.filter((result) => result.transition === 'opened')).toHaveLength(1);
    const [incident] = await store.db`SELECT * FROM incidents WHERE source_connection_id = ${sourceId}`;
    expect(incident.site_id).toBeNull();
    expect((await store.db`SELECT * FROM notification_outbox WHERE incident_id = ${incident.id}`)).toHaveLength(1);
    await store.acknowledgeIncident(String(incident.id), 'support-queue');
    await store.applySignal(sourceId, { ...signal, observed_at: new Date(base + 1000), state: 'unknown' });
    await store.applySignal(sourceId, { ...signal, observed_at: new Date(base - 1000), state: 'healthy' });
    const [stillOpen] = await store.db`SELECT status, owner FROM incidents WHERE id = ${incident.id}`;
    expect(stillOpen.status).toBe('acknowledged');
    expect(stillOpen.owner).toBe('support-queue');
    await store.applySignal(sourceId, { ...signal, observed_at: new Date(base + 2000), state: 'healthy' });
    expect((await store.db`SELECT * FROM notification_outbox WHERE incident_id = ${incident.id}`)).toHaveLength(2);
  });

  test('notification leases survive a crash and do not accept stale completion', async () => {
    const first = await store.claimNotification();
    expect(first).not.toBeNull();
    await store.db`UPDATE notification_outbox SET locked_at = now() - interval '1 hour' WHERE id = ${first.id}`;
    const next = await store.claimNotification();
    expect(String(next.id)).toBe(String(first.id));
    await store.finishNotification(first);
    const [row] = await store.db`SELECT status FROM notification_outbox WHERE id = ${first.id}`;
    expect(row.status).toBe('sending');
    await store.finishNotification(next, new Error('SMTP password=secret'));
    const [failed] = await store.db`SELECT status, last_error FROM notification_outbox WHERE id = ${first.id}`;
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toBe('COLLECTION_FAILED');
  });

  test('availability is weighted by supported intervals and includes unknown coverage', async () => {
    const now = Date.now();
    await store.db`UPDATE monitors SET created_at = ${new Date(now - 600000)} WHERE id = ${monitor.id}`;
    for (const [offset, status, ping] of [[-300000, 1, 20], [-240000, 0, null], [-180000, null, null], [-60000, 1, 40]]) {
      await store.ingestMonitorSamples(sourceId, [{ monitor_id: String(monitor.id), observed_at: new Date(now + offset), status, response_ms: ping, origin: 'metrics' }]);
    }
    const [totals] = await store.db`SELECT sum(up_seconds)::float AS up, sum(observed_seconds)::float AS observed,
      sum(eligible_seconds)::float AS eligible FROM analytics.monitor_daily WHERE monitor_id = ${monitor.id}`;
    expect(totals.up).toBeCloseTo(120, 0);
    expect(totals.observed).toBeCloseTo(180, 0);
    expect(totals.eligible).toBeCloseTo(600, 0);
    expect(totals.up / totals.observed).toBeCloseTo(2 / 3, 3);
    expect(totals.observed / totals.eligible).toBeCloseTo(0.3, 3);
    await store.ingestMonitorSamples(sourceId, [{ monitor_id: String(monitor.id), observed_at: new Date(), status: null, origin: 'metrics' }]);
    const [current] = await store.db`SELECT * FROM analytics.monitor_current WHERE monitor_id = ${monitor.id}`;
    expect(current.status).toBe('unknown');
    expect(current.response_ms).toBeNull();
  });
});

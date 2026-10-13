import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresStore } from '../src/store/postgres.js';
import { provisionKuma } from '../src/kuma/bootstrap.js';
import { withKumaSession } from '../src/kuma/adapter-2.5.6.js';
import { createHttpClient } from '../src/connector-runtime/http-client.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import kuma from '../src/connectors/uptime-kuma/index.js';
import { persistConnectorResult } from '../src/connector-runtime/results.js';
import { createNotificationSender, deliverNextNotification } from '../src/alerts/delivery.js';
import { readFile, readdir } from 'node:fs/promises';
import { SQL } from 'bun';
import { randomId } from '../src/ids.js';

const kumaUrl = process.env.HUBOS_TEST_KUMA_URL;
const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
const suite = kumaUrl && databaseUrl ? describe : describe.skip;

async function waitFor(check, maximumMs = 90000) {
  const end = performance.now() + maximumMs;
  while (performance.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Isolated Kuma fixture condition timed out');
}

suite('Uptime Kuma 2.5.6 actual adapter and Mailpit', () => {
  let store, server, env, first, monitor, credentials, admin, fixtureDatabase;
  const rejectedCallbacks = [];
  const definitions = [
    { key: 'controlled-fixture', name: 'HubOS controlled fixture (infrastructure)', url: 'http://probe:3900/controlled', scope: 'infrastructure', interval_seconds: 20 },
    { key: 'up-fixture', name: 'HubOS up fixture (infrastructure)', url: 'http://probe:3900/up', scope: 'infrastructure', interval_seconds: 20 },
  ];
  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (parsed.pathname !== '/hubos_test' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !kumaUrl.startsWith('http://127.0.0.1:13002')) throw new Error('Disposable local fixtures required');
    admin = new SQL({ url: databaseUrl, max: 1 });
    fixtureDatabase = `hubos_kuma_${randomId().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${fixtureDatabase}`);
    const fixtureUrl = new URL(databaseUrl);
    fixtureUrl.pathname = `/${fixtureDatabase}`;
    store = new PostgresStore({ databaseUrl: fixtureUrl.href });
    const migrations = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
      const migration = await Bun.file(new URL(file, migrations)).text();
      await store.db.unsafe(migration.split('-- migrate:down')[0]);
    }
    await fetch('http://127.0.0.1:13003/__test/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-key': 'fixture-only' }, body: JSON.stringify({ status: 200 }) });
    const app = createApp({ store, config: loadConfig(), resolveSecrets: async () => ({ webhookKey: 'fixture-only-kuma-webhook' }) });
    server = Bun.serve({ hostname: process.env.HUBOS_TEST_CALLBACK_BIND ?? '127.0.0.1', port: 13004, async fetch(request) {
      const response = await app(request);
      if (response.status >= 400) rejectedCallbacks.push({ status: response.status, error: (await response.clone().json()).error });
      return response;
    } });
    env = {
      HUBOS_DATABASE_URL: fixtureUrl.href, HUBOS_DEMO_MODE: 'false', KUMA_OWNED_INSTANCE: 'true', KUMA_URL: kumaUrl,
      KUMA_ADMIN_USER: 'hubos-test-admin', KUMA_ADMIN_PASSWORD: 'Fixture-Kuma-Password-2026!',
      KUMA_WEBHOOK_KEY: 'fixture-only-kuma-webhook', KUMA_METRICS_KEY_FILE: '/tmp/hubos-kuma-fixture-metrics.key',
      HUBOS_INTERNAL_URL: `http://host.docker.internal:${server.port}`,
    };
    // Only this fixture database is reset; Kuma keeps its real account between repeat provision checks.
    await store.db`DELETE FROM incidents WHERE source_connection_id IN (SELECT id FROM source_connections WHERE name = 'HubOS-owned Uptime Kuma')`;
    first = await provisionKuma({ store, env, definitions });
    const target = await store.getSourceContext(first.source_id);
    monitor = target.monitors.find((monitor) => monitor.name.includes('controlled'));
    credentials = { username: env.KUMA_ADMIN_USER, password: env.KUMA_ADMIN_PASSWORD,
      metricsKey: (await readFile(env.KUMA_METRICS_KEY_FILE, 'utf8')).trim() };
  }, 60000);
  afterAll(async () => {
    await server?.stop(); await store?.close();
    if (fixtureDatabase && admin) await admin.unsafe(`DROP DATABASE ${fixtureDatabase}`);
    await admin?.close();
  });

  async function collect() {
    const target = await store.getSourceContext(first.source_id);
    // Container-owned targets need their operator-facing URL adjusted only in the fixture context.
    target.source.base_url = kumaUrl;
    const context = { ...target, credentials, observedAt: new Date(), signal: new AbortController().signal,
      requestText: createHttpClient({ responseType: 'text' }) };
    const raw = await kuma.collect(context);
    const normalized = await kuma.normalize(raw);
    await persistConnectorResult({ store, target, connector: kuma, normalized });
    return normalized;
  }

  function requireAcceptedCallbacks() {
    if (rejectedCallbacks.length) throw new Error(`Fixture callback rejected: ${JSON.stringify(rejectedCallbacks)}`);
  }

  test('fresh/repeat setup creates one account, one routing provider, one key and two monitors without resetting edits', async () => {
    expect(first.monitors).toBe(2);
    expect(first.administrator_created).toBe(true);
    await withKumaSession({ url: kumaUrl, username: credentials.username, password: credentials.password }, async (session) => {
      const reply = await session.requireOk('getMonitor', Number(monitor.external_id));
      await session.requireOk('editMonitor', { ...reply.monitor, name: 'Operator customised fixture monitor' });
    });
    const again = await provisionKuma({ store, env, definitions });
    expect(again.created).toBe(0);
    expect(again.administrator_created).toBe(false);
    await withKumaSession({ url: kumaUrl, username: credentials.username, password: credentials.password }, async (session) => {
      expect(Object.keys(session.monitors)).toHaveLength(2);
      expect(session.monitors[monitor.external_id].name).toBe('Operator customised fixture monitor');
      expect(session.notifications.filter((notification) => notification.name === 'HubOS incident routing')).toHaveLength(1);
      expect(session.apiKeys.filter((key) => key.name === 'HubOS metrics')).toHaveLength(1);
    });
    const [count] = await store.db`SELECT count(*)::int AS count FROM monitors WHERE source_connection_id = ${first.source_id}`;
    expect(count.count).toBe(2);
  }, 60000);

  test('supported metrics plus fresh heartbeat produce status/latency; native outages and recovery create one incident', async () => {
    const connection = await store.getSourceContext(first.source_id);
    const health = await kuma.health({ ...connection, credentials, requestText: createHttpClient({ responseType: 'text' }) });
    expect(health.version).toBe('2.5.6');
    const initial = await collect();
    expect(initial.monitorSamples.every((sample) => sample.status === 1)).toBe(true);
    await fetch('http://127.0.0.1:13003/__test/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-key': 'fixture-only' }, body: JSON.stringify({ status: 503 }) });
    await waitFor(async () => { requireAcceptedCallbacks(); return (await store.db`SELECT id FROM incidents WHERE monitor_id = ${monitor.id} AND status = 'open'`).length === 1; });
    await collect();
    const [incident] = await store.db`SELECT * FROM incidents WHERE monitor_id = ${monitor.id} AND status = 'open'`;
    expect((await store.db`SELECT * FROM notification_outbox WHERE incident_id = ${incident.id} AND event_kind = 'opened'`)).toHaveLength(1);
    const target = await store.getSourceContext(first.source_id);
    const latest = (await store.db`SELECT observed_at FROM monitor_samples WHERE monitor_id = ${monitor.id} AND status = 0 ORDER BY observed_at DESC LIMIT 1`)[0];
    const repeated = await kuma.webhook({ monitor: { id: Number(monitor.external_id) }, heartbeat: { status: 0, time: new Date(latest.observed_at).toISOString() } }, target);
    await persistConnectorResult({ store, target, connector: kuma, normalized: repeated });
    expect((await store.db`SELECT * FROM incidents WHERE monitor_id = ${monitor.id}`)).toHaveLength(1);
    await fetch('http://127.0.0.1:13003/__test/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-key': 'fixture-only' }, body: JSON.stringify({ status: 200 }) });
    await waitFor(async () => { requireAcceptedCallbacks(); return (await store.db`SELECT id FROM incidents WHERE id = ${incident.id} AND status = 'resolved'`).length === 1; });
    expect((await store.db`SELECT * FROM notification_outbox WHERE incident_id = ${incident.id} AND event_kind = 'recovered'`)).toHaveLength(1);
  }, 240000);

  test('paused monitors become unknown rather than healthy and alert mail reaches Mailpit', async () => {
    await withKumaSession({ url: kumaUrl, username: credentials.username, password: credentials.password }, async (session) => {
      await session.requireOk('pauseMonitor', Number(monitor.external_id));
    });
    const normalized = await collect();
    expect(normalized.monitorSamples.find((sample) => sample.monitor_id === String(monitor.id)).status).toBeNull();
    const send = createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'local', HUBOS_LOCAL_SMTP_HOST: '127.0.0.1', HUBOS_LOCAL_SMTP_PORT: '11025' });
    let delivered = 0;
    for (let index = 0; index < 10; index++) {
      const result = await deliverNextNotification({ store, send });
      if (!result) break;
      if (result.delivered) delivered += 1;
    }
    expect(delivered).toBeGreaterThanOrEqual(2);
    const messages = await (await fetch('http://127.0.0.1:18025/api/v1/messages')).json();
    expect(messages.messages.some((message) => message.Subject.includes('[HubOS opened]'))).toBe(true);
    expect(messages.messages.some((message) => message.Subject.includes('[HubOS recovered]'))).toBe(true);
    await withKumaSession({ url: kumaUrl, username: credentials.username, password: credentials.password }, async (session) => {
      await session.requireOk('resumeMonitor', Number(monitor.external_id));
    });
  }, 60000);
});

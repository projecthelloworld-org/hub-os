import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { PostgresStore } from '../src/store/postgres.js';
import { buildDemoState } from '../src/demo/data.js';
import { randomId, stableId } from '../src/ids.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { bootstrapMetabase, loadMetabaseBootstrapConfig } from '../src/metabase/bootstrap.js';
import { provisionMetabaseMonitoring } from '../src/metabase/provision.js';
import { createMetabaseClient } from '../src/metabase/client.js';
import { questions, dashboards } from '../src/metabase/catalog.js';
import { createNotificationSender, deliverNextNotification } from '../src/alerts/delivery.js';

const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
const metabaseUrl = process.env.HUBOS_TEST_METABASE_URL;
const suite = databaseUrl && metabaseUrl ? describe : describe.skip;
const waitFor = async (check, timeout = 45000) => {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Native Metabase fixture condition timed out');
};

suite('Metabase release compatibility', () => {
  test('running version is the maintained release baseline', async () => {
    if (metabaseUrl !== 'http://127.0.0.1:13021') throw new Error('Disposable local Metabase fixture required');
    const response = await fetch(`${metabaseUrl}/api/session/properties`, { signal: AbortSignal.timeout(5000) });
    expect(response.ok).toBe(true);
    const properties = await response.json();
    expect(properties.version?.tag).toBe('v0.64.1.7');
  });
});

suite('Native Metabase dashboards, filters and alert routing (disposable fixture)', () => {
  let admin, store, server, env, client, first, roleName, databaseName, originalAccountId, sessionId;
  const webhookKey = 'fixture-only-metabase-webhook';
  const callbacks = [];
  beforeAll(async () => {
    const base = new URL(databaseUrl);
    if (base.pathname !== '/hubos_test' || !['127.0.0.1', 'localhost'].includes(base.hostname)
      || metabaseUrl !== 'http://127.0.0.1:13021') throw new Error('Disposable local fixtures required');
    const properties = await (await fetch(`${metabaseUrl}/api/session/properties`)).json();
    if (!properties['setup-token']) throw new Error('Native test requires a fresh isolated Metabase volume');
    const suffix = randomId().replaceAll('-', '');
    databaseName = `hubos_metabase_${suffix}`;
    roleName = `analytics_meta_${suffix}`;
    admin = new SQL({ url: databaseUrl, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    base.pathname = `/${databaseName}`;
    store = new PostgresStore({ databaseUrl: base.href });
    const directory = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await store.db.unsafe((await Bun.file(new URL(file, directory)).text()).split('-- migrate:down')[0]);
    }
    await store.seedDemo(buildDemoState(new Date()));
    const receiver = createApp({ store, config: loadConfig({ HUBOS_DEMO_MODE: 'true' }), resolveSecrets: async () => ({ webhookKey }) });
    const callbackHost = process.env.HUBOS_TEST_CALLBACK_HOST ?? 'host.docker.internal';
    if (callbackHost !== 'host.docker.internal' && !/^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(callbackHost)) {
      throw new Error('Private fixture bridge callback required');
    }
    server = Bun.serve({ hostname: process.env.HUBOS_TEST_CALLBACK_BIND ?? '127.0.0.1', port: 13024,
      fetch: async (request) => {
        const received = { path: new URL(request.url).pathname, status: null };
        callbacks.push(received);
        const response = await receiver(request);
        received.status = response.status;
        return response;
      } });
    env = {
      HUBOS_DATABASE_URL: base.href, HUBOS_DEMO_MODE: 'true', METABASE_URL: metabaseUrl,
      METABASE_ADMIN_EMAIL: 'fixture-admin@local.test', METABASE_ADMIN_PASSWORD: 'Fixture-Metabase-Password-2026!',
      // Linux loopback-published ports are intentionally unreachable via the host gateway.
      METABASE_HUBOS_DB_HOST: 'db', METABASE_HUBOS_DB_PORT: '5432',
      METABASE_HUBOS_DB_NAME: databaseName, METABASE_HUBOS_DB_USER: roleName,
      METABASE_HUBOS_DB_PASSWORD: 'Fixture-Reporting-Password-2026!', METABASE_WEBHOOK_KEY: webhookKey,
      HUBOS_INTERNAL_URL: `http://${callbackHost}:${server.port}`,
      // Manual native sends exercise the same routing without timing-dependent scheduled sends.
      METABASE_ALERT_CRON: '0 0 0 1 1 ?',
    };
    const project = process.env.HUBOS_TEST_METABASE_PROJECT;
    if (project) {
      if (!['hubos-ci-metabase-test', 'hubos-v02-metabase-test'].includes(project)) throw new Error('Owned fixture project required');
      const probe = Bun.spawn(['docker', 'compose', '-p', project, '-f', '../../compose/metabase-test.compose.yaml',
        'exec', '-T', 'metabase', 'curl', '--fail', '--silent', '--max-time', '5', `${env.HUBOS_INTERNAL_URL}/healthz`],
      { stdout: 'ignore', stderr: 'ignore' });
      if (await probe.exited !== 0) throw new Error('METABASE_FIXTURE_CALLBACK_TRANSPORT_FAILED');
    }
    // Simulate the v0.1 tool account/database connection, then upgrade it in place.
    const legacy = loadMetabaseBootstrapConfig({ ...env, METABASE_HUBOS_DB_USER: base.username,
      METABASE_HUBOS_DB_PASSWORD: decodeURIComponent(base.password), METABASE_HUBOS_SCHEMAS: 'public,analytics' });
    await bootstrapMetabase({ config: legacy, logger: { log() {} }, onAuthenticated: async ({ client: connected, databaseId }) => {
      originalAccountId = (await connected('/api/user/current')).id;
      await connected(`/api/database/${databaseId}`, { method: 'PUT', body: { name: 'Existing operator reporting connection' } });
    } });
    first = await provisionMetabaseMonitoring({ store, env, logger: { log() {} } });
    const session = await (await fetch(`${metabaseUrl}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: env.METABASE_ADMIN_EMAIL, password: env.METABASE_ADMIN_PASSWORD }) })).json();
    sessionId = session.id;
    client = createMetabaseClient({ url: metabaseUrl, sessionId });
  }, 300000);

  afterAll(async () => {
    // Remove only this fixture datasource before dropping this test's random database/role.
    const database = store && (await store.db`SELECT external_id FROM managed_tool_resources WHERE tool = 'metabase' AND kind = 'database'`)[0];
    if (client && database) await client(`/api/database/${database.external_id}`, { method: 'DELETE' });
    await server?.stop(); await store?.close();
    if (databaseName && admin) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    if (roleName && admin && (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`).length) await admin.unsafe(`DROP ROLE ${roleName}`);
    await admin?.close();
  }, 30000);

  const resource = async (kind, key) => (await store.db`SELECT external_id FROM managed_tool_resources
    WHERE tool = 'metabase' AND kind = ${kind} AND resource_key = ${key}`)[0].external_id;
  const query = async (key, parameters = []) => client(`/api/card/${await resource('card', key)}/query`, { method: 'POST', body: { parameters } });
  const parameter = (name, value) => ({ type: name === 'date' ? 'date/all-options' : 'string/=', value,
    target: ['dimension', ['template-tag', name]] });

  test('fresh setup creates four complete dashboards; repeat preserves account, connection and custom edits', async () => {
    expect(first.dashboards).toHaveLength(4);
    const firstDashboard = await client(`/api/dashboard/${first.dashboards[0]}`);
    expect(firstDashboard.dashcards).toHaveLength(dashboards[0].cards.length);
    expect(firstDashboard.parameters.find((p) => p.slug === 'date').default).toBe('past30days~');
    for (const card of firstDashboard.dashcards) expect(card.parameter_mappings).toHaveLength(3);
    await client(`/api/dashboard/${firstDashboard.id}`, { method: 'PUT', body: { name: 'Operator customised operations' } });
    const genericCard = await resource('card', 'plugin-telemetry');
    await client(`/api/card/${genericCard}`, { method: 'PUT', body: { name: 'Operator customised telemetry' } });
    const before = await store.db`SELECT kind, resource_key, external_id FROM managed_tool_resources ORDER BY kind, resource_key`;
    const again = await provisionMetabaseMonitoring({ store, env, logger: { log() {} } });
    expect(again.dashboards).toEqual(first.dashboards);
    expect(await store.db`SELECT kind, resource_key, external_id FROM managed_tool_resources ORDER BY kind, resource_key`).toEqual(before);
    expect((await client(`/api/dashboard/${firstDashboard.id}`)).name).toBe('Operator customised operations');
    expect((await client(`/api/card/${genericCard}`)).name).toBe('Operator customised telemetry');
    expect((await client('/api/user/current')).id).toBe(originalAccountId);
    const connection = await client(`/api/database/${await resource('database', 'hubos')}`);
    expect(connection.details.user).toBe(roleName);
    expect(connection.name).toBe('Existing operator reporting connection');
    expect(connection.details['schema-filters-patterns']).toBe('analytics');
    const nativeNotifications = (await client('/api/notification')).filter((n) => n.payload_type === 'notification/card');
    expect(nativeNotifications).toHaveLength(8);
    expect((await client('/api/dashboard')).filter((d) => d.collection_id === firstDashboard.collection_id)).toHaveLength(4);
  }, 180000);

  test('all saved queries run; site/country/date controls include today and preserve empty/unknown evidence', async () => {
    for (const definition of questions) {
      const result = await query(definition.key, [parameter('date', 'past30days~')]);
      expect(result.status).toBe('completed');
    }
    const all = await query('operations-sites', [parameter('date', 'past30days~')]);
    expect(all.data.rows).toHaveLength(10);
    const uganda = await query('operations-sites', [parameter('country', ['UG']), parameter('date', 'past30days~')]);
    expect(uganda.data.rows).toHaveLength(5);
    expect(uganda.data.rows.every((row) => row[2] === 'UG')).toBe(true);
    expect((await query('operations-sites', [parameter('site', ['UG-DEMO-01'])])).data.rows).toHaveLength(1);
    expect((await query('operations-sites')).data.rows).toHaveLength(10);
    expect((await query('operations-sites', [parameter('country', ['ZZ'])])).data.rows).toHaveLength(0);
    expect((await query('operations-sites', [parameter('date', '2000-01-01~2000-01-31')])).data.rows).toHaveLength(0);
    const missing = await query('field-current');
    expect(missing.data.rows).toHaveLength(0);
    const siteId = stableId('site', 'UG-DEMO-01');
    // A new generic metric appears without changes to any reporting schema/query.
    const sourceId = stableId('source', 'ug-unifi');
    const target = (await store.getSourceContext(sourceId)).mappings[0];
    await store.ingestObservations([{ site_id: target.site_id, source_connection_id: sourceId, metric: 'environment.temperature.celsius',
      external_record_id: 'extra-plugin-fixture', value: 27.5, unit: 'celsius', quality: 'valid', observed_at: new Date(), attributes: { synthetic: true } }]);
    const generic = await query('plugin-telemetry');
    expect(generic.data.rows.some((row) => row.includes('environment.temperature.celsius') && row.includes(27.5))).toBe(true);
    await store.db`UPDATE status_snapshots SET observed_at = now() - interval '45 days' WHERE site_id = ${siteId}`;
    const stale = await query('operations-sites', [parameter('site', ['UG-DEMO-01']), parameter('date', 'past30days~')]);
    expect(stale.data.rows).toHaveLength(1);
    expect(stale.data.rows[0].slice(4, 7)).toEqual(['unknown', 'unknown', 'unknown']);
  }, 180000);

  test('private authenticated channel works while loopback and link-local targets stay blocked', async () => {
    const channel = await client(`/api/channel/${await resource('channel', 'incident-routing')}`);
    expect(await client('/api/channel/test', { method: 'POST', body: { type: 'channel/http', details: channel.details } })).toEqual({ ok: true });
    for (const blocked of ['http://127.0.0.1:13024/', 'http://169.254.254.254/']) {
      const response = await fetch(`${metabaseUrl}/api/channel/test`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-metabase-session': sessionId },
        body: JSON.stringify({ type: 'channel/http', details: { url: blocked, method: 'post', 'auth-method': 'none' } }) });
      expect(response.status).toBe(400);
      expect((await response.json()).message).toContain('internal hosting metadata');
    }
  }, 30000);

  test('native fault/recovery notifications route through authenticated webhooks and deliver one opening/recovery email', async () => {
    const site = (await store.listSites('UG'))[0];
    const sourceId = stableId('source', 'odk');
    const mapped = (await store.getSourceContext(sourceId)).mappings.find((m) => String(m.site_id) === String(site.id));
    expect(mapped).toBeDefined();
    const record = async (value) => store.ingestObservations([{ site_id: site.id, source_connection_id: sourceId,
      external_record_id: randomId(), metric: 'field.report.fault.count', value, quality: 'valid', unit: 'count',
      observed_at: new Date(), attributes: { synthetic: true } }]);
    const sendNative = async (key) => client(`/api/notification/${await resource('notification', key)}/send`, { method: 'POST', body: {} });
    await record(2);
    await sendNative('field-fault-active');
    try {
      await waitFor(async () => (await store.db`SELECT id FROM incidents WHERE rule_id = 'field-fault' AND site_id = ${site.id}`).length === 1);
    } catch (error) {
      throw new Error(`Native Metabase opening failed: callbacks=${JSON.stringify(callbacks)}; ${error.message}`);
    }
    const [incident] = await store.db`SELECT id FROM incidents WHERE rule_id = 'field-fault' AND site_id = ${site.id}`;
    await sendNative('field-fault-active');
    await sendNative('field-fault-active');
    await waitFor(async () => (await store.db`SELECT signal_count FROM incidents WHERE id = ${incident.id}`)[0].signal_count >= 1);
    expect((await store.db`SELECT id FROM notification_outbox WHERE incident_id = ${incident.id} AND event_kind = 'opened'`)).toHaveLength(1);
    // Silence/staleness does not generate explicit recovery.
    await store.db`UPDATE observations SET observed_at = now() - interval '1 day' WHERE metric = 'field.report.fault.count'`;
    expect((await query('alert-field-fault-healthy')).data.rows).toHaveLength(0);
    await sendNative('field-fault-healthy');
    expect((await store.db`SELECT status FROM incidents WHERE id = ${incident.id}`)[0].status).toBe('open');
    await record(0);
    await sendNative('field-fault-healthy');
    await waitFor(async () => (await store.db`SELECT status FROM incidents WHERE id = ${incident.id}`)[0].status === 'resolved');
    const sender = createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'local', HUBOS_LOCAL_SMTP_HOST: '127.0.0.1', HUBOS_LOCAL_SMTP_PORT: '11025' });
    expect((await deliverNextNotification({ store, send: sender })).delivered).toBe(true);
    expect((await deliverNextNotification({ store, send: sender })).delivered).toBe(true);
    expect(await deliverNextNotification({ store, send: sender })).toBeNull();
    const jobs = await store.db`SELECT id, event_kind, status FROM notification_outbox WHERE incident_id = ${incident.id}`;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.status === 'delivered')).toBe(true);
    const messages = await (await fetch('http://127.0.0.1:18025/api/v1/messages')).json();
    for (const job of jobs) expect(messages.messages.some((m) => m.MessageID?.includes(String(job.id)))).toBe(true);
    expect((await store.db`SELECT jsonb_typeof(details) AS type FROM incidents WHERE id = ${incident.id}`)[0].type).toBe('object');
  }, 120000);
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { randomId } from '../src/ids.js';
import { PostgresStore } from '../src/store/postgres.js';
import { bootstrapMetabase, loadMetabaseBootstrapConfig } from '../src/metabase/bootstrap.js';
import { createMetabaseClient } from '../src/metabase/client.js';
import { provisionMetabaseMonitoring } from '../src/metabase/provision.js';

const project = process.env.HUBOS_TEST_METABASE_UPGRADE_PROJECT;
const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
const suite = project && databaseUrl ? describe : describe.skip;
const metabaseUrl = 'http://127.0.0.1:13051';
const maintainedImage = 'metabase/metabase:v0.64.1.7@sha256:2db359bc1dfd857b0fd2414e4d1881f0b60ec50508760e999cc14bf438d8bae8';

async function compose(args, image = maintainedImage) {
  if (!['hubos-v02-metabase-upgrade-test', 'hubos-ci-metabase-upgrade-test'].includes(project)) throw new Error('Owned upgrade fixture required');
  const child = Bun.spawn(['docker', 'compose', '-p', project, '-f', '../../compose/metabase-upgrade-test.compose.yaml', ...args], {
    cwd: import.meta.dir + '/..', env: { ...process.env, HUBOS_TEST_METABASE_UPGRADE_IMAGE: image }, stdout: 'ignore', stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill(), 360000);
  try { if (await child.exited !== 0) throw new Error('METABASE_UPGRADE_FIXTURE_START_FAILED'); }
  finally { clearTimeout(timer); }
}

suite('Metabase application database upgrade (owned disposable fixture)', () => {
  let admin, store, databaseName, roleName, env;
  beforeAll(async () => {
    if (!['hubos-v02-metabase-upgrade-test', 'hubos-ci-metabase-upgrade-test'].includes(project)) throw new Error('Owned upgrade fixture required');
    const url = new URL(databaseUrl);
    if (url.pathname !== '/hubos_test' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Disposable local PostgreSQL required');
    const properties = await (await fetch(`${metabaseUrl}/api/session/properties`, { signal: AbortSignal.timeout(5000) })).json();
    if (properties.version?.tag !== 'v0.60.7' || !properties['setup-token']) throw new Error('Fresh isolated legacy Metabase fixture required');
    const suffix = randomId().replaceAll('-', '');
    databaseName = `hubos_meta_upgrade_${suffix}`;
    roleName = `meta_upgrade_analytics_${suffix}`;
    admin = new SQL({ url: databaseUrl, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    store = new PostgresStore({ databaseUrl: url.href });
    const original = await Bun.file(new URL('../../../db/migrations/202607160001_create_hubos_core.sql', import.meta.url)).text();
    await store.db.unsafe(original.split('-- migrate:down')[0]);
    const organisationId = randomId(), siteId = randomId();
    await store.db`INSERT INTO organisations (id, slug, name) VALUES (${organisationId}, 'existing-community', 'Existing community operations')`;
    await store.db`INSERT INTO sites (id, organisation_id, site_code, name, country_code)
      VALUES (${siteId}, ${organisationId}, 'EXISTING-COMMUNITY-01', 'Existing library', 'UG')`;
    env = { HUBOS_DATABASE_URL: url.href, HUBOS_DEMO_MODE: 'false', METABASE_URL: metabaseUrl,
      METABASE_ADMIN_EMAIL: 'upgrade-fixture@local.test', METABASE_ADMIN_PASSWORD: 'Fixture-Metabase-Upgrade-2026!',
      METABASE_HUBOS_DB_HOST: 'db', METABASE_HUBOS_DB_NAME: databaseName,
      METABASE_HUBOS_DB_USER: roleName, METABASE_HUBOS_DB_PASSWORD: 'Fixture-Upgrade-Reporting-2026!',
      METABASE_WEBHOOK_KEY: 'fixture-only-upgrade-webhook', METABASE_ALERT_CRON: '0 0 0 1 1 ?',
    };
  });
  afterAll(async () => {
    await store?.close();
    if (admin && databaseName) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    if (admin && roleName && (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`).length) await admin.unsafe(`DROP ROLE ${roleName}`);
    await admin?.close();
  });

  test('retains accounts, encrypted connections and custom resources across 0.60.7 → 0.64.1.7 and repeat provisioning', async () => {
    const url = new URL(env.HUBOS_DATABASE_URL);
    let accountId, databaseId, customCard, customDashboard;
    const legacyConfig = loadMetabaseBootstrapConfig({ ...env, METABASE_HUBOS_DB_USER: url.username,
      METABASE_HUBOS_DB_PASSWORD: decodeURIComponent(url.password) });
    await bootstrapMetabase({ config: legacyConfig, logger: { log() {} }, onAuthenticated: async ({ client, databaseId: connectedId }) => {
      accountId = (await client('/api/user/current')).id;
      databaseId = connectedId;
      await client(`/api/database/${databaseId}`, { method: 'PUT', body: { name: 'Custom existing reporting connection' } });
      customCard = await client('/api/card', { method: 'POST', body: {
        name: 'Custom existing site register', display: 'table', visualization_settings: {},
        dataset_query: { database: databaseId, type: 'native', native: { query: 'SELECT DISTINCT site_code FROM analytics.site_status_current ORDER BY site_code', 'template-tags': {} } },
      } });
      customDashboard = await client('/api/dashboard', { method: 'POST', body: { name: 'Custom existing community dashboard', description: 'Operator-owned fixture dashboard', parameters: [] } });
      await client(`/api/dashboard/${customDashboard.id}`, { method: 'PUT', body: { dashcards: [{ id: -1, card_id: customCard.id,
        row: 0, col: 0, size_x: 12, size_y: 6, series: [], parameter_mappings: [] }] } });
      const result = await client(`/api/card/${customCard.id}/query`, { method: 'POST', body: { parameters: [] } });
      expect(result.status).toBe('completed');
      expect(result.data.rows).toEqual([['EXISTING-COMMUNITY-01']]);
    } });
    // Graceful stop, same application DB volume and encryption key, new binary.
    await compose(['stop', '-t', '30', 'metabase']);
    await compose(['up', '-d', '--wait', '--wait-timeout', '300', 'metabase']);
    const properties = await (await fetch(`${metabaseUrl}/api/session/properties`, { signal: AbortSignal.timeout(5000) })).json();
    expect(properties.version.tag).toBe('v0.64.1.7');
    expect(properties['setup-token']).toBeFalsy();
    const sessionResponse = await fetch(`${metabaseUrl}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: env.METABASE_ADMIN_EMAIL, password: env.METABASE_ADMIN_PASSWORD }), signal: AbortSignal.timeout(15000) });
    expect(sessionResponse.ok).toBe(true);
    const session = await sessionResponse.json();
    const client = createMetabaseClient({ url: metabaseUrl, sessionId: session.id });
    expect((await client('/api/user/current')).id).toBe(accountId);
    expect((await client(`/api/database/${databaseId}`)).name).toBe('Custom existing reporting connection');
    const retained = await client(`/api/card/${customCard.id}/query`, { method: 'POST', body: { parameters: [] } });
    expect(retained.status).toBe('completed');
    expect(retained.data.rows).toEqual([['EXISTING-COMMUNITY-01']]);
    const directory = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql') && name > '202607160001_create_hubos_core.sql').sort()) {
      await store.db.unsafe((await Bun.file(new URL(file, directory)).text()).split('-- migrate:down')[0]);
    }
    const first = await provisionMetabaseMonitoring({ store, env, logger: { log() {} } });
    const again = await provisionMetabaseMonitoring({ store, env, logger: { log() {} } });
    expect(first.dashboards).toHaveLength(4);
    expect(again.dashboards).toEqual(first.dashboards);
    const connection = await client(`/api/database/${databaseId}`);
    expect(connection.details.user).toBe(roleName);
    expect(connection.name).toBe('Custom existing reporting connection');
    expect((await client('/api/database')).filter((database) => database.details?.dbname === databaseName)).toHaveLength(1);
    const dashboard = await client(`/api/dashboard/${customDashboard.id}`);
    expect(dashboard.name).toBe(customDashboard.name);
    expect(dashboard.description).toBe('Operator-owned fixture dashboard');
    expect(dashboard.dashcards).toHaveLength(1);
    expect(dashboard.dashcards[0].card_id).toBe(customCard.id);
    expect((await client(`/api/card/${customCard.id}`)).name).toBe(customCard.name);
    const finalResult = await client(`/api/card/${customCard.id}/query`, { method: 'POST', body: { parameters: [] } });
    expect(finalResult.status).toBe('completed');
    expect(finalResult.data.rows).toEqual([['EXISTING-COMMUNITY-01']]);
    expect((await client('/api/user/current')).id).toBe(accountId);
    expect((await store.listSites()).filter((site) => site.is_demo)).toHaveLength(0);
  }, 600000);
});

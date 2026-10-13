import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { buildDemoState } from '../src/demo/data.js';
import { MemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import { randomId } from '../src/ids.js';

const config = { version: 'test', demoMode: false, adminKey: 'fixture-site-admin', ingestKey: 'fixture-site-ingest' };
const headers = { 'content-type': 'application/json', 'x-hubos-admin-key': config.adminKey };

function siteContract(getStore, getOrganisation) {
  const request = (path, body, options = {}) => createApp({ store: getStore(), config })(new Request(`http://hubos.test${path}`, {
    method: options.method ?? 'POST', headers: options.headers ?? headers, body: JSON.stringify(body),
  }));
  const input = () => ({ organisation_id: getOrganisation(), site_code: `TEST-${randomId()}`, name: 'Community library', country_code: 'ug' });

  test('operators can find the organisation identity before registering the first site', async () => {
    const app = createApp({ store: getStore(), config });
    const response = await app(new Request('http://hubos.test/api/v1/organisations'));
    expect(response.status).toBe(200);
    const { organisations } = await response.json();
    expect(organisations.some((organisation) => organisation.id === getOrganisation())).toBe(true);
    expect(organisations.every((organisation) => organisation.name && organisation.slug && !Object.hasOwn(organisation, 'config'))).toBe(true);
  });

  test('operators create live sites with stable identities, explicit classification and no invented health', async () => {
    const body = { ...input(), site_type: 'library', timezone: 'Africa/Kampala', latitude: 0.32, longitude: 32.58 };
    expect((await request('/api/v1/sites', body, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await request('/api/v1/sites', body, { headers: { ...headers, origin: 'https://other.invalid' } })).status).toBe(403);
    const response = await request('/api/v1/sites', body);
    expect(response.status).toBe(201);
    const site = await response.json();
    expect(site).toMatchObject({ ...body, country_code: 'UG', is_demo: false });
    expect(site.id).toMatch(/^[0-9a-f-]{36}$/);
    const app = createApp({ store: getStore(), config });
    const status = await (await app(new Request(`http://hubos.test/api/v1/sites/${site.id}/status`))).json();
    expect(status.site.id).toBe(site.id);
    expect(status.statuses).toEqual([]);
    const duplicate = await request('/api/v1/sites', body);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'Site code already exists in this organisation' });
  });

  test('partial updates preserve canonical identity and allow explicitly clearing coordinates', async () => {
    const created = await request('/api/v1/sites', { ...input(), latitude: 0.32, longitude: 32.58 });
    expect(created.status).toBe(201);
    const original = await created.json();
    const patch = { name: 'Shared digital centre', site_type: 'community_centre', latitude: null };
    const changed = await request(`/api/v1/sites/${original.id}`, patch, { method: 'PATCH' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ...original, ...patch, updated_at: expect.anything() });
    for (const immutable of [{ id: randomId() }, { organisation_id: randomId() }, { site_code: 'REASSIGNED' }, { is_demo: true }]) {
      expect((await request(`/api/v1/sites/${original.id}`, immutable, { method: 'PATCH' })).status).toBe(422);
    }
    const concurrent = await Promise.all([
      request(`/api/v1/sites/${original.id}`, { name: 'Updated library' }, { method: 'PATCH' }),
      request(`/api/v1/sites/${original.id}`, { timezone: 'Africa/Luanda', country_code: 'ao' }, { method: 'PATCH' }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const status = await createApp({ store: getStore(), config })(new Request(`http://hubos.test/api/v1/sites/${original.id}/status`));
    expect((await status.json()).site).toMatchObject({ id: original.id, site_code: original.site_code,
      name: 'Updated library', timezone: 'Africa/Luanda', country_code: 'AO', latitude: null, longitude: 32.58 });
    expect((await request(`/api/v1/sites/${randomId()}`, { name: 'Missing' }, { method: 'PATCH' })).status).toBe(404);
    expect((await request('/api/v1/sites/not-a-uuid', { name: 'Invalid' }, { method: 'PATCH' })).status).toBe(422);
  });

  test('invalid metadata, unknown organisations and synthetic records in live mode are rejected without echoing input', async () => {
    const baseline = input();
    for (const invalid of [
      { organisation_id: 'not-a-uuid' }, { organisation_id: randomId() }, { latitude: 91 }, { longitude: -181 },
      { latitude: '0.32' }, { longitude: {} }, { timezone: 'not/a-timezone' }, { country_code: 'UGANDA' },
      { name: 'private-secret\nunsafe' }, { site_code: 'unsafe\u0000code' }, { site_type: 'School Name' },
      { is_demo: 'false' }, { is_demo: true }, { password: 'private-secret' },
    ]) {
      const rejected = await request('/api/v1/sites', { ...baseline, ...invalid });
      expect(rejected.status).toBe(422);
      expect(await rejected.text()).not.toContain('private-secret');
    }
    expect((await request('/api/v1/sites', [])).status).toBe(422);
    expect((await request(`/api/v1/sites/${randomId()}`, {}, { method: 'PATCH' })).status).toBe(422);
    const defaults = await request('/api/v1/sites', input());
    expect(defaults.status).toBe(201);
    expect(await defaults.json()).toMatchObject({ timezone: 'UTC', site_type: 'other', latitude: null, longitude: null, is_demo: false });
  });
}

describe('Protected site administration', () => {
  const store = new MemoryStore(buildDemoState(new Date()));
  siteContract(() => store, () => store.state.organisation.id);
  test('API documentation describes immutable identities and authentication', async () => {
    const app = createApp({ store, config });
    const description = await (await app(new Request('http://hubos.test/api/v1/openapi.json'))).json();
    expect(description.paths['/api/v1/sites'].post.security).toEqual([{ operatorBasic: [] }]);
    expect(description.components.schemas.SiteUpdate.additionalProperties).toBe(false);
    expect(Object.keys(description.components.schemas.SiteUpdate.properties)).not.toContain('site_code');
    expect(description.components.schemas.SiteCreate.required).toContain('organisation_id');
  });
});

const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Protected site administration with PostgreSQL (isolated integration)', () => {
  let admin, store, databaseName, organisationId;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (url.pathname !== '/hubos_test' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Disposable local hubos_test database required');
    }
    databaseName = `hubos_sites_${randomId().replaceAll('-', '')}`;
    organisationId = randomId();
    admin = new SQL({ url: databaseUrl, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    store = new PostgresStore({ databaseUrl: url.href });
    const directory = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await store.db.unsafe((await Bun.file(new URL(file, directory)).text()).split('-- migrate:down')[0]);
    }
    await store.db`INSERT INTO organisations (id, slug, name) VALUES (${organisationId}, 'site-admin-fixture', 'Site administration fixture')`;
  });
  afterAll(async () => {
    await store?.close();
    if (admin && databaseName) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin?.close();
  });
  siteContract(() => store, () => organisationId);
});

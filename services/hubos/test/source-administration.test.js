import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import { randomId } from '../src/ids.js';
import { runConnectorJob } from '../src/connector-runtime/runner.js';

const configuration = { version: 'test', demoMode: false, adminKey: 'source-fixture-admin', ingestKey: 'source-fixture-ingest' };
const adminHeaders = { 'content-type': 'application/json', 'x-hubos-admin-key': configuration.adminKey };
const otherOrganisationId = randomId();

function sourceContract(getStore, getOrganisation) {
  const call = (path, body, options = {}) => createApp({ store: getStore(), config: configuration })(new Request(`http://hubos.test${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: options.headers ?? adminHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const source = () => ({ organisation_id: getOrganisation(), name: `Controller ${randomId()}`, plugin_id: 'unifi',
    collection_mode: 'controller_pull', base_url: 'https://controller.example.invalid/proxy/network/integration/',
    config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' }, statistics_max_age_seconds: 300 } });

  test('operators register disabled sources through an installed plugin without returning credential settings', async () => {
    const metadata = source();
    expect((await call('/api/v1/source-connections', metadata, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
    const created = await call('/api/v1/source-connections', metadata);
    expect(created.status).toBe(201);
    const connection = await created.json();
    expect(connection).toMatchObject({ organisation_id: metadata.organisation_id, name: metadata.name,
      plugin_id: 'unifi', enabled: false, is_demo: false, status: 'disabled', last_success_at: null,
      poll_interval_seconds: 60, freshness_seconds: 300 });
    expect(connection.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(connection).not.toHaveProperty('config');
    const inventory = await (await call('/api/v1/source-connections')).json();
    expect(inventory.source_connections.find((item) => item.id === connection.id)).toMatchObject({ enabled: false, status: 'disabled' });
    expect(JSON.stringify(inventory)).not.toContain('FIXTURE_UNIFI_API_KEY');
    expect((await call('/api/v1/source-connections', metadata)).status).toBe(409);
  });

  test('registration rejects unsafe transport, literal secrets, malformed references and fictional collectors in live mode', async () => {
    const baseline = source();
    const before = await (await call('/api/v1/source-connections')).json();
    for (const changes of [
      { organisation_id: randomId() }, { plugin_id: 'not-installed' }, { collection_mode: 'webhook' },
      { base_url: 'http://remote.example.invalid/' }, { base_url: 'https://user:private-fixture-secret@controller.example.invalid/' },
      { base_url: 'https://controller.example.invalid/?token=private-fixture-secret' },
      { config: { ...baseline.config, password: 'private-fixture-secret' } },
      { config: { ...baseline.config, settings: { access_token: 'private-fixture-secret' } } },
      { config: { credential_refs: { apiKey: 'private-fixture-secret' } } },
      { config: { credential_refs: { apiKey: 'file:relative-path' } } },
      { config: { ...baseline.config, credential_refs: { apiKey: 'env:INVALID\nREFERENCE' } } },
      { config: { ...baseline.config, mapping_policy: 'canonical_site_ids' } },
      { config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' }, statistics_max_age_seconds: 1 } },
      { plugin_id: 'mock-school-telemetry', collection_mode: 'scheduled_pull', config: { demo: true } },
      { enabled: true }, { status: 'healthy' }, { last_success_at: new Date().toISOString() }, { is_demo: true },
      { poll_interval_seconds: 1 }, { freshness_seconds: 604801 },
    ]) {
      const rejected = await call('/api/v1/source-connections', { ...baseline, ...changes });
      expect(rejected.status).toBe(422);
      expect(await rejected.text()).not.toContain('private-fixture-secret');
    }
    expect((await (await call('/api/v1/source-connections')).json()).source_connections).toHaveLength(before.source_connections.length);
  });

  test('verified infrastructure identifiers remain scoped to their source, with several identifiers mapping to one site', async () => {
    const first = await (await call('/api/v1/source-connections', source())).json();
    const second = await (await call('/api/v1/source-connections', source())).json();
    const site = await (await call('/api/v1/sites', { organisation_id: getOrganisation(), site_code: `MAP-${randomId()}`,
      name: 'Community mapping fixture', country_code: 'UG' })).json();
    const path = `/api/v1/source-connections/${first.id}/mappings`;
    expect((await call(path, { site_id: site.id, external_id: 'remote-site-01', verified: true },
      { headers: { 'content-type': 'application/json' } })).status).toBe(401);
    const mapping = await call(path, { site_id: site.id, external_id: 'remote-site-01', verified: true });
    expect(mapping.status).toBe(201);
    expect(await mapping.json()).toMatchObject({ source_connection_id: first.id, entity_type: 'site', entity_id: site.id,
      external_id: 'remote-site-01', verified: true, mapping_method: 'operator_verified' });
    expect((await call(path, { site_id: site.id, external_id: 'remote-site-02', verified: true })).status).toBe(201);
    expect((await call(path, { site_id: site.id, external_id: 'remote-site-01', verified: true })).status).toBe(409);
    expect((await call(`/api/v1/source-connections/${second.id}/mappings`, { site_id: site.id, external_id: 'remote-site-01' })).status).toBe(201);
    const mapped = await (await call(path)).json();
    expect(mapped.mappings).toHaveLength(2);
    expect(new Set(mapped.mappings.map((item) => item.entity_id))).toEqual(new Set([site.id]));
    expect((await (await call(`/api/v1/source-connections/${second.id}/mappings`)).json()).mappings[0].verified).toBe(false);
    expect((await call(path, { site_id: randomId(), external_id: 'missing-site', verified: true })).status).toBe(422);
    expect((await call(path, { site_id: site.id, external_id: 'person@example.invalid', verified: true })).status).toBe(422);
  });

  test('operators edit disabled source settings without changing source identity or exposing its credential references', async () => {
    const original = await (await call('/api/v1/source-connections', source())).json();
    const path = `/api/v1/source-connections/${original.id}`;
    const changed = await call(path, { name: `Renamed controller ${randomId()}`, poll_interval_seconds: 120 }, { method: 'PATCH' });
    expect(changed.status).toBe(200);
    const updated = await changed.json();
    expect(updated).toMatchObject({ id: original.id, organisation_id: original.organisation_id, plugin_id: original.plugin_id,
      collection_mode: original.collection_mode, enabled: false, poll_interval_seconds: 120 });
    expect(updated).not.toHaveProperty('config');
    expect((await (await call('/api/v1/source-connections')).json()).source_connections.find((source) => source.id === original.id).name).toBe(updated.name);
    for (const immutable of [{ organisation_id: randomId() }, { plugin_id: 'headwind' }, { collection_mode: 'api_pull' }, { is_demo: true }]) {
      expect((await call(path, immutable, { method: 'PATCH' })).status).toBe(422);
    }
    expect((await call(path, { config: { password: 'private-fixture-secret' } }, { method: 'PATCH' })).status).toBe(422);
    expect((await call(`/api/v1/source-connections/${randomId()}`, { name: 'Missing' }, { method: 'PATCH' })).status).toBe(404);
  });

  test('mapping corrections require re-verification and cannot cross source organisations', async () => {
    const connection = await (await call('/api/v1/source-connections', source())).json();
    const createSite = async () => (await call('/api/v1/sites', { organisation_id: getOrganisation(), site_code: `REMAP-${randomId()}`,
      name: 'Mapping correction fixture', country_code: 'UG' })).json();
    const first = await createSite(), second = await createSite();
    const path = `/api/v1/source-connections/${connection.id}/mappings`;
    const original = await (await call(path, { site_id: first.id, external_id: 'correctable-site', verified: true })).json();
    const changed = await call(`${path}/${original.id}`, { site_id: second.id }, { method: 'PATCH' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id: original.id, external_id: original.external_id, entity_id: second.id, verified: false });
    const confirmed = await call(`${path}/${original.id}`, { verified: true }, { method: 'PATCH' });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ entity_id: second.id, verified: true });
    expect((await call(`${path}/${original.id}`, { external_id: 'replacement-id' }, { method: 'PATCH' })).status).toBe(422);
    expect((await call(`${path}/${original.id}`, { site_id: randomId(), verified: true }, { method: 'PATCH' })).status).toBe(422);
    const foreignSite = await (await call('/api/v1/sites', { organisation_id: otherOrganisationId, site_code: `FOREIGN-${randomId()}`,
      name: 'Other organisation fixture', country_code: 'AO' })).json();
    expect((await call(`${path}/${original.id}`, { site_id: foreignSite.id, verified: true }, { method: 'PATCH' })).status).toBe(422);
    expect((await call(path, { site_id: foreignSite.id, external_id: 'foreign-site', verified: true })).status).toBe(422);
    expect((await call(`/api/v1/source-connections/${randomId()}/mappings/${original.id}`, { verified: false }, { method: 'PATCH' })).status).toBe(404);
  });

  test('connection tests use the real read-only plugin client, redact upstream failures and leave collection state unchanged', async () => {
    let rejected = false;
    const methods = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      methods.push(request.method);
      if (rejected || request.headers.get('x-api-key') !== 'fixture-private-key') {
        return Response.json({ error: 'Never persist private-upstream-body' }, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === '/v1/info') return Response.json({ applicationVersion: '9.4.17', private: 'private-upstream-body' });
      if (path === '/v1/sites') return Response.json({ offset: 0, limit: 50, count: 0, totalCount: 0, data: [] });
      return new Response(null, { status: 405 });
    } });
    try {
      const metadata = { ...source(), base_url: server.url.href, config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' }, allow_local_http: true } };
      const created = await call('/api/v1/source-connections', metadata);
      expect(created.status).toBe(201);
      const sourceId = (await created.json()).id;
      const path = `/api/v1/source-connections/${sourceId}/test`;
      const app = createApp({ store: getStore(), config: configuration,
        resolveSecrets: async () => ({ apiKey: 'fixture-private-key' }) });
      const before = await (await call('/api/v1/source-connections')).json();
      const testConnection = () => app(new Request(`http://hubos.test${path}`, { method: 'POST', headers: adminHeaders }));
      expect((await call(path, {}, { headers: { 'content-type': 'application/json' } })).status).toBe(401);
      const connection = await testConnection();
      expect(connection.status).toBe(200);
      expect(await connection.json()).toMatchObject({ source_connection_id: sourceId, connected: true, scope: 'source_access_only' });
      expect((await app(new Request(`http://hubos.test${path}`, { method: 'POST', headers: {
        ...adminHeaders, 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
      rejected = true;
      const denied = await testConnection();
      expect(denied.status).toBe(502);
      expect(await denied.json()).toMatchObject({ connected: false, code: 'SOURCE_AUTHENTICATION_FAILED' });
      expect(methods.every((method) => method === 'GET')).toBe(true);
      expect(await (await call('/api/v1/source-connections')).json()).toEqual(before);
      expect(JSON.stringify(await (await call('/api/v1/overview')).json())).not.toContain('private-upstream-body');
    } finally { await server.stop(); }
  });

  test('activation rechecks settings and mapping verification if they change during the access test', async () => {
    let duringTest = async () => {};
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/v1/info') {
        await duringTest();
        return Response.json({ applicationVersion: '9.4.17' });
      }
      return Response.json({ offset: 0, limit: 50, count: 0, totalCount: 0, data: [] });
    } });
    try {
      const created = await (await call('/api/v1/source-connections', { ...source(), base_url: server.url.href,
        config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' }, allow_local_http: true } })).json();
      const path = `/api/v1/source-connections/${created.id}`;
      const site = await (await call('/api/v1/sites', { organisation_id: getOrganisation(), name: 'Activation race fixture',
        site_code: `RACE-${randomId()}`, country_code: 'UG' })).json();
      const mapping = await (await call(`${path}/mappings`, { site_id: site.id, external_id: 'fixture-site', verified: true })).json();
      const app = createApp({ store: getStore(), config: configuration, resolveSecrets: async () => ({ apiKey: 'fixture-private-key' }) });
      const enable = () => app(new Request(`http://hubos.test${path}/enable`, { method: 'POST', headers: adminHeaders, body: '{}' }));
      duringTest = async () => { expect((await call(`${path}/mappings/${mapping.id}`, { verified: false }, { method: 'PATCH' })).status).toBe(200); };
      expect((await enable()).status).toBe(422);
      expect((await call(`${path}/mappings/${mapping.id}`, { verified: true }, { method: 'PATCH' })).status).toBe(200);
      duringTest = async () => { expect((await call(path, { poll_interval_seconds: 120 }, { method: 'PATCH' })).status).toBe(200); };
      expect((await enable()).status).toBe(409);
      expect((await (await call('/api/v1/source-connections')).json()).source_connections.find((source) => source.id === created.id))
        .toMatchObject({ enabled: false, status: 'disabled', poll_interval_seconds: 120 });
      expect(await getStore().claimConnectorJob('race-fixture-worker', 300)).toBeNull();
    } finally { await server.stop(); }
  });

  test('configured sources enable one collector schedule, preserve repeat activation and can be paused safely', async () => {
    const remoteId = randomId();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.method !== 'GET' || request.headers.get('x-api-key') !== 'fixture-private-key') return new Response(null, { status: 401 });
      if (new URL(request.url).pathname === '/v1/info') return Response.json({ applicationVersion: '9.4.17' });
      const data = new URL(request.url).pathname === '/v1/sites'
        ? [{ id: remoteId, name: 'Controller fixture', internalReference: 'fixture' }] : [];
      return Response.json({ offset: 0, limit: 50, count: data.length, totalCount: data.length, data });
    } });
    try {
      const metadata = { ...source(), base_url: server.url.href, config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' }, allow_local_http: true } };
      const connection = await (await call('/api/v1/source-connections', metadata)).json();
      const sourceId = connection.id, path = `/api/v1/source-connections/${sourceId}`;
      const app = createApp({ store: getStore(), config: configuration, resolveSecrets: async () => ({ apiKey: 'fixture-private-key' }) });
      const action = (name) => app(new Request(`http://hubos.test${path}/${name}`, { method: 'POST', headers: adminHeaders, body: '{}' }));
      expect((await action('enable')).status).toBe(422);
      const site = await (await call('/api/v1/sites', { organisation_id: getOrganisation(), name: 'Scheduled community fixture',
        site_code: `RUN-${randomId()}`, country_code: 'UG' })).json();
      expect((await call(`${path}/mappings`, { site_id: site.id, external_id: remoteId, verified: true })).status).toBe(201);
      const activated = await action('enable');
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ id: sourceId, enabled: true, status: 'unknown', last_success_at: null });
      expect((await call(path, { name: 'Unsafe live edit' }, { method: 'PATCH' })).status).toBe(409);
      expect((await call(`${path}/mappings`, { site_id: site.id, external_id: randomId() })).status).toBe(409);
      const job = await getStore().claimConnectorJob('fixture-worker', 300);
      expect(job.source_connection_id).toBe(sourceId);
      expect((await action('enable')).status).toBe(200);
      expect(await getStore().claimConnectorJob('second-worker', 300)).toBeNull();
      const result = await runConnectorJob({ store: getStore(), job, workerId: 'fixture-worker',
        resolveSecrets: async () => ({ apiKey: 'fixture-private-key' }) });
      expect(result.accepted).toBe(10);
      const inventory = await (await call('/api/v1/source-connections')).json();
      expect(inventory.source_connections.find((source) => source.id === sourceId)).toMatchObject({ enabled: true, status: 'healthy' });
      expect((await (await call(`/api/v1/sites/${site.id}/status`)).json()).statuses).toEqual([]);
      const paused = await action('disable');
      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({ id: sourceId, enabled: false, status: 'disabled' });
      expect((await action('disable')).status).toBe(200);
      expect(await getStore().claimConnectorJob('paused-worker', 300)).toBeNull();
      expect((await action('enable')).status).toBe(200);
      const interrupted = await getStore().claimConnectorJob('interrupted-worker', 300);
      expect(interrupted.source_connection_id).toBe(sourceId);
      expect((await action('disable')).status).toBe(200);
      expect(await getStore().renewConnectorLease(interrupted)).toBe(false);
      await expect(runConnectorJob({ store: getStore(), job: interrupted, workerId: 'interrupted-worker',
        resolveSecrets: async () => ({ apiKey: 'fixture-private-key' }) })).rejects.toThrow('WORKER_LEASE_LOST');
      const late = await call('/api/v1/ingest/observations:batch', { observations: [{ site_id: site.id,
        source_connection_id: sourceId, external_entity_id: remoteId, external_record_id: 'late-paused-evidence',
        metric: 'network.devices.total.count', value: 2, observed_at: new Date().toISOString() }] },
      { headers: { 'content-type': 'application/json', 'x-hubos-ingest-key': configuration.ingestKey } });
      expect(late.status).toBe(202);
      expect(await late.json()).toMatchObject({ accepted: 0, rejected: 1 });
    } finally { await server.stop(); }
  });
  test('new collection after a mapping correction cannot revive status at the old site', async () => {
    const store = getStore();
    const first = await (await call('/api/v1/sites', { organisation_id: getOrganisation(), site_code: `BEFORE-${randomId()}`,
      name: 'Original community fixture', country_code: 'UG' })).json();
    const second = await (await call('/api/v1/sites', { organisation_id: getOrganisation(), site_code: `AFTER-${randomId()}`,
      name: 'Corrected community fixture', country_code: 'UG' })).json();
    const connection = await (await call('/api/v1/source-connections', source())).json();
    const path = `/api/v1/source-connections/${connection.id}/mappings`;
    const mapping = await (await call(path, { site_id: first.id, external_id: 'remapped-infrastructure', verified: true })).json();
    await store.enableSource(connection.id, (await store.getSourceAdminContext(connection.id)).source);
    await store.upsertStatuses([{ site_id: first.id, source_connection_id: connection.id, domain: 'connectivity',
      status: 'healthy', reason: 'Original fixture evidence', observed_at: new Date().toISOString(), rule_version: 'fixture' }]);
    await store.markSourceCollected(connection.id, new Date());
    expect((await (await call(`/api/v1/sites/${first.id}/status`)).json()).statuses[0].status).toBe('healthy');
    await store.disableSource(connection.id);
    expect((await call(`${path}/${mapping.id}`, { site_id: second.id, verified: true }, { method: 'PATCH' })).status).toBe(200);
    await store.enableSource(connection.id, (await store.getSourceAdminContext(connection.id)).source);
    await store.upsertStatuses([{ site_id: second.id, source_connection_id: connection.id, domain: 'connectivity',
      status: 'healthy', reason: 'Corrected fixture evidence', observed_at: new Date().toISOString(), rule_version: 'fixture' }]);
    await store.markSourceCollected(connection.id, new Date());
    expect((await (await call(`/api/v1/sites/${first.id}/status`)).json()).statuses[0].status).toBe('unknown');
    expect((await (await call(`/api/v1/sites/${second.id}/status`)).json()).statuses[0].status).toBe('healthy');
    const overview = await (await call('/api/v1/overview')).json();
    expect(overview.sites.find((site) => site.id === first.id).statuses[0].status).toBe('unknown');
    expect(overview.sites.find((site) => site.id === second.id).statuses[0].status).toBe('healthy');
  });
}

describe('Protected source administration', () => {
  const organisation = { id: randomId(), slug: 'source-fixture', name: 'Source fixture' };
  const store = new MemoryStore({ organisation, organisations: [organisation, { id: otherOrganisationId, slug: 'other-source-fixture', name: 'Other organisation' }],
    sites: [], sourceConnections: [], mappings: [], statuses: [], observations: [], incidents: [], connectorJobs: [] });
  sourceContract(() => store, () => store.state.organisation.id);

  test('API documentation describes protected operations, immutable identities and disabled-by-default registration', async () => {
    const app = createApp({ store, config: configuration });
    const document = await (await app(new Request('http://hubos.test/api/v1/openapi.json'))).json();
    for (const [path, method] of [
      ['/api/v1/source-connections', 'post'], ['/api/v1/source-connections/{sourceId}', 'patch'],
      ['/api/v1/source-connections/{sourceId}/mappings', 'get'], ['/api/v1/source-connections/{sourceId}/mappings', 'post'],
      ['/api/v1/source-connections/{sourceId}/mappings/{mappingId}', 'patch'],
      ...['test', 'enable', 'disable'].map((action) => [`/api/v1/source-connections/{sourceId}/${action}`, 'post']),
    ]) expect(document.paths[path][method].security).toEqual([{ operatorBasic: [] }]);
    expect(document.paths['/api/v1/source-connections'].post.summary).toContain('disabled');
    expect(document.components.schemas.SourceCreate.additionalProperties).toBe(false);
    expect(document.components.schemas.SourceCreate.properties).not.toHaveProperty('enabled');
    expect(document.components.schemas.SourceCreate.properties).not.toHaveProperty('last_success_at');
    expect(document.components.schemas.SourceUpdate.properties).not.toHaveProperty('plugin_id');
    expect(document.components.schemas.MappingUpdate.properties).not.toHaveProperty('external_id');
    expect(document.components.schemas.EmptyAction.maxProperties).toBe(0);
  });
});

const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Protected source administration with PostgreSQL (isolated integration)', () => {
  let admin, store, databaseName, organisationId;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (url.pathname !== '/hubos_test' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Disposable local PostgreSQL required');
    admin = new SQL({ url: databaseUrl, max: 1 });
    databaseName = `hubos_sources_${randomId().replaceAll('-', '')}`;
    organisationId = randomId();
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    store = new PostgresStore({ databaseUrl: url.href });
    const directory = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await store.db.unsafe((await Bun.file(new URL(file, directory)).text()).split('-- migrate:down')[0]);
    }
    await store.db`INSERT INTO organisations (id, slug, name) VALUES (${organisationId}, 'source-admin-fixture', 'Source administration fixture')`;
    await store.db`INSERT INTO organisations (id, slug, name) VALUES (${otherOrganisationId}, 'other-source-fixture', 'Other organisation')`;
  });
  afterAll(async () => {
    await store?.close();
    if (admin && databaseName) await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin?.close();
  });
  sourceContract(() => store, () => organisationId);
  test('correcting a paused mapping preserves the original association in public historical analytics', async () => {
    const app = createApp({ store, config: configuration });
    const call = async (path, method, body) => app(new Request(`http://hubos.test${path}`, { method, headers: adminHeaders, body: JSON.stringify(body) }));
    const createSite = async (code) => (await call('/api/v1/sites', 'POST', { organisation_id: organisationId, site_code: code,
      name: 'Historical mapping fixture', country_code: 'UG' })).json();
    const first = await createSite('HISTORY-ORIGINAL'), second = await createSite('HISTORY-CORRECTED');
    const source = await (await call('/api/v1/source-connections', 'POST', { organisation_id: organisationId, name: 'Historical source',
      plugin_id: 'unifi', collection_mode: 'controller_pull', config: { credential_refs: { apiKey: 'env:FIXTURE_UNIFI_API_KEY' } } })).json();
    const path = `/api/v1/source-connections/${source.id}/mappings`;
    const mapping = await (await call(path, 'POST', { site_id: first.id, external_id: 'historical-site', verified: true })).json();
    // Existing historical evidence is fixture input, not a new ingestion into a paused source.
    await store.db`INSERT INTO observations (site_id, source_connection_id, external_record_id, metric, value, observed_at)
      VALUES (${first.id}, ${source.id}, 'historical-record', 'network.devices.total.count', 3, now() - interval '2 days')`;
    expect((await call(`${path}/${mapping.id}`, 'PATCH', { site_id: second.id, verified: true })).status).toBe(200);
    const history = await store.db`SELECT site_code, value FROM analytics.telemetry WHERE source_connection_id = ${source.id}`;
    expect(history).toEqual([{ site_code: 'HISTORY-ORIGINAL', value: 3 }]);
  });
});

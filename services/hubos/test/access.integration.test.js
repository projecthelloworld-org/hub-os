import { describe, expect, test } from 'bun:test';
import { randomId, stableId } from '../src/ids.js';
const url = process.env.HUBOS_TEST_ACCESS_URL;
const suite = url ? describe : describe.skip;
suite('Caddy operator and machine credential boundary (owned disposable fixture)', () => {
  const auth = `Basic ${Buffer.from('fixture-operator:Fixture-Operator-2026!').toString('base64')}`;
  const call = async (path, options = {}) => {
    if (url !== 'http://127.0.0.1:13041/') throw new Error('Dedicated access fixture required');
    return fetch(new URL(path, url), { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options });
  };
  test('missing operator password hash fails closed without altering running authentication', async () => {
    if (url !== 'http://127.0.0.1:13041/') throw new Error('Dedicated access fixture required');
    const child = Bun.spawn(['docker', 'compose', '-p', 'hubos-v02-access-test', '-f', '../../compose/access-test.compose.yaml',
      'exec', '-T', '-e', 'HUBOS_OPERATOR_PASSWORD_HASH=', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    { cwd: import.meta.dir + '/..', stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 10000);
    const [code, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]); clearTimeout(timer);
    expect(code).toBe(1);
    expect(diagnostic.includes('username and password are required')).toBe(true);
    expect((await call('/', { headers: { authorization: auth } })).status).toBe(200);
  }, 15000);
  test('console, documentation and reporting require operator authentication, not API keys', async () => {
    for (const path of ['/', '/static/app.js', '/api/v1/sites', '/api/v1/openapi.json']) {
      const denied = await call(path);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain('Basic');
      expect((await call(path, { headers: { 'x-hubos-admin-key': 'fixture-only-admin-key',
        'x-hubos-ingest-key': 'fixture-only-ingest-key', 'x-hubos-webhook-key': 'fixture-only-webhook-key' } })).status).toBe(401);
      expect((await call(path, { headers: { authorization: auth } })).status).toBe(200);
    }
    expect((await call('/', { headers: { authorization: `Basic ${Buffer.from('fixture-operator:wrong').toString('base64')}` } })).status).toBe(401);
    expect((await call('/healthz')).status).toBe(200);
    expect((await call('/readyz')).status).toBe(200);
    for (const path of ['/api/v1/ingest/observations:batch', '/api/v1/source-connections/not-a-uuid/webhook',
      '/api/v1/source-connections/97f31e7e-d379-5d92-a5d7-507e6d56ef31/webhook/extra', '/api/v1/sites/']) {
      expect((await call(path, { headers: { 'x-hubos-webhook-key': 'fixture-only-webhook-key' } })).status).toBe(401);
    }
  });
  test('operator writes use an internal key; spoofed keys cannot bypass or override authenticated routing', async () => {
    // Read the actual fixture incident identifier, preserving the canonical model.
    const incidents = await (await call('/api/v1/incidents', { headers: { authorization: auth } })).json();
    expect(incidents.incidents.length).toBeGreaterThan(0);
    const path = `/api/v1/incidents/${incidents.incidents[0].id}/acknowledge`;
    const body = JSON.stringify({ owner: 'Fixture operations' });
    expect((await call(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hubos-admin-key': 'fixture-only-admin-key' }, body })).status).toBe(401);
    const accepted = await call(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth,
      'x-hubos-admin-key': 'spoofed-client-value' }, body });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).owner).toBe('Fixture operations');
    expect((await call(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth,
      origin: 'https://foreign.example.invalid' }, body })).status).toBe(403);
    expect((await call(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth,
      origin: url.slice(0, -1) }, body })).status).toBe(200);
  });
  test('browser Authorization and unrelated machine keys never reach the upstream API', async () => {
    const headers = new Headers({ authorization: auth, 'x-hubos-ingest-key': 'fixture-only-ingest-key',
      'x-hubos-webhook-key': 'fixture-only-webhook-key' });
    headers.append('x-hubos-admin-key', 'spoof-one'); headers.append('x-hubos-admin-key', 'spoof-two');
    expect(await (await call('/fixture/header-boundary', { headers })).json()).toEqual({
      authorizationPresent: false, adminKeyExpected: true, adminKeyPresent: true,
      ingestKeyPresent: false, webhookKeyPresent: false,
    });
    const health = await call('/healthz', { headers });
    expect(health.headers.get('x-fixture-authorization-present')).toBe('false');
    expect(health.headers.get('x-fixture-admin-key-present')).toBe('false');
  });
  test('site administration uses operator login and cannot transfer an existing site identity', async () => {
    const inventory = await (await call('/api/v1/sites', { headers: { authorization: auth } })).json();
    const metadata = { organisation_id: inventory.sites[0].organisation_id, site_code: `ACCESS-${randomId()}`,
      name: 'Access fixture library', country_code: 'UG', site_type: 'library' };
    const body = JSON.stringify(metadata), json = { 'content-type': 'application/json' };
    expect((await call('/api/v1/sites', { method: 'POST', headers: { ...json, 'x-hubos-admin-key': 'fixture-only-admin-key' }, body })).status).toBe(401);
    const created = await call('/api/v1/sites', { method: 'POST', headers: { ...json, authorization: auth }, body });
    expect(created.status).toBe(201);
    const site = await created.json();
    const path = `/api/v1/sites/${site.id}`;
    expect((await call(path, { method: 'PATCH', headers: { ...json, authorization: auth, origin: 'https://foreign.example.invalid' },
      body: JSON.stringify({ name: 'Rejected foreign change' }) })).status).toBe(403);
    const edited = await call(path, { method: 'PATCH', headers: { ...json, authorization: auth }, body: JSON.stringify({ name: 'Shared community centre' }) });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ id: site.id, site_code: metadata.site_code, name: 'Shared community centre', is_demo: false });
    expect((await call(path, { method: 'PATCH', headers: { ...json, authorization: auth }, body: JSON.stringify({ organisation_id: randomId() }) })).status).toBe(422);
  });
  test('machine ingestion and source hooks need their own keys, not operator credentials', async () => {
    const path = `/api/v1/source-connections/${stableId('source', 'access-fixture-kuma')}/webhook`;
    const body = '{}', headers = { 'content-type': 'application/json' };
    expect((await call(path, { method: 'POST', headers, body })).status).toBe(401);
    expect((await call(path, { method: 'POST', headers: { ...headers, authorization: auth }, body })).status).toBe(401);
    expect((await call(path, { method: 'POST', headers: { ...headers, 'x-hubos-ingest-key': 'fixture-only-ingest-key' }, body })).status).toBe(401);
    expect((await call(path, { method: 'POST', headers: { ...headers, 'x-hubos-webhook-key': 'fixture-only-webhook-key' }, body })).status).toBe(202);
    const ingest = '/api/v1/ingest/observations:batch';
    expect((await call(ingest, { method: 'POST', headers: { ...headers, authorization: auth }, body: '{"observations":[]}' })).status).toBe(401);
    expect((await call(ingest, { method: 'POST', headers: { ...headers, 'x-hubos-ingest-key': 'fixture-only-ingest-key' }, body: '{"observations":[]}' })).status).toBe(422);
    expect((await call(`${path}?ignored=1`, { method: 'GET', headers: { 'x-hubos-webhook-key': 'fixture-only-webhook-key' } })).status).toBe(401);
  });
});

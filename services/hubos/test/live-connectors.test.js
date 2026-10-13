import { describe, expect, test } from 'bun:test';
import unifi from '../src/connectors/unifi/index.js';
import headwind from '../src/connectors/headwind/index.js';
import odk from '../src/connectors/odk/index.js';
import { createHttpClient } from '../src/connector-runtime/http-client.js';
import { checkConnectorConformance } from '../src/connectors/conformance.js';

const site = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-13T12:00:00Z');
function context(plugin, mappings, handler) {
  const source = { id: '33333333-3333-4333-8333-333333333333', base_url: 'https://fixture.invalid/', is_demo: false };
  const config = { credential_refs: plugin === 'unifi' ? { apiKey: 'env:UNIFI_KEY' }
    : plugin === 'odk' ? { email: 'env:EMAIL', password: 'env:PASSWORD' } : { username: 'env:USERNAME', password: 'env:PASSWORD' } };
  return { source, config, mappings, observedAt: now, signal: new AbortController().signal,
    credentials: { apiKey: 'sentinel-key', username: 'reader', email: 'reader@example.invalid', password: 'sentinel-password' },
    requestJson: createHttpClient({ fetchImpl: async (url, options) => {
      const result = await handler(url, options);
      return result instanceof Response ? result : Response.json(result);
    } }) };
}
const mapping = (external_id = site, site_id = '44444444-4444-4444-8444-444444444444') => ({ external_id, site_id });
const page = (data, offset = 0, totalCount = data.length) => ({ data, offset, limit: 50, count: data.length, totalCount });
function unifiHandler({ version = '9.4.17', missingStats = false, stale = false, total = 1 } = {}) {
  return (url, options) => {
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.headers['x-api-key']).toBe('sentinel-key');
    if (url.pathname.endsWith('/info')) return { applicationVersion: version };
    if (url.pathname.endsWith('/sites')) return page([{ id: site, name: 'PII sentinel', internalReference: 'default' }]);
    if (url.pathname.endsWith('/devices')) return page([{ id: device, name: 'PII sentinel', model: 'Demo',
      macAddress: 'private-mac', ipAddress: 'private-ip', state: 'ONLINE', features: ['accessPoint'], interfaces: ['radios'],
      firmwareUpdatable: false, supported: true }], 0, total);
    if (url.pathname.endsWith('/clients')) return page([{ id: device, name: 'PII sentinel', type: 'WIRELESS',
      macAddress: 'private-mac', uplinkDeviceId: device, access: { type: 'DEFAULT' } }]);
    if (url.pathname.endsWith('/statistics/latest')) return missingStats ? { interfaces: {} }
      : { interfaces: { radios: [{ frequencyGHz: version.startsWith('9.') ? '5' : 5, txRetriesPct: 2 }] },
        lastHeartbeatAt: stale ? '2000-01-01T00:00:00Z' : now.toISOString(), cpuUtilizationPct: 25, uptimeSec: 3600 };
    throw new Error('Unexpected endpoint');
  };
}

describe('read-only live connector projections', () => {
  for (const version of ['9.1.120', '9.4.17', '10.6.106']) test(`UniFi ${version} contract; no WAN/people inference or PII persistence`, async () => {
    const ctx = context('unifi', [mapping()], unifiHandler({ version }));
    expect(await checkConnectorConformance(unifi, ctx)).toEqual({ envelopes: 1, observations: 12 });
    const raw = await unifi.collect(ctx);
    const normalized = await unifi.normalize(raw, ctx);
    const saved = JSON.stringify(normalized);
    for (const sentinel of ['PII sentinel', 'private-mac', 'private-ip', 'sentinel-key']) expect(saved).not.toContain(sentinel);
    expect(saved).not.toContain('connectivity.wan.available');
    expect(raw[0].records).toContainEqual(['network.clients.connected.count', 1]);
  });
  test('UniFi missing/stale optional statistics stay unavailable', async () => {
    for (const settings of [{ missingStats: true }, { stale: true }]) {
      const ctx = context('unifi', [mapping()], unifiHandler(settings));
      const raw = await unifi.collect(ctx);
      expect(raw[0].records).not.toContainEqual(['network.device.cpu.average.percent', 25, 'percent']);
      expect(raw[0].records).toContainEqual(['network.statistics.fresh_device.count', 0]);
    }
  });
  test('two UniFi controllers may use the same local site id without sharing source identity', async () => {
    const one = context('unifi', [mapping()], unifiHandler());
    const two = { ...context('unifi', [mapping()], unifiHandler()), source: { ...one.source, id: '55555555-5555-4555-8555-555555555555' } };
    const a = await unifi.normalize(await unifi.collect(one), one);
    const b = await unifi.normalize(await unifi.collect(two), two);
    expect(a.envelopes[0].source_connection_id).not.toBe(b.envelopes[0].source_connection_id);
  });
  test('UniFi rejects incomplete/repeated pages, unmapped sites and cloud fallback', async () => {
    await expect(unifi.collect(context('unifi', [mapping()], unifiHandler({ total: 2 })))).rejects.toThrow('INCOMPLETE');
    await expect(unifi.collect(context('unifi', [mapping(device)], unifiHandler()))).rejects.toThrow('UNMAPPED');
    const ctx = context('unifi', [mapping()], unifiHandler());
    ctx.source.base_url = 'https://api.ui.com/';
    await expect(unifi.collect(ctx)).rejects.toThrow('LOCAL_API_REQUIRED');
  });

  function headwindHandler({ conflicting = false, incomplete = false, expired = false } = {}) {
    let loginCount = 0, denied = false;
    return (url, options) => {
      if (url.pathname.endsWith('/jwt/login')) {
        loginCount++;
        expect(JSON.parse(options.body).password).not.toBe('sentinel-password');
        expect(JSON.parse(options.body).password).toMatch(/^[A-F0-9]{32}$/);
        return { id_token: `private-token-${loginCount}` };
      }
      if (expired && !denied) { denied = true; return new Response('secret', { status: 403 }); }
      if (url.pathname.endsWith('/groups/search')) return { status: 'OK', data: [{ id: 3 }, { id: 4 }] };
      if (url.pathname.endsWith('/configurations/list')) return { status: 'OK', data: [{ id: 7 }] };
      expect(url.pathname.endsWith('/devices/search')).toBe(true);
      expect(options.method).toBe('POST');
      return { status: 'OK', data: { configurations: { 7: { qrCodeKey: 'private-enrollment' } }, devices: {
        totalItemsCount: incomplete ? 5 : 3, items: [
          { id: 1, configurationId: 7, groups: [{ id: 3 }, ...(conflicting ? [{ id: 4 }] : [])], lastUpdate: now.getTime(), imei: 'private-imei' },
          { id: 2, configurationId: 7, groups: [{ id: 3 }], lastUpdate: now.getTime() - 90000000 },
          { id: 3, configurationId: 7, groups: [{ id: 3 }], lastUpdate: null },
        ] } } };
    };
  }
  test('Headwind check-ins are counted once despite several mappings to the same site; fields are projected', async () => {
    const ctx = context('headwind', [mapping('group:3'), mapping('configuration:7')], headwindHandler({ expired: true }));
    const rows = await headwind.collect(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].records).toEqual([['devices.inventory.count', 3], ['devices.check_in.recent.count', 1],
      ['devices.check_in.stale.count', 1], ['devices.check_in.unknown.count', 1]]);
    const saved = JSON.stringify(await headwind.normalize(rows, ctx));
    for (const sentinel of ['private-imei', 'private-enrollment', 'private-token', 'sentinel-password']) expect(saved).not.toContain(sentinel);
    expect(await checkConnectorConformance(headwind, ctx)).toEqual({ envelopes: 1, observations: 4 });
  });
  test('Headwind incomplete inventory and conflicting mappings cannot produce healthy counts', async () => {
    await expect(headwind.collect(context('headwind', [mapping('group:3')], headwindHandler({ incomplete: true })))).rejects.toThrow('INCOMPLETE');
    const mappings = [mapping('group:3'), mapping('group:4', '66666666-6666-4666-8666-666666666666')];
    await expect(headwind.collect(context('headwind', mappings, headwindHandler({ conflicting: true })))).rejects.toThrow('AMBIGUOUS');
    await expect(headwind.collect(context('headwind', [mapping('group:999')], headwindHandler()))).rejects.toThrow('UNMAPPED');
  });
  test('both clients use common redacted HTTP authentication, rate-limit and timeout handling', async () => {
    for (const plugin of [unifi, headwind]) {
      for (const [status, code] of [[401, 'SOURCE_AUTHENTICATION_FAILED'], [429, 'SOURCE_RATE_LIMITED']]) {
        const ctx = context(plugin === unifi ? 'unifi' : 'headwind', [], () => new Response('private-error', { status }));
        await expect(plugin.collect(ctx)).rejects.toThrow(code);
      }
      const ctx = context(plugin === unifi ? 'unifi' : 'headwind', [], () => ({ garbage: 'private-error' }));
      await expect(plugin.collect(ctx)).rejects.toThrow('SOURCE_MALFORMED_RESPONSE');
      ctx.source.base_url = 'http://remote.example.org/';
      await expect(plugin.collect(ctx)).rejects.toThrow('SOURCE_TLS_REQUIRED');
    }
  });

  function odkContext({ stale = false, missing = false, rejected = false, crossOrigin = false, empty = false, refresh = false, denied = false } = {}) {
    let expired = false;
    const ctx = context('odk', [mapping('UG-DEMO-01')], (url, options) => {
      if (url.pathname.endsWith('/sessions')) return { token: 'private-odk-token', expiresAt: '2026-10-14T12:00:00Z' };
      if (refresh && !expired) { expired = true; return new Response('private-error', { status: 401 }); }
      if (denied) return new Response('private-error', { status: 403 });
      if (url.pathname.endsWith('/forms/hubos-inspection')) return { xmlFormId: 'hubos-inspection', publishedAt: '2026-10-12T12:00:00Z' };
      expect(options.method ?? 'GET').toBe('GET');
      expect(url.searchParams.get('$select')).not.toContain('submitterName');
      expect(url.searchParams.get('$select')).not.toContain('deviceId');
      const row = { __id: 'uuid:fictional', __system: { submissionDate: now.toISOString(), updatedAt: null,
        reviewState: rejected ? 'rejected' : null, submitterName: 'PII sentinel', deviceId: 'private-device' },
        site_code: 'UG-DEMO-01', reported_at: stale ? '2026-09-01T00:00:00Z' : '2026-10-12T12:00:00Z',
        ...(missing ? {} : { fault_count: 0 }), private_question: 'PII sentinel' };
      if (crossOrigin) return { value: [row], '@odata.nextLink': 'https://attacker.invalid/?$skiptoken=private' };
      return { value: empty ? [] : [row] };
    });
    Object.assign(ctx.config, { project_id: 7, form_id: 'hubos-inspection', site_field: 'site_code', event_time_field: 'reported_at',
      evidence_max_age_seconds: 604800, approved_fields: { fault_count: 'field.report.fault.count' } });
    return ctx;
  }
  test('ODK preserves event time, approved zero, refreshes expired sessions, and projects private fields away', async () => {
    const ctx = odkContext({ refresh: true });
    expect(await checkConnectorConformance(odk, ctx)).toEqual({ envelopes: 1, observations: 1 });
    const rows = await odk.collect(ctx);
    expect(rows[0].observed_at).toBe('2026-10-12T12:00:00.000Z');
    expect(rows[0].records).toEqual([['field.report.fault.count', 0, 'count', 'valid']]);
    const output = JSON.stringify(await odk.normalize(rows, ctx));
    for (const sentinel of ['PII sentinel', 'private-device', 'private-odk-token', 'sentinel-password']) expect(output).not.toContain(sentinel);
  });
  test('ODK fresh polling does not turn old, missing, rejected or absent reports healthy', async () => {
    for (const settings of [{ stale: true }, { missing: true }, { rejected: true }, { empty: true }]) {
      const ctx = odkContext(settings);
      const rows = await odk.collect(ctx);
      expect(rows[0].records[0][3]).toBe('invalid');
      const result = await odk.normalize(rows, ctx);
      expect(result.statuses).toBeUndefined();
      expect(result.signals).toBeUndefined();
    }
  });
  test('ODK refuses cross-origin continuation, wrong permissions and unmapped identifiers', async () => {
    await expect(odk.collect(odkContext({ crossOrigin: true }))).rejects.toThrow('UNSAFE_CONTINUATION');
    await expect(odk.collect(odkContext({ denied: true }))).rejects.toThrow('AUTHENTICATION_FAILED');
    const ctx = odkContext(); ctx.mappings = [mapping('other-site')];
    await expect(odk.collect(ctx)).rejects.toThrow('UNMAPPED');
  });
  test('ODK configuration admits only approved leaves and known operational metrics', async () => {
    const ctx = odkContext();
    expect((await odk.validateConfig(ctx.config)).valid).toBe(true);
    expect((await odk.validateConfig({ ...ctx.config, approved_fields: { '__system': 'field.report.fault.count' } })).valid).toBe(false);
    expect((await odk.validateConfig({ ...ctx.config, approved_fields: { 'person/name': 'people.identity' } })).valid).toBe(false);
  });
});

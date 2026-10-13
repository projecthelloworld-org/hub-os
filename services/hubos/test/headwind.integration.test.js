import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import headwind from '../src/connectors/headwind/index.js';
import { createHttpClient } from '../src/connector-runtime/http-client.js';
import { checkConnectorConformance } from '../src/connectors/conformance.js';

const url = process.env.HUBOS_TEST_HEADWIND_URL;
const suite = url ? describe : describe.skip;
const md5 = (value) => createHash('md5').update(value).digest('hex').toUpperCase();

suite('Headwind Community actual read-only client (owned disposable fixture)', () => {
  let requestJson, adminToken, readerToken, groupId, configurationId, readerLogin, context, prefix;
  const adminPassword = 'Fixture-Headwind-Administrator-2026!';
  const readerPassword = 'Fixture-Headwind-Reader-2026!';
  const call = async (path, { method = 'GET', body, token } = {}) => requestJson(new URL(path, url), {
    method, headers: { accept: 'application/json', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ok = async (path, options) => {
    const result = await call(path, options);
    if (result?.status !== 'OK') throw new Error(`HEADWIND_FIXTURE_SETUP_REJECTED:${path}:${/^error\.[a-zA-Z0-9_.]+$/.test(result?.message ?? '') ? result.message : 'UNKNOWN'}`);
    return result.data;
  };
  const write = (path, body) => ok(`rest/private/${path}`, { method: 'PUT', body, token: adminToken });
  const read = (path) => ok(`rest/private/${path}`, { token: adminToken });

  beforeAll(async () => {
    if (url !== 'http://127.0.0.1:13031/') throw new Error('Dedicated disposable Headwind fixture required');
    requestJson = createHttpClient({ timeoutMs: 30000 });
    const options = await ok('rest/public/auth/options');
    if (options.recover !== false) throw new Error('Fixture external email must be disabled');
    if (process.env.HUBOS_TEST_HEADWIND_REUSE !== 'true') {
      const fresh = await ok('rest/public/auth/login', { method: 'POST', body: { login: 'admin', password: md5('admin') } });
      if (!fresh.passwordReset || !fresh.passwordResetToken) throw new Error('Fresh isolated Headwind volume required');
      await ok('rest/public/passwordReset/reset', { method: 'POST', body: {
        passwordResetToken: fresh.passwordResetToken, newPassword: md5(adminPassword),
      } });
    }
    adminToken = (await call('rest/public/jwt/login', { method: 'POST', body: { login: 'admin', password: md5(adminPassword) } })).id_token;
    if (!adminToken) throw new Error('HEADWIND_FIXTURE_ADMIN_LOGIN_FAILED');
    prefix = `hubos-${crypto.randomUUID().slice(0, 8)}`;
    await write('groups', { name: `${prefix}-community` });
    groupId = (await read('groups/search')).find((v) => v.name === `${prefix}-community`)?.id;
    const configuration = await write('configurations', { name: `${prefix}-config`, description: 'Fictional fixture only',
      applications: [], files: [], permissive: false, useDefaultDesignSettings: true, pushOptions: 'mqttAlarm', defaultFilePath: '/' });
    configurationId = configuration.id;
    if (!groupId || !configurationId) throw new Error('HEADWIND_FIXTURE_IDENTIFIER_MISSING');
    for (let index = 0; index < 51; index++) await write('devices', {
      number: `${prefix}-tablet-${index}`, description: 'PII-FIXTURE-SENTINEL', configurationId, groups: [{ id: groupId }],
    });
    // Inventory access is account/group-scoped; no edit permission is needed.
    await write('roles', { name: `${prefix}-reader-role`, description: 'Fixture read-only inventory role', permissions: [] });
    const role = (await read('roles/all')).find((v) => v.name === `${prefix}-reader-role`);
    readerLogin = `${prefix}-reader`;
    const user = { login: readerLogin, name: 'Fictional HubOS reader', email: `${prefix}@example.invalid`, userRole: { id: role.id },
      allDevicesAvailable: false, allConfigAvailable: false, groups: [{ id: groupId }], configurations: [{ id: configurationId }] };
    await write('users', { ...user, newPassword: md5(readerPassword) });
    const reader = (await read(`users/all?filter=${readerLogin}`)).find((v) => v.login === readerLogin);
    if (!reader) throw new Error('HEADWIND_FIXTURE_READER_MISSING');
    await write('users', { ...user, id: reader.id, customerId: reader.customerId }); // Preserve server-assigned customer scope.
    readerToken = (await call('rest/public/jwt/login', { method: 'POST', body: { login: readerLogin, password: md5(readerPassword) } })).id_token;
    context = { source: { id: crypto.randomUUID(), base_url: url, is_demo: true },
      config: { allow_local_http: true, check_in_max_age_seconds: 60,
        credential_refs: { username: 'env:FIXTURE_READER', password: 'env:FIXTURE_PASSWORD' } },
      credentials: { username: readerLogin, password: readerPassword }, requestJson,
      mappings: [{ external_id: `group:${groupId}`, site_id: crypto.randomUUID() }], observedAt: new Date(), signal: new AbortController().signal };
  }, 180000);

  test('minimum account reads paginated inventory and lookups, but cannot create a device', async () => {
    expect(await headwind.health(context)).toMatchObject({ status: 'healthy' });
    context.observedAt = new Date();
    const rows = await headwind.collect(context);
    expect(rows[0].records).toContainEqual(['devices.inventory.count', 51]);
    expect(rows[0].records).toContainEqual(['devices.check_in.unknown.count', 51]);
    expect(await checkConnectorConformance(headwind, context)).toEqual({ envelopes: 1, observations: 4 });
    const output = JSON.stringify(await headwind.normalize(rows, context));
    for (const value of ['PII-FIXTURE-SENTINEL', `${prefix}-tablet`, readerPassword, readerToken]) expect(output).not.toContain(value);
    const denied = await call('rest/private/devices', { method: 'PUT', token: readerToken,
      body: { number: `${prefix}-MUST-NOT-EXIST`, configurationId, groups: [{ id: groupId }] } });
    expect(denied.status).toBe('ERROR');
    expect([null, 'error.permission.denied']).toContain(denied.message);
    const inventory = await ok('rest/private/devices/search', { method: 'POST', token: adminToken,
      body: { pageSize: 50, pageNum: 1, value: `${prefix}-MUST-NOT-EXIST`, sortBy: 'NUMBER', sortDir: 'ASC' } });
    expect(inventory.devices.totalItemsCount).toBe(0);
    await expect(call('rest/private/groups/search')).rejects.toThrow('SOURCE_AUTHENTICATION_FAILED');
  }, 60000);

  test('actual server receipt timestamps distinguish recent, stale and never-checked-in devices', async () => {
    await ok('rest/public/sync/info', { method: 'POST', body: { deviceId: `${prefix}-tablet-0` } });
    // Child test runs asynchronously; the assistant can continue independent work during this real-age check.
    await Bun.sleep(61000);
    await ok('rest/public/sync/info', { method: 'POST', body: { deviceId: `${prefix}-tablet-1` } });
    context.observedAt = new Date();
    const rows = await headwind.collect(context);
    expect(rows[0].records).toContainEqual(['devices.check_in.recent.count', 1]);
    expect(rows[0].records).toContainEqual(['devices.check_in.stale.count', 1]);
    expect(rows[0].records).toContainEqual(['devices.check_in.unknown.count', 49]);
    await expect(headwind.health({ ...context, credentials: { ...context.credentials, password: 'wrong-fixture-password' } })).rejects.toThrow('SOURCE_AUTHENTICATION_FAILED');
  }, 100000);
});

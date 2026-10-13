import { beforeAll, describe, expect, test } from 'bun:test';
import odk from '../src/connectors/odk/index.js';
import { createHttpClient } from '../src/connector-runtime/http-client.js';
import { checkConnectorConformance } from '../src/connectors/conformance.js';

const url = process.env.HUBOS_TEST_ODK_URL;
const suite = url ? describe : describe.skip;
suite('ODK Central actual read-only client (owned API-only fixture)', () => {
  let requestJson, adminToken, viewerToken, context, projectId, receipt, eventTime;
  const formId = 'hubos-inspection', viewerPassword = 'Fixture-ODK-Viewer-2026!';
  const call = (path, { method = 'GET', body, token = adminToken, xml } = {}) => requestJson(new URL(path, url), {
    method, headers: { accept: 'application/json', 'content-type': xml ? 'application/xml' : 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: xml ? body : JSON.stringify(body) }),
  });
  const login = async (email, password) => (await call('v1/sessions', { method: 'POST', token: null, body: { email, password } })).token;
  const submit = async (date, faults = 0, devices = 8) => call(`v1/projects/${projectId}/forms/${formId}/submissions`, {
    method: 'POST', xml: true, body: `<data id="${formId}" version="2026101301"><site_code>fixture-community</site_code><reported_at>${date}</reported_at><fault_count>${faults}</fault_count><usable_devices>${devices ?? ''}</usable_devices><connectivity_available>1</connectivity_available><power_available>1</power_available><private_note>PII-ODK-FIXTURE-SENTINEL</private_note><meta><instanceID>uuid:${crypto.randomUUID()}</instanceID></meta></data>`,
  });
  beforeAll(async () => {
    if (url !== 'http://service:8383/' || process.env.HUBOS_TEST_ODK_OWNED_FIXTURE !== 'hubos-v02-odk-test') {
      throw new Error('Dedicated internal disposable ODK fixture required');
    }
    requestJson = createHttpClient({ timeoutMs: 30000 });
    adminToken = await login(process.env.HUBOS_TEST_ODK_ADMIN_EMAIL, process.env.HUBOS_TEST_ODK_ADMIN_PASSWORD);
    if (!adminToken) throw new Error('ODK_FIXTURE_ADMIN_LOGIN_FAILED');
    await call('v1/config/analytics', { method: 'POST', body: { enabled: false } });
    if ((await call('v1/config/analytics')).value?.enabled !== false) throw new Error('ODK_FIXTURE_ANALYTICS_ENABLED');
    projectId = (await call('v1/projects', { method: 'POST', body: { name: `HubOS fictional ${crypto.randomUUID()}` } })).id;
    // Extend only this disposable copy to prove an unapproved field is excluded.
    // The distributed inspection form itself has no personal/free-text field.
    const form = (await Bun.file('/forms/hubos-inspection.xml').text())
      .replace('<meta><instanceID/></meta>', '<private_note/><meta><instanceID/></meta>')
      .replace('<bind nodeset="/data/site_code"', '<bind nodeset="/data/private_note" type="string"/><bind nodeset="/data/site_code"');
    await call(`v1/projects/${projectId}/forms?publish=true`, { method: 'POST', xml: true, body: form });
    const email = `viewer-${crypto.randomUUID()}@example.invalid`;
    const viewer = await call('v1/users', { method: 'POST', body: { email, password: viewerPassword } });
    await call(`v1/projects/${projectId}/assignments/viewer/${viewer.id}`, { method: 'POST' });
    viewerToken = await login(email, viewerPassword);
    eventTime = new Date(Date.now() - 3600000).toISOString();
    // Two pages with increasing truthful report times; latest report is a fault.
    for (let index = 0; index < 51; index++) {
      receipt = await submit(new Date(Date.parse(eventTime) - (50 - index) * 1000).toISOString(), index === 50 ? 2 : 0);
    }
    context = { source: { id: crypto.randomUUID(), base_url: url, is_demo: true },
      config: { allow_local_http: true, project_id: projectId, form_id: formId, site_field: 'site_code', event_time_field: 'reported_at',
        approved_fields: { fault_count: 'field.report.fault.count', usable_devices: 'field.report.devices.usable.count',
          connectivity_available: 'field.report.connectivity.available', power_available: 'field.report.power.available' },
        evidence_max_age_seconds: 604800, credential_refs: { email: 'env:FIXTURE_EMAIL', password: 'env:FIXTURE_PASSWORD' } },
      credentials: { email, password: viewerPassword }, requestJson,
      mappings: [{ external_id: 'fixture-community', site_id: crypto.randomUUID() }], observedAt: new Date(), signal: new AbortController().signal };
  }, 180000);

  test('viewer reads real paginated OData with approved fields and cannot change forms', async () => {
    expect(await odk.health(context)).toEqual({ status: 'healthy' });
    const requests = [], pages = [];
    const traced = { ...context, requestJson: async (target, options) => {
      requests.push({ url: new URL(target), method: options?.method ?? 'GET' });
      const result = await requestJson(target, options);
      if (new URL(target).pathname.endsWith('.svc/Submissions')) pages.push(JSON.stringify(result));
      return result;
    } };
    const rows = await odk.collect(traced);
    expect(requests.filter((v) => v.url.pathname.endsWith('.svc/Submissions'))).toHaveLength(2);
    expect(requests.filter((v) => v.method !== 'GET').map((v) => v.url.pathname)).toEqual(['/v1/sessions']);
    for (const request of requests.filter((v) => v.url.pathname.endsWith('.svc/Submissions'))) {
      expect(request.url.origin).toBe('http://service:8383');
      expect(request.url.searchParams.get('$select')).not.toMatch(/submitter|deviceId|password|private_note/);
    }
    expect(pages.join('')).not.toContain('PII-ODK-FIXTURE-SENTINEL');
    expect(rows[0].observed_at).toBe(eventTime);
    expect(Date.parse(receipt.createdAt)).toBeGreaterThan(Date.parse(eventTime));
    expect(rows[0].records).toContainEqual(['field.report.fault.count', 2, 'count', 'valid']);
    expect(await checkConnectorConformance(odk, context)).toEqual({ envelopes: 1, observations: 4 });
    const projection = JSON.stringify(await odk.normalize(rows, context));
    for (const secret of [viewerPassword, viewerToken, adminToken, context.credentials.email, 'PII-ODK-FIXTURE-SENTINEL']) expect(projection).not.toContain(secret);
    await expect(call(`v1/projects/${projectId}/forms/${formId}`, { method: 'PATCH', token: viewerToken, body: { state: 'closed' } })).rejects.toMatchObject({ httpStatus: 403 });
    expect((await call(`v1/projects/${projectId}/forms/${formId}`)).state).toBe('open');
  }, 60000);

  test('explicit healthy evidence records recovery; missing answers and stale reports are unavailable', async () => {
    const healthyTime = new Date(Date.now() - 1800000).toISOString();
    await submit(healthyTime, 0);
    context.observedAt = new Date();
    const healthy = await odk.collect(context);
    expect(healthy[0].records).toContainEqual(['field.report.fault.count', 0, 'count', 'valid']);
    expect(healthy[0].observed_at).toBe(healthyTime);
    const stale = await odk.collect({ ...context, config: { ...context.config, evidence_max_age_seconds: 60 } });
    expect(stale[0].records.every((v) => v[3] === 'invalid')).toBe(true);
    await submit(new Date(Date.now() - 900000).toISOString(), 0, null);
    context.observedAt = new Date();
    const missing = await odk.collect(context);
    expect(missing[0].records).toContainEqual(['field.report.devices.usable.count', 0, 'count', 'invalid']);
    expect(missing[0].records).toContainEqual(['field.report.fault.count', 0, 'count', 'valid']);
    await expect(odk.health({ ...context, credentials: { ...context.credentials, password: 'wrong-fixture-password' } })).rejects.toThrow('SOURCE_AUTHENTICATION_FAILED');
    const unmapped = { ...context, mappings: [{ external_id: 'not-this-site', site_id: crypto.randomUUID() }] };
    await expect(odk.collect(unmapped)).rejects.toThrow('UNMAPPED_IDENTIFIER');
    const receiptOnly = await odk.collect({ ...context, config: { ...context.config, event_time_field: undefined } });
    expect(Date.parse(receiptOnly[0].observed_at)).toBeGreaterThan(Date.parse(healthyTime));
  }, 60000);
});

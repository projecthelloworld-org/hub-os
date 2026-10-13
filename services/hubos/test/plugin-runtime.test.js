import { describe, expect, test } from 'bun:test';
import { loadConnectorRegistry, createConnectorRegistry } from '../src/connectors/loader.js';
import { mockSchoolConnector } from '../src/connectors/mock-school/index.js';
import { runConnectorJob } from '../src/connector-runtime/runner.js';
import { createHttpClient, CollectionError } from '../src/connector-runtime/http-client.js';
import { resolveCredentials } from '../src/connector-runtime/secrets.js';
import { checkConnectorConformance } from '../src/connectors/conformance.js';
import { sanitizeAttributes, safeError } from '../src/privacy.js';
import { MemoryStore } from '../src/store/memory.js';
import { buildDemoState } from '../src/demo/data.js';
import { loadConfig } from '../src/config.js';

async function claimedStore() {
  const store = new MemoryStore(buildDemoState(new Date(Date.now() - 60000)));
  const job = await store.claimConnectorJob('test-worker', 300);
  return { store, job };
}

describe('trusted source-driven plugin runtime', () => {
  test('requires leases long enough for the runtime heartbeat', () => {
    expect(() => loadConfig({ HUBOS_WORKER_LEASE_SECONDS: '10' })).toThrow('30');
  });
  test('loads explicitly enabled local packages, ignores disabled packages, and rejects duplicate ids', async () => {
    const registry = await loadConnectorRegistry({ pluginConfigPath: new URL('fixtures/plugins-enabled.json', import.meta.url).pathname });
    expect(registry.getConnector('starter-environment')).not.toBeNull();
    const manifests = registry.listConnectorManifests();
    manifests[0].id = 'mutated';
    expect(registry.getConnector('mutated')).toBeNull();
    expect(() => createConnectorRegistry([mockSchoolConnector, mockSchoolConnector])).toThrow('Duplicate');
    expect(() => createConnectorRegistry([{ ...mockSchoolConnector,
      manifest: { ...mockSchoolConnector.manifest, protocolVersion: '2.0' } }])).toThrow('protocol');
  });

  test('supports a new metric through the same runner, mapping and evidence store', async () => {
    const registry = await loadConnectorRegistry({ pluginConfigPath: new URL('fixtures/plugins-enabled.json', import.meta.url).pathname });
    const { store, job } = await claimedStore();
    const source = store.state.sourceConnections[0];
    source.plugin_id = 'starter-environment';
    source.config = { demo: true, temperature: 27.5 };
    job.connector_id = source.plugin_id;
    job.source_connection_id = source.id;
    const [target] = await store.listConnectorTargets(job);
    const context = { ...target, config: source.config, observedAt: new Date(), credentials: {} };
    const result = await checkConnectorConformance(registry.getConnector(source.plugin_id), context);
    expect(result.observations).toBe(3);
    const summary = await runConnectorJob({ store, job, workerId: 'test-worker', registry, demoMode: true });
    expect(summary.accepted).toBe(3);
    expect(store.state.observations.filter((item) => item.metric === 'environment.temperature.celsius')).toHaveLength(3);
    expect(store.state.rawPayloads[0].payload.observations[0].attributes.synthetic).toBe(true);
  });

  test('runs the mixed ten-site demo idempotently using source-driven targets', async () => {
    const { store, job } = await claimedStore();
    const observedAt = new Date();
    const run = () => runConnectorJob({ store, job, workerId: 'test-worker', observedAt, demoMode: true });
    const first = await run();
    expect(first.accepted).toBe(90);
    // Reclaim the same scheduled job rather than bypassing the lease token.
    store.state.connectorJobs[0].next_run_at = new Date(0).toISOString();
    const again = await store.claimConnectorJob('test-worker', 300);
    const second = await runConnectorJob({ store, job: again, workerId: 'test-worker', observedAt, demoMode: true });
    expect(second.duplicates).toBe(90);
    expect(store.state.sites.filter((site) => site.country_code === 'UG')).toHaveLength(5);
    expect(new Set(store.state.sites.map((site) => site.site_type))).toEqual(new Set(['school', 'community_centre', 'library']));
    expect(store.state.rawPayloads).toHaveLength(40);
  });

  test('configuration errors and missing plugins fail claimed jobs without leaking messages', async () => {
    for (const kind of ['invalid-config', 'missing-plugin']) {
      const { store, job } = await claimedStore();
      if (kind === 'missing-plugin') job.connector_id = 'not-installed';
      else store.state.sourceConnections[0].config.demo = false;
      await expect(runConnectorJob({ store, job, workerId: 'test-worker', demoMode: true })).rejects.toThrow();
      expect(store.state.connectorJobs[0].status).toBe('failed');
      expect(store.state.connectorJobs[0].attempts).toBe(1);
      expect(store.state.connectorRuns[0].status).toBe('failed');
      expect(store.state.connectorJobs[0].last_error).toBe(kind === 'missing-plugin' ? 'PLUGIN_NOT_INSTALLED' : 'INVALID_CONNECTOR_CONFIGURATION');
    }
  });

  test('live mode refuses fictional sources', async () => {
    const { store, job } = await claimedStore();
    await expect(runConnectorJob({ store, job, workerId: 'test-worker' })).rejects.toThrow('DEMO_SOURCE_DISABLED');
    expect(store.state.rawPayloads).toBeUndefined();
  });

  test('reclaims abandoned running jobs and fences old completion/failure', async () => {
    const { store, job } = await claimedStore();
    const runId = await store.startConnectorRun(job, 'test-worker');
    store.state.connectorJobs[0].locked_at = new Date(0).toISOString();
    const reclaimed = await store.claimConnectorJob('replacement', 300);
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.lease_token).not.toBe(job.lease_token);
    await store.completeConnectorJob(job);
    await store.failConnectorJob(job, new Error('password=never-store-this'));
    expect(store.state.connectorJobs[0].status).toBe('running');
    expect(await store.renewConnectorLease(job)).toBe(false);
    await store.finishConnectorRun(runId, {});
    expect(store.state.connectorRuns[0].error).toBe('WORKER_LEASE_EXPIRED');
    await store.completeConnectorJob(reclaimed);
    expect(store.state.connectorJobs[0].status).toBe('pending');
  });

  test('cancels an overlong collector and preserves its durable retry state', async () => {
    const { store, job } = await claimedStore();
    const connector = { ...mockSchoolConnector, collect: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled: secret')), { once: true });
    }) };
    await expect(runConnectorJob({ store, job, workerId: 'test-worker', demoMode: true,
      registry: createConnectorRegistry([connector]), maximumDurationMs: 10 })).rejects.toThrow('COLLECTION_TIMEOUT');
    expect(store.state.connectorJobs[0].status).toBe('failed');
    expect(store.state.connectorJobs[0].last_error).toBe('COLLECTION_TIMEOUT');
    expect(store.state.rawPayloads).toBeUndefined();
  });

  test('unmapped identifiers never persist raw vendor payloads or promote healthy status', async () => {
    const { store, job } = await claimedStore();
    const original = mockSchoolConnector;
    const connector = { ...original, async collect(context) {
      return { ...(await original.collect(context)), password: 'secret-value', person: 'Learner Name' };
    }, async normalize(raw) {
      const output = await original.normalize(raw);
      output.envelopes[0].external_entity.id = 'unknown-site';
      return output;
    } };
    const before = structuredClone(store.state.statuses);
    await expect(runConnectorJob({ store, job, workerId: 'test-worker', demoMode: true,
      registry: createConnectorRegistry([connector]) })).rejects.toThrow('UNMAPPED_IDENTIFIER');
    expect(store.state.rawPayloads).toBeUndefined();
    expect(store.state.statuses).toEqual(before);
  });

  test('keeps old status evidence from overriding a newer observation', async () => {
    const store = new MemoryStore(buildDemoState(new Date()));
    const status = store.state.statuses[0];
    await store.upsertStatuses([{ ...status, status: 'critical', observed_at: '2000-01-01T00:00:00Z' }]);
    expect(store.state.statuses[0].status).toBe('healthy');
    expect(store.state.statuses).toHaveLength(30);
  });

  test('projects numeric evidence and excludes personal/secret/browsing fields before storage', async () => {
    const { store, job } = await claimedStore();
    const connector = { ...mockSchoolConnector, async collect(context) {
      return { ...(await mockSchoolConnector.collect(context)), deviceName: 'Learner', imei: '123456789', password: 'secret' };
    }, async normalize(raw) {
      const result = await mockSchoolConnector.normalize(raw);
      result.statuses.forEach((status) => { status.reason = 'Learner IMEI 123456789 secret'; });
      result.envelopes.forEach((envelope) => envelope.records.forEach((record) => {
        record.attributes = { ...record.attributes, browsing: 'private-url', token: 'secret', name: 'Learner' };
      }));
      return result;
    } };
    await runConnectorJob({ store, job, workerId: 'test-worker', demoMode: true, registry: createConnectorRegistry([connector]) });
    const persisted = JSON.stringify(store.state.rawPayloads);
    for (const sensitive of ['Learner', '123456789', 'secret', 'private-url']) expect(persisted).not.toContain(sensitive);
    expect(JSON.stringify(store.state.statuses)).not.toContain('Learner');
    expect(safeError(new Error('password=secret'))).toBe('COLLECTION_FAILED');
    expect(sanitizeAttributes({ scope: 'not-a-scope', nested: { token: 'secret' } })).toEqual({});
  });

  test('does not expose connector configuration in public source inventory', async () => {
    const { store } = await claimedStore();
    store.state.sourceConnections[0].config = { credential_refs: { apiKey: 'env:PRIVATE_KEY' }, unexpected: 'secret' };
    const inventory = await store.listSourceConnections();
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE_KEY');
    expect(JSON.stringify(inventory)).not.toContain('secret');
  });

  test('resolves credential references without storing literals', async () => {
    expect(await resolveCredentials({ apiKey: 'env:UNIFI_KEY' }, { env: { UNIFI_KEY: 'fixture-key' } })).toEqual({ apiKey: 'fixture-key' });
    expect(await resolveCredentials({ password: 'file:/test/secret' }, { read: async () => 'fixture-password\n' })).toEqual({ password: 'fixture-password' });
    await expect(resolveCredentials({ password: 'literal' })).rejects.toThrow('reference');
    await expect(resolveCredentials({ apiKey: 'env:MISSING' }, { env: {} })).rejects.toThrow('unavailable');
  });
});

describe('bounded, redacted upstream client', () => {
  test('classifies authentication, rate limits and malformed responses without echoing bodies', async () => {
    for (const [response, code] of [[new Response('secret', { status: 401 }), 'SOURCE_AUTHENTICATION_FAILED'],
      [new Response('secret', { status: 429, headers: { 'retry-after': '120' } }), 'SOURCE_RATE_LIMITED'],
      [new Response('secret', { status: 200 }), 'SOURCE_MALFORMED_RESPONSE']]) {
      const client = createHttpClient({ fetchImpl: async () => response });
      try { await client('https://fixture.invalid/api'); throw new Error('expected rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(CollectionError);
        expect(error.code).toBe(code);
        expect(error.message).not.toContain('secret');
        if (code === 'SOURCE_RATE_LIMITED') expect(error.retryAfterSeconds).toBe(120);
      }
    }
  });

  test('rejects credentials in URLs, enforces size limits and cancels timeouts', async () => {
    const sizeClient = createHttpClient({ fetchImpl: async () => new Response('{"ok":true}'), maximumBytes: 4 });
    await expect(sizeClient('https://user:password@fixture.invalid/api')).rejects.toThrow('INVALID_SOURCE_URL');
    await expect(sizeClient('https://fixture.invalid/api')).rejects.toThrow('SOURCE_RESPONSE_TOO_LARGE');
    const timeoutClient = createHttpClient({ timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('secret')), { once: true });
    }) });
    await expect(timeoutClient('https://fixture.invalid/api')).rejects.toThrow('SOURCE_TIMEOUT');
    const parent = new AbortController();
    const cancelled = timeoutClient('https://fixture.invalid/api', { signal: parent.signal });
    parent.abort();
    await expect(cancelled).rejects.toThrow('COLLECTION_CANCELLED');
    await expect(sizeClient('invalid source password')).rejects.toThrow('INVALID_SOURCE_URL');
  });
});

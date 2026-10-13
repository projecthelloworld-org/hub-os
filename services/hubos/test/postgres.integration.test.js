import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresStore } from '../src/store/postgres.js';
import { buildDemoState } from '../src/demo/data.js';
import { runConnectorJob } from '../src/connector-runtime/runner.js';
import { stableId, randomId } from '../src/ids.js';
import { SQL } from 'bun';
import { loadConnectorRegistry } from '../src/connectors/loader.js';
import { readdir } from 'node:fs/promises';

// Explicitly opt in against the disposable compose/test.compose.yaml database.
const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('PostgreSQL source-driven runtime (isolated integration)', () => {
  let store;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (url.pathname !== '/hubos_test' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Integration tests require the isolated local hubos_test database');
    }
    store = new PostgresStore({ databaseUrl });
    await store.ready();
    await store.db`TRUNCATE organisations, connector_jobs, connector_runs CASCADE`;
    await store.seedDemo(buildDemoState(new Date(Date.now() - 60000)));
  });
  afterAll(async () => { await store?.close(); });

  test('many external identifiers map to one canonical site without duplicating target populations', async () => {
    const sites = await store.listSites('UG');
    const sourceId = stableId('source', 'ug-unifi');
    await store.db`INSERT INTO external_identifiers (id, source_connection_id, entity_type, entity_id, external_id, verified)
      VALUES (${randomId()}, ${sourceId}, 'site', ${sites[0].id}, 'additional-monitor-id', true)`;
    const [target] = await store.listConnectorTargets({ connector_id: 'mock-school-telemetry', source_connection_id: sourceId });
    expect(target.mappings).toHaveLength(4);
    const collection = await store.db`SELECT * FROM analytics.collection_status WHERE source_connection_id = ${sourceId}`;
    expect(collection).toHaveLength(3);
    await store.db`DELETE FROM external_identifiers WHERE source_connection_id = ${sourceId} AND external_id = 'additional-monitor-id'`;
    expect(new Set((await store.listSites()).map((site) => site.site_type))).toEqual(new Set(['school', 'community_centre', 'library']));
  });

  test('SQL leases reclaim running work and fence abandoned owners', async () => {
    const first = await store.claimConnectorJob('first-worker', 300);
    expect(first).not.toBeNull();
    const abandonedRunId = await store.startConnectorRun(first, 'first-worker');
    await store.db`UPDATE connector_jobs SET locked_at = now() - interval '1 hour' WHERE id = ${first.id}`;
    const second = await store.claimConnectorJob('second-worker', 300);
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(await store.renewConnectorLease(first)).toBe(false);
    await store.completeConnectorJob(first);
    await store.failConnectorJob(first, new Error('never-store-a-password'));
    const [running] = await store.db`SELECT status, last_error FROM connector_jobs WHERE id = ${first.id}`;
    expect(running.status).toBe('running');
    expect(running.last_error).toBeNull();
    await store.finishConnectorRun(abandonedRunId, {});
    const [abandoned] = await store.db`SELECT status, error FROM connector_runs WHERE id = ${abandonedRunId}`;
    expect(abandoned.status).toBe('failed');
    expect(abandoned.error).toBe('WORKER_LEASE_EXPIRED');
    const result = await runConnectorJob({ store, job: second, workerId: 'second-worker', demoMode: true });
    expect(result.accepted).toBe(90);
    const [{ count }] = await store.db`SELECT count(*)::int AS count FROM analytics.telemetry`;
    expect(count).toBe(150);
    const raw = await store.db`SELECT payload FROM raw_payloads LIMIT 1`;
    const payload = typeof raw[0].payload === 'string' ? JSON.parse(raw[0].payload) : raw[0].payload;
    expect(payload.schema_version).toBe('1.0');
    expect(payload).not.toHaveProperty('telemetry');
  });

  test('PostgreSQL refuses a false external mapping and retains newer status', async () => {
    const sourceId = stableId('source', 'ug-unifi');
    const sites = await store.listSites('UG');
    const result = await store.ingestObservations([{ site_id: sites[0].id, source_connection_id: sourceId,
      external_entity_id: 'not-verified', external_record_id: 'wrong-mapping',
      metric: 'test.numeric.count', value: 1, quality: 'valid', unit: 'count', observed_at: new Date(), attributes: {} }]);
    expect(result.rejected).toBe(1);
    const { statuses } = await store.getSiteStatus(sites[0].id);
    await store.upsertStatuses([{ ...statuses[0], site_id: sites[0].id,
      status: 'critical', observed_at: '2000-01-01T00:00:00Z' }]);
    const refreshed = await store.getSiteStatus(sites[0].id);
    expect(refreshed.statuses.find((status) => status.domain === statuses[0].domain).status).toBe(statuses[0].status);
  });

  test('an installed test plugin is visible in generic analytics without query or schema changes', async () => {
    const registry = await loadConnectorRegistry({ pluginConfigPath: new URL('fixtures/plugins-enabled.json', import.meta.url).pathname });
    const sourceId = stableId('source', 'ug-unifi');
    const jobId = randomId();
    await store.db`UPDATE source_connections SET plugin_id = 'starter-environment',
      config = '{"demo":true,"temperature":27.5}'::jsonb WHERE id = ${sourceId}`;
    await store.db`INSERT INTO connector_jobs (id, connector_id, source_connection_id, max_attempts)
      VALUES (${jobId}, 'starter-environment', ${sourceId}, 3)`;
    const job = await store.claimConnectorJob('plugin-worker', 300);
    expect(String(job.id)).toBe(jobId);
    await runConnectorJob({ store, job, workerId: 'plugin-worker', registry, demoMode: true });
    const rows = await store.db`SELECT metric, value, synthetic, country_code FROM analytics.telemetry
      WHERE metric = 'environment.temperature.celsius' ORDER BY site_code`;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.value === 27.5 && row.synthetic && row.country_code === 'UG')).toBe(true);
  });

  test('additive migration preserves v0.1 canonical ids, mappings, observations and existing configuration', async () => {
    const name = `hubos_upgrade_${randomId().replaceAll('-', '')}`;
    await store.db.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const legacy = new SQL({ url: url.href, max: 1 });
    try {
      const original = await Bun.file(new URL('../../../db/migrations/202607160001_create_hubos_core.sql', import.meta.url)).text();
      await legacy.unsafe(original.split('-- migrate:down')[0]);
      const orgId = stableId('organisation', 'upgrade-fixture');
      const siteId = stableId('site', 'upgrade-fixture');
      const sourceId = stableId('source', 'upgrade-fixture');
      const mappingId = stableId('mapping', 'upgrade-fixture');
      await legacy`INSERT INTO organisations (id, slug, name) VALUES (${orgId}, 'upgrade-fixture', 'Upgrade fixture')`;
      await legacy`INSERT INTO sites (id, organisation_id, site_code, name, country_code)
        VALUES (${siteId}, ${orgId}, 'EXISTING-01', 'Existing community site', 'UG')`;
      await legacy`INSERT INTO source_connections (id, organisation_id, name, connector_type, collection_mode, config)
        VALUES (${sourceId}, ${orgId}, 'Existing source', 'headwind', 'api_pull', '{"group_id":7}'::jsonb)`;
      await legacy`INSERT INTO external_identifiers (id, source_connection_id, entity_type, entity_id, external_id, verified)
        VALUES (${mappingId}, ${sourceId}, 'site', ${siteId}, 'legacy-id', true)`;
      await legacy`INSERT INTO observations (site_id, source_connection_id, external_record_id, metric, value, observed_at)
        VALUES (${siteId}, ${sourceId}, 'legacy-record', 'devices.active.count', 4, '2026-07-16T12:00:00Z')`;
      const migration = await Bun.file(new URL('../../../db/migrations/202610130001_source_driven_connectors.sql', import.meta.url)).text();
      await legacy.unsafe(migration.split('-- migrate:down')[0]);
      const directory = new URL('../../../db/migrations/', import.meta.url);
      for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql') && name > '202610130001_source_driven_connectors.sql').sort()) {
        const next = await Bun.file(new URL(name, directory)).text();
        await legacy.unsafe(next.split('-- migrate:down')[0]);
      }
      const [preserved] = await legacy`SELECT o.site_id, o.value, ei.id AS mapping_id, sc.id AS source_id,
        sc.config->>'group_id' AS group_id, sc.enabled, sc.plugin_id
        FROM observations o JOIN source_connections sc ON sc.id = o.source_connection_id
        JOIN external_identifiers ei ON ei.source_connection_id = sc.id`;
      expect(String(preserved.site_id)).toBe(siteId);
      expect(String(preserved.mapping_id)).toBe(mappingId);
      expect(String(preserved.source_id)).toBe(sourceId);
      expect(preserved.value).toBe(4);
      expect(preserved.group_id).toBe('7');
      expect(preserved.enabled).toBe(false);
      expect(preserved.plugin_id).toBe('headwind');
      await legacy`INSERT INTO external_identifiers (source_connection_id, entity_type, entity_id, external_id, verified)
        VALUES (${sourceId}, 'site', ${siteId}, 'second-legacy-id', true)`;
      // A rollback must not silently discard the new mapping cardinality.
      await expect((async () => { await legacy.unsafe(migration.split('-- migrate:down')[1]); })()).rejects.toThrow('Cannot downgrade');
    } finally {
      await legacy.close();
      await store.db.unsafe(`DROP DATABASE ${name}`);
    }
  }, 20000);
});

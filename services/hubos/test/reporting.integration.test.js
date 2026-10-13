import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { ensureAnalyticsAccount } from '../src/metabase/analytics-account.js';
import { PostgresStore } from '../src/store/postgres.js';
import { randomId } from '../src/ids.js';

const databaseUrl = process.env.HUBOS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('Reporting views and enforced read-only access', () => {
  let admin, store, reporting, databaseName, roleName, orgId, siteId, firstSource, secondSource;
  beforeAll(async () => {
    const base = new URL(databaseUrl);
    if (base.pathname !== '/hubos_test' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Isolated fixture database required');
    admin = new SQL({ url: base.href, max: 1 });
    const suffix = randomId().replaceAll('-', '');
    databaseName = `hubos_reporting_${suffix}`;
    roleName = `analytics_fixture_${suffix}`;
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    base.pathname = `/${databaseName}`;
    store = new PostgresStore({ databaseUrl: base.href });
    const directory = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await store.db.unsafe((await Bun.file(new URL(file, directory)).text()).split('-- migrate:down')[0]);
    }
    await ensureAnalyticsAccount(store.db, { username: roleName, password: 'fixture-readonly-password', ownerUsername: 'hubos_test' });
    base.username = roleName; base.password = 'fixture-readonly-password';
    reporting = new SQL({ url: base.href, max: 1 });
    orgId = randomId(); siteId = randomId(); firstSource = randomId(); secondSource = randomId();
    await store.db`INSERT INTO organisations (id,slug,name) VALUES (${orgId}, ${`reporting-${orgId}`}, 'Reporting fixture')`;
    await store.db`INSERT INTO sites (id,organisation_id,site_code,name,country_code) VALUES (${siteId},${orgId},'FIXTURE-01','Community fixture','UG')`;
    for (const sourceId of [firstSource, secondSource]) {
      await store.db`INSERT INTO source_connections (id,organisation_id,name,connector_type,plugin_id,collection_mode,enabled,config)
        VALUES (${sourceId},${orgId},${sourceId},'fixture','fixture','api_pull',true,'{"credential_refs":{"password":"env:PRIVATE_PASSWORD"}}'::jsonb)`;
      await store.db`INSERT INTO external_identifiers (source_connection_id,entity_type,entity_id,external_id,verified)
        VALUES (${sourceId},'site',${siteId},${siteId},true)`;
    }
  }, 20000);
  afterAll(async () => {
    await reporting?.close();
    await store?.close();
    if (admin && databaseName) await admin.unsafe(`DROP DATABASE ${databaseName}`);
    if (admin && roleName) await admin.unsafe(`DROP ROLE IF EXISTS ${roleName}`);
    await admin?.close();
  });

  async function record(source, metric, value, observedAt = new Date(), quality = 'valid') {
    return store.ingestObservations([{ site_id: siteId, source_connection_id: source, external_record_id: randomId(),
      metric, value, quality, unit: 'count', observed_at: observedAt, attributes: {} }]);
  }

  test('reporting can read views but cannot read raw credentials, write tables or create objects', async () => {
    expect((await reporting`SELECT * FROM analytics.community_operations`)).toHaveLength(1);
    expect((await reporting.unsafe('SHOW timezone'))[0].TimeZone).toBe('UTC');
    await expect((async () => { await reporting`SELECT config FROM source_connections`; })()).rejects.toThrow('permission denied');
    await reporting`SET default_transaction_read_only = off`;
    await expect((async () => { await reporting`UPDATE sites SET name = 'changed' WHERE id = ${siteId}`; })()).rejects.toThrow('permission denied');
    await expect((async () => { await reporting.unsafe('CREATE TABLE analytics.forbidden (id integer)'); })()).rejects.toThrow('permission denied');
    const json = JSON.stringify(await reporting`SELECT * FROM analytics.collection_status`);
    expect(json).not.toContain('PRIVATE_PASSWORD');
    expect(json).not.toContain('fixture-readonly-password');
    await expect(ensureAnalyticsAccount(store.db, { username: 'hubos_test', ownerUsername: 'hubos_test', password: 'fixture-password-long' })).rejects.toThrow('INVALID_ANALYTICS_ACCOUNT');
    // An existing role must not retain schema ownership through a misleading read-only setting.
    await store.db.unsafe(`CREATE SCHEMA analytics_fixture_owned AUTHORIZATION ${roleName}`);
    await expect(ensureAnalyticsAccount(store.db, { username: roleName, ownerUsername: 'hubos_test', password: 'fixture-password-long' })).rejects.toThrow('ANALYTICS_ROLE_HAS_EXCESS_PRIVILEGES');
    await store.db.unsafe('DROP SCHEMA analytics_fixture_owned');
  });

  test('a healthy controller cannot clear another fault or a disabled/stale source', async () => {
    await record(firstSource, 'connectivity.wan.available', 0, new Date(Date.now() - 1000));
    await record(secondSource, 'connectivity.wan.available', 1, new Date(Date.now() - 1000));
    const state = async () => (await reporting`SELECT state FROM analytics.operational_rule_state WHERE site_id = ${siteId} AND rule_id = 'availability'`)[0].state;
    expect(await state()).toBe('active');
    await record(firstSource, 'connectivity.wan.available', 1);
    expect(await state()).toBe('healthy');
    await store.db`UPDATE source_connections SET enabled = false WHERE id = ${firstSource}`;
    expect(await state()).toBe('unknown');
    await store.db`UPDATE source_connections SET enabled = true WHERE id = ${firstSource}`;
    await record(firstSource, 'connectivity.wan.available', 1, new Date(Date.now() + 10), 'invalid');
    expect(await state()).toBe('unknown');
  });

  test('missing device/field measurements stay unknown; known faults use configurable thresholds', async () => {
    await record(firstSource, 'devices.inventory.count', 20);
    await record(firstSource, 'devices.check_in.unknown.count', 0);
    const state = async () => (await reporting`SELECT state FROM analytics.operational_rule_state WHERE site_id = ${siteId} AND rule_id = 'device-check-in'`)[0].state;
    expect(await state()).toBe('unknown');
    await record(firstSource, 'devices.check_in.stale.count', 5);
    expect(await state()).toBe('active');
    await store.db`UPDATE source_connections SET config = config || '{"alert_thresholds":{"stale_device_count":5}}'::jsonb WHERE id = ${firstSource}`;
    expect(await state()).toBe('healthy');
    await record(firstSource, 'field.report.fault.count', 1, new Date(Date.now() - 3600000));
    const field = (await reporting`SELECT state FROM analytics.operational_rule_state WHERE site_id = ${siteId} AND rule_id = 'field-fault'`)[0];
    expect(field.state).toBe('unknown');
    const metrics = await reporting`SELECT value FROM analytics.metric_current WHERE metric = 'field.report.fault.count'`;
    expect(metrics[0].value).toBeNull();
  });

  test('future collection timestamps do not establish healthy source or recovery evidence', async () => {
    await store.db`UPDATE source_connections SET last_success_at = now() + interval '1 hour', status = 'healthy' WHERE id = ${secondSource}`;
    expect((await reporting`SELECT freshness FROM analytics.collection_status WHERE source_connection_id = ${secondSource}`)[0].freshness).toBe('unknown');
    expect((await reporting`SELECT status FROM analytics.connector_health WHERE source_connection_id = ${secondSource}`)[0].status).toBe('unknown');
    expect((await reporting`SELECT state FROM analytics.operational_rule_conditions
      WHERE source_connection_id = ${secondSource} AND rule_id = 'collection-freshness'`)[0].state).toBe('unknown');
    expect((await store.listSourceConnections()).find((source) => String(source.id) === secondSource).status).toBe('unknown');
  });

  test('report validity and collector freshness are separate; stale sites remain in current-date reporting', async () => {
    await store.db`DELETE FROM observations WHERE source_connection_id = ${firstSource} AND metric = 'field.report.fault.count'`;
    await store.db`UPDATE source_connections SET config = config || '{"evidence_max_age_seconds":604800}'::jsonb,
      last_success_at = now() WHERE id = ${firstSource}`;
    await record(firstSource, 'field.report.fault.count', 2, new Date(Date.now() - 86400000));
    const fault = async () => (await reporting`SELECT fault_count FROM analytics.field_evidence WHERE source_connection_id = ${firstSource}`)[0].fault_count;
    expect(await fault()).toBe(2);
    await store.db`UPDATE source_connections SET last_success_at = now() - interval '1 hour' WHERE id = ${firstSource}`;
    expect(await fault()).toBeNull();
    await store.db`INSERT INTO status_snapshots (site_id,domain,status,reason,observed_at,rule_version)
      VALUES (${siteId},'connectivity','healthy','Old evidence',now() - interval '45 days','fixture')
      ON CONFLICT (site_id,domain) DO UPDATE SET observed_at = EXCLUDED.observed_at`;
    const rows = await reporting`SELECT connectivity FROM analytics.community_operations WHERE as_of >= now() - interval '30 days'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].connectivity).toBe('unknown');
    expect((await reporting`SELECT freshness FROM analytics.collection_status
      WHERE source_connection_id = ${firstSource} AND as_of >= now() - interval '30 days'`)[0].freshness).toBe('stale');
  });

  test('a paused source stops current status claims while preserving historical snapshots and other source evidence', async () => {
    await store.upsertStatuses([{ site_id: siteId, source_connection_id: firstSource, domain: 'connectivity', status: 'healthy',
      reason: 'Fixture current evidence', observed_at: new Date(), rule_version: 'fixture' },
    { site_id: siteId, source_connection_id: secondSource, domain: 'power', status: 'healthy',
      reason: 'Fixture other source', observed_at: new Date(), rule_version: 'fixture' }]);
    await store.markSourceCollected(firstSource, new Date());
    await store.db`UPDATE source_connections SET last_success_at = now(), status = 'healthy' WHERE id = ${secondSource}`;
    expect((await reporting`SELECT connectivity FROM analytics.community_operations WHERE site_id = ${siteId}`)[0].connectivity).toBe('healthy');
    await store.disableSource(firstSource);
    expect((await reporting`SELECT connectivity,power FROM analytics.community_operations WHERE site_id = ${siteId}`)[0])
      .toMatchObject({ connectivity: 'unknown', power: 'healthy' });
    expect((await reporting`SELECT status FROM analytics.site_status_current WHERE site_id = ${siteId} AND domain = 'connectivity'`)[0].status).toBe('unknown');
    expect((await store.getSiteStatus(siteId)).statuses.find((status) => status.domain === 'connectivity').status).toBe('unknown');
    expect((await store.getDashboardData()).sites.find((site) => String(site.id) === siteId).statuses.find((status) => status.domain === 'connectivity').status).toBe('unknown');
    expect((await store.db`SELECT status FROM status_snapshots WHERE site_id = ${siteId} AND domain = 'connectivity'`)[0].status).toBe('healthy');
    await store.upsertStatuses([{ site_id: siteId, source_connection_id: firstSource, domain: 'connectivity', status: 'critical',
      reason: 'Late evidence', observed_at: new Date(Date.now() + 1000), rule_version: 'fixture' }]);
    expect((await store.db`SELECT status FROM status_snapshots WHERE site_id = ${siteId} AND domain = 'connectivity'`)[0].status).toBe('healthy');
    await store.enableSource(firstSource, (await store.getSourceAdminContext(firstSource)).source);
    expect((await reporting`SELECT connectivity FROM analytics.community_operations WHERE site_id = ${siteId}`)[0].connectivity).toBe('unknown');
    await store.db`INSERT INTO status_snapshots (site_id,domain,status,reason,observed_at,rule_version)
      VALUES (${siteId},'usage','healthy','Legacy unattributed snapshot',now(),'v0.1')`;
    expect((await reporting`SELECT status FROM analytics.site_status_current WHERE site_id = ${siteId} AND domain = 'usage'`)[0].status).toBe('unknown');
  });
});

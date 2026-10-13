import { describe, expect, test } from 'bun:test';
import { dashboards, questions, buildQuestion, dashboardParameters } from '../src/metabase/catalog.js';
import { buildMetabaseAlert, buildMetabaseChannel } from '../src/metabase/provision.js';
import { ensureResource } from '../src/metabase/resources.js';
import { createConnectorRegistry } from '../src/connectors/loader.js';
import { MemoryStore } from '../src/store/memory.js';
import { buildDemoState } from '../src/demo/data.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import metabase from '../src/connectors/metabase-alerts/index.js';

describe('Metabase dashboard and alert contract', () => {
  test('declares all four requested dashboards with mapped site/country/date controls and generic telemetry', () => {
    expect(dashboards.map((dashboard) => dashboard.name)).toEqual(['Community Operations', 'Availability & Connectivity', 'Devices & Field Evidence', 'Collection & Support']);
    expect(new Set(questions.map((question) => question.key)).size).toBe(questions.length);
    expect(dashboardParameters().map((parameter) => parameter.slug)).toEqual(['site', 'country', 'date']);
    expect(dashboardParameters().find((parameter) => parameter.slug === 'date').default).toBe('past30days~');
    for (const definition of questions) {
      const card = buildQuestion(definition, { databaseId: 2, collectionId: 3, fieldId: () => 42 });
      expect(card.dataset_query.native.query).toContain('FROM analytics.');
      expect(card.dataset_query.native['template-tags'].date.dimension).toEqual(['field', 42, null]);
      expect(card.description.length).toBeGreaterThan(20);
    }
    const generic = questions.find((question) => question.key === 'plugin-telemetry');
    expect(generic.select).toContain('metric, value, unit, quality');
    expect(generic.tail).not.toContain('mock');
    expect(questions.find((question) => question.key === 'availability-community').select).toContain('nullif(sum(observed_seconds), 0)');
  });

  test('schedules repeated native webhook evaluations and keeps its secret out of URLs', () => {
    const channel = buildMetabaseChannel({ sourceId: 'source', webhookKey: 'secret-key', internalUrl: 'http://api:3000' });
    expect(channel.details.url).not.toContain('secret-key');
    expect(channel.details['auth-info']['x-hubos-webhook-key']).toBe('secret-key');
    const alert = buildMetabaseAlert(7, 9);
    expect(alert.payload).toMatchObject({ send_condition: 'has_result', send_once: false });
    expect(alert.subscriptions[0].cron_schedule).toBe('0 * * * * ?');
  });

  test('never overwrites a tracked customized resource on repeat provisioning', async () => {
    const methods = [];
    const result = await ensureResource({ kind: 'dashboard', key: 'operations', path: '/api/dashboard', payload: { name: 'Template' },
      registry: { get: async () => ({ external_id: 8, provisioned: true }) },
      client: async (path, options) => { methods.push(options?.method ?? 'GET'); return { id: 8, name: 'Custom title', dashcards: [{ col: 3 }] }; } });
    expect(methods).toEqual(['GET']);
    expect(result.resource.name).toBe('Custom title');
  });

  test('records an allocated dashboard as incomplete until layout setup succeeds', async () => {
    let saved;
    await ensureResource({ kind: 'dashboard', key: 'operations', path: '/api/dashboard', payload: { name: 'Template' }, provisioned: false,
      registry: { get: async () => null, put: async (...args) => { saved = args; } }, client: async () => ({ id: 8 }) });
    expect(saved[3]).toBe(false);
  });

  test('accepts only approved question ids and mapped canonical sites; removes personal and image data', async () => {
    const store = new MemoryStore(buildDemoState());
    const source = store.state.sourceConnections[0];
    source.plugin_id = 'metabase-alerts';
    source.config = { mapping_policy: 'canonical_site_ids', question_rules: { 7: { rule_id: 'field-fault', state: 'active' }, 8: { rule_id: 'field-fault', state: 'healthy' } },
      credential_refs: { webhookKey: 'env:META_KEY' } };
    const app = createApp({ store, config: loadConfig({ HUBOS_DEMO_MODE: 'true' }), registry: createConnectorRegistry([metabase]),
      resolveSecrets: async () => ({ webhookKey: 'fixture-key' }) });
    const body = { type: 'alert', alert_id: 10, alert_creator_name: 'Private Person', data: { question_id: 7,
      visualization: 'data:image/png;base64,private', raw_data: { cols: ['site_id', 'observed_at', 'person_name'],
        rows: [[store.state.sites[0].id, new Date(Date.now() - 1000).toISOString(), 'Private Person']] } } };
    const send = (payload, key = 'fixture-key') => app(new Request(`http://fixture/api/v1/source-connections/${source.id}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hubos-webhook-key': key }, body: JSON.stringify(payload),
    }));
    expect((await send(body, 'wrong')).status).toBe(401);
    expect((await send(body)).status).toBe(202);
    expect((await send(body)).status).toBe(202);
    expect(store.state.notifications).toHaveLength(1);
    expect(JSON.stringify(store.state.incidents)).not.toContain('Private Person');
    expect(JSON.stringify(store.state.signalStates)).not.toContain('base64');
    body.data.question_id = 999;
    expect((await send(body)).status).toBe(422);
    body.data.question_id = 8;
    body.data.raw_data.rows[0][1] = new Date().toISOString();
    expect((await send(body)).status).toBe(202);
    expect(store.state.notifications).toHaveLength(2);
  });
});

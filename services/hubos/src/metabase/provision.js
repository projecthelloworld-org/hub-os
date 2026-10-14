import { ensureAnalyticsAccount } from './analytics-account.js';
import { bootstrapMetabase, loadMetabaseBootstrapConfig } from './bootstrap.js';
import { resourceRegistry, ensureResource } from './resources.js';
import { dashboards, questions, dashboardParameters, buildQuestion } from './catalog.js';
import { stableId } from '../ids.js';
import { loadConfig } from '../config.js';
import { CollectionError } from '../connector-runtime/http-client.js';

async function waitForMetadata(client, databaseId) {
  const required = new Set(questions.map((item) => item.view));
  await client(`/api/database/${databaseId}/sync_schema`, { method: 'POST' });
  for (let attempt = 0; attempt < 60; attempt++) {
    const metadata = await client(`/api/database/${databaseId}/metadata`);
    const tables = metadata.tables ?? [];
    if ([...required].every((name) => tables.some((table) => table.schema === 'analytics' && table.name === name
      && questions.filter((item) => item.view === name).every((item) =>
        [item.dateField, ...(item.siteFilters === false ? [] : ['site_code', 'country_code'])]
          .every((field) => table.fields?.some((value) => value.name === field)))))) {
      return (view, column) => {
        const field = tables.find((table) => table.schema === 'analytics' && table.name === view)?.fields.find((field) => field.name === column);
        if (!field) throw new CollectionError('METABASE_REPORT_FIELD_MISSING');
        return field.id;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new CollectionError('METABASE_METADATA_NOT_READY');
}

async function managed(client, registry, kind, key, path, payload, { allocate = false } = {}) {
  const prior = await registry.get(kind, key);
  if (prior) {
    return { id: Number(prior.external_id), resource: await client(`${path}/${prior.external_id}`),
      existing: true, provisioned: prior.provisioned };
  }
  // Recover a successful POST whose registry save was interrupted, scoped by owned description.
  const inventory = await client(path);
  const candidates = (Array.isArray(inventory) ? inventory : inventory.data ?? [])
    .filter((item) => item.name === payload.name && item.description === payload.description);
  if (candidates.length > 1) throw new CollectionError('METABASE_AMBIGUOUS_MANAGED_RESOURCE');
  if (candidates[0]) {
    const resource = await client(`${path}/${candidates[0].id}`);
    const complete = kind !== 'dashboard' || Boolean(resource.dashcards?.length);
    await registry.put(kind, key, resource.id, complete);
    return { id: resource.id, resource, existing: true, provisioned: complete };
  }
  const result = await ensureResource({ client, registry, kind, key, path, payload, provisioned: !allocate });
  return { ...result, provisioned: !allocate };
}

export function buildMetabaseChannel({ sourceId, webhookKey, internalUrl }) {
  return { name: 'HubOS incident routing', description: 'HubOS-owned operational data alerts', type: 'channel/http', active: true,
    details: { url: `${internalUrl}/api/v1/source-connections/${sourceId}/webhook`, method: 'post',
      'auth-method': 'header', 'fe-form-type': 'api-key', 'auth-info': { 'x-hubos-webhook-key': webhookKey } } };
}

export function buildMetabaseAlert(cardId, channelId, cron = '0 * * * * ?') {
  return { payload_type: 'notification/card', payload: { card_id: cardId, send_condition: 'has_result', send_once: false },
    handlers: [{ channel_type: 'channel/http', channel_id: channelId, active: true }],
    subscriptions: [{ type: 'notification-subscription/cron', cron_schedule: cron, ui_display_type: 'cron/raw' }] };
}

export async function provisionMetabaseMonitoring({ store, env = process.env, fetchImpl = fetch, logger = console }) {
  const core = loadConfig(env);
  const config = loadMetabaseBootstrapConfig(env);
  const webhookKey = env.METABASE_WEBHOOK_KEY;
  if (!webhookKey || [core.ingestKey, core.adminKey, env.KUMA_WEBHOOK_KEY].includes(webhookKey)) {
    throw new CollectionError('METABASE_DISTINCT_WEBHOOK_CREDENTIAL_REQUIRED');
  }
  await ensureAnalyticsAccount(store.db, { username: config.databaseUser, password: config.databasePassword,
    ownerUsername: new URL(core.databaseUrl).username });
  const registry = resourceRegistry(store.db);
  const orgId = stableId('organisation', core.demoMode ? 'phw-demo' : 'hubos');
  if (!core.demoMode) await store.db`INSERT INTO organisations (id, slug, name)
    VALUES (${orgId}, 'hubos', 'HubOS community operations') ON CONFLICT DO NOTHING`;
  const sourceId = stableId('source', core.demoMode ? 'demo-owned-metabase' : 'owned-metabase');
  await store.db`INSERT INTO source_connections (id, organisation_id, name, connector_type, plugin_id, collection_mode,
    config, enabled, is_demo) VALUES (${sourceId}, ${orgId}, 'HubOS-owned Metabase alert evaluator', 'metabase', 'metabase-alerts', 'webhook',
      ${JSON.stringify({ mapping_policy: 'canonical_site_ids', question_rules: {}, credential_refs: { webhookKey: 'env:METABASE_WEBHOOK_KEY' } })}::text::jsonb, true, ${core.demoMode})
    ON CONFLICT (id) DO NOTHING`;
  await store.getSourceContext(sourceId); // Materialize the explicitly enabled canonical mapping policy.
  const stored = await registry.get('database', 'hubos');
  let report;
  await bootstrapMetabase({ config, fetchImpl, logger, existingDatabaseId: stored ? Number(stored.external_id) : null,
    updateAnalyticsConnection: true,
    onAuthenticated: async ({ client, databaseId }) => {
      await registry.put('database', 'hubos', databaseId);
      const fieldId = await waitForMetadata(client, databaseId);
      const collection = await managed(client, registry, 'collection', 'operations', '/api/collection', {
        name: 'HubOS Operations', description: 'HubOS-owned community monitoring templates; user edits are preserved.', color: '#e76031',
      });
      const alertCollection = await managed(client, registry, 'collection', 'alert-rules', '/api/collection', {
        name: 'HubOS Alert Rules', description: 'HubOS-owned active and explicit-recovery evaluation questions.', color: '#e76031',
      });
      const cards = new Map();
      for (const definition of questions) {
        const payload = buildQuestion(definition, { databaseId, collectionId: collection.id, fieldId });
        const card = await managed(client, registry, 'card', definition.key, '/api/card', payload);
        cards.set(definition.key, card);
      }
      const dashboardIds = [];
      for (const definition of dashboards) {
        const note = core.demoMode ? 'Contains ten fictional Uganda/Angola community sites; synthetic evidence is labelled. ' : '';
        const dashboard = await managed(client, registry, 'dashboard', definition.key, '/api/dashboard', {
          name: definition.name, description: note + 'HubOS community-site operational evidence. UTC reporting dates filter current cards by evaluation time and history cards by evidence time; current cards do not reconstruct past status. Unknown is not healthy.',
          collection_id: collection.id, parameters: dashboardParameters(),
        }, { allocate: true });
        if (!dashboard.provisioned && !dashboard.resource.dashcards?.length) {
          const dashcards = definition.cards.map(([key, row, col, sizeX, sizeY], index) => {
            const card = cards.get(key);
            const query = card.resource.dataset_query;
            // Current Metabase returns normalized MBQL tags as an array. The
            // names, not its numeric array indexes, identify dashboard filters.
            const savedTags = query.native?.['template-tags'] ?? query.stages?.[0]?.['template-tags'] ?? {};
            const tags = Array.isArray(savedTags) ? savedTags.map((tag) => tag.name) : Object.keys(savedTags);
            if (tags.some((name) => !['site', 'country', 'date'].includes(name)) || new Set(tags).size !== tags.length) {
              throw new CollectionError('METABASE_REPORT_PARAMETER_INVALID');
            }
            return { id: -(index + 1), card_id: card.id, row, col, size_x: sizeX, size_y: sizeY, series: [],
              parameter_mappings: tags.map((name) => ({ parameter_id: `hubos-${name}`, card_id: card.id,
                target: ['dimension', ['template-tag', name]] })) };
          });
          await client(`/api/dashboard/${dashboard.id}`, { method: 'PUT', body: { dashcards } });
        }
        await registry.put('dashboard', definition.key, dashboard.id, true);
        dashboardIds.push(dashboard.id);
      }
      const ruleMap = {};
      const ruleCards = [];
      for (const ruleId of ['availability', 'collection-freshness', 'device-check-in', 'field-fault']) {
        for (const state of ['active', 'healthy']) {
          const key = `${ruleId}-${state}`;
          const payload = { name: `HubOS ${ruleId}: ${state}`, description: `HubOS-owned ${ruleId} ${state} evaluation. Unknown evidence never satisfies recovery.`,
            display: 'table', collection_id: alertCollection.id, visualization_settings: {}, dataset_query: {
              database: databaseId, type: 'native', native: { query:
                `SELECT site_id, observed_at FROM analytics.operational_rule_state WHERE organisation_id = '${orgId}'::uuid AND rule_id = '${ruleId}' AND state = '${state}' ORDER BY site_id`, 'template-tags': {} },
            } };
          const card = await managed(client, registry, 'card', `alert-${key}`, '/api/card', payload);
          ruleMap[card.id] = { rule_id: ruleId, state };
          ruleCards.push({ key, cardId: card.id });
        }
      }
      await store.db`UPDATE source_connections SET config = jsonb_set(config, '{question_rules}', ${JSON.stringify(ruleMap)}::text::jsonb)
        WHERE id = ${sourceId}`;
      const channel = await managed(client, registry, 'channel', 'incident-routing', '/api/channel', buildMetabaseChannel({ sourceId,
        webhookKey, internalUrl: env.HUBOS_INTERNAL_URL ?? 'http://api:3000' }));
      // Native notifications have no names; recover by the owned card/channel identities.
      const notifications = await client('/api/notification');
      const inventory = Array.isArray(notifications) ? notifications : notifications.data ?? [];
      for (const rule of ruleCards) {
        const prior = await registry.get('notification', rule.key);
        if (prior) { await client(`/api/notification/${prior.external_id}`); continue; }
        const matches = inventory.filter((item) => item.payload?.card_id === rule.cardId
          && item.handlers?.some((handler) => handler.channel_id === channel.id));
        if (matches.length > 1) throw new CollectionError('METABASE_AMBIGUOUS_MANAGED_ALERT');
        const notification = matches[0] ?? await client('/api/notification', { method: 'POST',
          body: buildMetabaseAlert(rule.cardId, channel.id, env.METABASE_ALERT_CRON ?? '0 * * * * ?') });
        await registry.put('notification', rule.key, notification.id);
      }
      report = { dashboards: dashboardIds, questions: cards.size, alert_questions: ruleCards.length, source_id: sourceId };
      logger.log('Provisioned HubOS Metabase dashboards and data alerts', { dashboards: dashboardIds.length, questions: cards.size, alerts: ruleCards.length });
    },
  });
  return report;
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config.js';
import { stableId, randomId } from '../ids.js';
import { PostgresStore } from '../store/postgres.js';
import { withKumaSession } from './adapter-2.5.6.js';
import { createHttpClient, CollectionError } from '../connector-runtime/http-client.js';
import { safeError } from '../privacy.js';

export function starterMonitorDefinitions(sites, demoMode) {
  const definitions = [
    { key: 'hubos-api', name: 'HubOS API (infrastructure)', url: 'http://api:3000/readyz', scope: 'infrastructure' },
    { key: 'metabase', name: 'Metabase (infrastructure)', url: 'http://metabase:3000/api/health', scope: 'infrastructure' },
  ];
  if (demoMode) {
    for (const site of sites.filter((site) => site.is_demo)) definitions.push({
      key: `demo-${site.site_code}`, name: `[DEMO] ${site.site_code} synthetic reachability`,
      url: `http://api:3000/demo/probes/${site.site_code}`, site_id: String(site.id), scope: 'synthetic', is_demo: true,
    });
  }
  return definitions;
}

export async function provisionKuma({ store, env = process.env, sessionFactory = withKumaSession,
  requestText = createHttpClient({ responseType: 'text' }), fetchImpl = fetch, definitions = null }) {
  if (env.KUMA_OWNED_INSTANCE !== 'true') throw new CollectionError('KUMA_PROVISIONING_REQUIRES_OWNED_INSTANCE');
  const config = loadConfig(env);
  const url = env.KUMA_URL ?? 'http://kuma:3001';
  const username = env.KUMA_ADMIN_USER;
  const password = env.KUMA_ADMIN_PASSWORD;
  const webhookKey = env.KUMA_WEBHOOK_KEY;
  if (!username || !password || !webhookKey || webhookKey === config.ingestKey || webhookKey === config.adminKey) {
    throw new CollectionError('KUMA_DISTINCT_CREDENTIALS_REQUIRED');
  }
  const keyPath = env.KUMA_METRICS_KEY_FILE ?? '/run/hubos-secrets/kuma-metrics-key';
  const sourceId = stableId('source', config.demoMode ? 'demo-owned-kuma' : 'owned-kuma');
  const orgId = config.demoMode ? stableId('organisation', 'phw-demo') : stableId('organisation', 'hubos');
  if (!config.demoMode) await store.db`INSERT INTO organisations (id, slug, name)
    VALUES (${orgId}, 'hubos', 'HubOS community operations') ON CONFLICT DO NOTHING`;
  await store.db`INSERT INTO source_connections (id, organisation_id, name, connector_type, plugin_id,
    collection_mode, base_url, config, enabled, is_demo)
    VALUES (${sourceId}, ${orgId}, 'HubOS-owned Uptime Kuma', 'uptime_kuma', 'uptime-kuma', 'scheduled_pull', ${url},
      ${JSON.stringify({ adapter_version: '2.5.6', owned_instance: true, credential_refs: {
        username: 'env:KUMA_ADMIN_USER', password: 'env:KUMA_ADMIN_PASSWORD', webhookKey: 'env:KUMA_WEBHOOK_KEY',
        metricsKey: `file:${keyPath}`,
      } })}::text::jsonb, true, ${config.demoMode}) ON CONFLICT (id) DO NOTHING`;
  const target = await store.getSourceContext(sourceId);
  const sites = (await store.listSites()).filter((site) => String(site.organisation_id) === orgId);
  const requested = definitions ?? starterMonitorDefinitions(sites, config.demoMode);
  if (!definitions && env.KUMA_MONITOR_CONFIG) {
    let extra;
    try { extra = JSON.parse(await readFile(env.KUMA_MONITOR_CONFIG, 'utf8')); }
    catch { throw new CollectionError('KUMA_INVALID_MONITOR_CONFIGURATION'); }
    if (!Array.isArray(extra.monitors)) throw new CollectionError('KUMA_INVALID_MONITOR_CONFIGURATION');
    for (const item of extra.monitors.filter((item) => item.enabled === true)) {
      if (!sites.some((site) => String(site.id) === item.site_id) || item.scope !== 'community'
        || typeof item.key !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.key)) {
        throw new CollectionError('KUMA_INVALID_COMMUNITY_TARGET');
      }
      const parsed = new URL(item.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new CollectionError('KUMA_INVALID_COMMUNITY_TARGET');
      }
      try { await fetchImpl(parsed, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) }); }
      catch { throw new CollectionError('KUMA_COMMUNITY_TARGET_NOT_REACHABLE'); }
      requested.push(item);
    }
  }
  if (requested.length > 1000 || new Set(requested.map((item) => item.key)).size !== requested.length
    || new Set(requested.map((item) => item.name)).size !== requested.length
    || requested.some((item) => !item.key || typeof item.name !== 'string' || !item.name || item.name.length > 160
      || !['infrastructure', 'community', 'synthetic'].includes(item.scope)
      || !Number.isInteger(item.interval_seconds ?? 60) || (item.interval_seconds ?? 60) < 20 || (item.interval_seconds ?? 60) > 86400
      || !Number.isInteger(item.max_retries ?? 0) || (item.max_retries ?? 0) < 0 || (item.max_retries ?? 0) > 20)) {
    throw new CollectionError('KUMA_INVALID_MONITOR_CONFIGURATION');
  }
  return sessionFactory({ url, username, password }, async (session) => {
    let key;
    try { key = (await readFile(keyPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw new CollectionError('KUMA_METRICS_KEY_UNREADABLE'); }
    if (!key) {
      if (session.apiKeys.some((item) => item.name === 'HubOS metrics')) throw new CollectionError('KUMA_METRICS_KEY_MISSING');
      const reply = await session.requireOk('addAPIKey', { name: 'HubOS metrics', active: 1, expires: null });
      key = reply.key;
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
    }
    await requestText(new URL('/metrics', url), { headers: { authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` } });
    const notificationId = await session.ensureNotification({
      url: `${env.HUBOS_INTERNAL_URL ?? 'http://api:3000'}/api/v1/source-connections/${sourceId}/webhook`, webhookKey,
    });
    let created = 0;
    for (const definition of requested) {
      const canonicalId = stableId('monitor', `${sourceId}:${definition.key}`);
      const registered = target.monitors.find((monitor) => String(monitor.id) === canonicalId);
      let externalId = registered?.external_id;
      if (externalId && !session.monitors[externalId]) throw new CollectionError('KUMA_MANAGED_MONITOR_MISSING');
      if (!externalId) {
        const matches = Object.values(session.monitors).filter((monitor) => monitor.name === definition.name);
        if (matches.length > 1) throw new CollectionError('KUMA_AMBIGUOUS_MANAGED_MONITOR');
        externalId = matches[0] ? String(matches[0].id) : await session.addMonitor(definition, notificationId);
        if (!matches[0]) created += 1;
      }
      await store.registerMonitor({ id: canonicalId, source_connection_id: sourceId, external_id: externalId,
        site_id: definition.site_id ?? null, name: definition.name, scope: definition.scope,
        interval_seconds: definition.interval_seconds ?? 60, is_demo: definition.is_demo ?? false });
      if (definition.site_id) await store.db`INSERT INTO external_identifiers
        (id, source_connection_id, entity_type, entity_id, external_id, verified, mapping_method)
        VALUES (${randomId()}, ${sourceId}, 'site', ${definition.site_id}, ${externalId}, true, 'owned_provisioning')
        ON CONFLICT (source_connection_id, entity_type, external_id) DO NOTHING`;
    }
    await store.db`INSERT INTO connector_jobs (id, connector_id, source_connection_id, schedule_interval_seconds)
      VALUES (${stableId('job', `${sourceId}:collect`)}, 'uptime-kuma', ${sourceId}, 60) ON CONFLICT DO NOTHING`;
    return { source_id: sourceId, monitors: requested.length, created, administrator_created: session.createdAdmin,
      adapter_version: '2.5.6' };
  }, { allowSetup: true });
}

if (import.meta.main) {
  const config = loadConfig();
  const store = new PostgresStore({ databaseUrl: config.databaseUrl });
  try {
    // Serialize one-off provisioners without holding mutable vendor data in core tables.
    await store.db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('hubos:kuma-provision'))`;
      console.log('Kuma provisioned', await provisionKuma({ store }));
    });
  } catch (error) {
    console.error('Kuma provisioning failed', safeError(error));
    process.exitCode = 1;
  } finally { await store.close(); }
}

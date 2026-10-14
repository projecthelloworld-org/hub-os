import indexHtml from "../public/index.html" with { type: "text" };
import appCss from "../public/app.css" with { type: "text" };
import appJs from "../public/app.js" with { type: "text" };
import { createHash } from 'node:crypto';

import { listConnectorManifests, getConnector } from "./connectors/registry.js";
import { json, noContent, readJson, requestHasKey, text } from "./http.js";
import { buildOpenApi } from "./openapi.js";
import { StoreError } from "./store/errors.js";
import { requireText, validateObservationBatch } from "./validation.js";
import { safeError } from './privacy.js';
import { resolveCredentials } from './connector-runtime/secrets.js';
import { persistConnectorResult } from './connector-runtime/results.js';
import { profileFor } from './demo/data.js';
import { requireUuid, validateSite } from './administration/sites.js';
import { validateSource, validateSourceChanges } from './administration/sources.js';
import { validateMapping, validateMappingChanges } from './administration/mappings.js';
import { testSourceConnection } from './administration/connection-test.js';

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
const consoleHtml = indexHtml.replaceAll('__HUBOS_ASSET_VERSION__', createHash('sha256').update(appCss + appJs).digest('hex').slice(0, 16));

function withSecurity(response) {
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireApiKey(request, config, kind) {
  const settings = kind === "admin"
    ? [config.adminKey, "x-hubos-admin-key"]
    : [config.ingestKey, "x-hubos-ingest-key"];
  if (!requestHasKey(request, ...settings)) {
    throw Object.assign(new Error(`Valid ${kind} API key required`), { status: 401 });
  }
  if (kind === 'admin') {
    const origin = request.headers.get('origin');
    const expected = config.operatorOrigin ?? new URL(request.url).origin;
    if ((origin !== null && origin !== expected) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw Object.assign(new Error('Cross-origin operator writes are not allowed'), { status: 403 });
    }
  }
}

function errorResponse(error) {
  const status = error instanceof StoreError ? error.status : error.status ?? 500;
  const message = status >= 500 ? "Unexpected server error" : error.message;
  if (status >= 500) console.error(safeError(error));
  return json({ error: message }, status);
}

export function createApp({ store, config, resolveSecrets = resolveCredentials, registry = { getConnector, listConnectorManifests } }) {
  return async function fetch(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return withSecurity(noContent());
      if (request.method === "GET" && path === "/healthz") {
        return withSecurity(json({ status: "healthy", service: "hubos-api", version: config.version }));
      }
      if (request.method === "GET" && path === "/readyz") {
        await store.ready();
        return withSecurity(json({ status: "ready" }));
      }
      const demoProbe = path.match(/^\/demo\/probes\/((?:UG|AO)-DEMO-0[1-5])$/);
      if (request.method === 'GET' && demoProbe && config.demoMode) {
        const down = profileFor(demoProbe[1]).connectivity === 'critical';
        return withSecurity(json({ synthetic: true, status: down ? 'down' : 'up' }, down ? 503 : 200));
      }
      if (request.method === "GET" && path === "/") {
        if (!config.operatorConsoleEnabled) return withSecurity(json({ error: "Operator console disabled" }, 404));
        return withSecurity(text(consoleHtml, "text/html; charset=utf-8"));
      }
      if (request.method === "GET" && path === "/static/app.css") {
        return withSecurity(text(appCss, "text/css; charset=utf-8", 200, { "cache-control": "public, max-age=300" }));
      }
      if (request.method === "GET" && path === "/static/app.js") {
        return withSecurity(text(appJs, "text/javascript; charset=utf-8", 200, { "cache-control": "public, max-age=300" }));
      }
      if (request.method === "GET" && path === "/api/v1/openapi.json") {
        return withSecurity(json(buildOpenApi(config.version)));
      }
      if (request.method === "GET" && path === "/api/v1/overview") {
        return withSecurity(json({ ...await store.getDashboardData(),
          installation: { mode: config.demoMode ? 'demo' : 'live', version: config.version } }, 200, { 'cache-control': 'no-store' }));
      }
      if (request.method === 'GET' && path === '/api/v1/organisations') {
        return withSecurity(json({ organisations: await store.listOrganisations() }));
      }
      if (request.method === "GET" && path === "/api/v1/sites") {
        return withSecurity(json({ sites: await store.listSites(url.searchParams.get("country")) }));
      }
      if (request.method === 'POST' && path === '/api/v1/sites') {
        requireApiKey(request, config, 'admin');
        const site = validateSite(await readJson(request), { demoMode: config.demoMode });
        return withSecurity(json(await store.createSite(site), 201));
      }
      const siteEdit = path.match(/^\/api\/v1\/sites\/([^/]+)$/);
      if (request.method === 'PATCH' && siteEdit) {
        requireApiKey(request, config, 'admin');
        const siteId = requireUuid(siteEdit[1], 'siteId');
        const changes = validateSite(await readJson(request), { partial: true });
        return withSecurity(json(await store.updateSite(siteId, changes)));
      }
      const siteStatus = path.match(/^\/api\/v1\/sites\/([^/]+)\/status$/);
      if (request.method === "GET" && siteStatus) {
        return withSecurity(json(await store.getSiteStatus(siteStatus[1])));
      }
      if (request.method === "GET" && path === "/api/v1/source-connections") {
        return withSecurity(json({ source_connections: await store.listSourceConnections() }));
      }
      if (request.method === 'POST' && path === '/api/v1/source-connections') {
        requireApiKey(request, config, 'admin');
        const source = await validateSource(await readJson(request), { getConnector: registry.getConnector, demoMode: config.demoMode });
        return withSecurity(json(await store.createSource(source), 201));
      }
      const sourceEdit = path.match(/^\/api\/v1\/source-connections\/([^/]+)$/);
      if (request.method === 'PATCH' && sourceEdit) {
        requireApiKey(request, config, 'admin');
        const sourceId = requireUuid(sourceEdit[1], 'sourceId');
        const changes = await readJson(request);
        const source = await store.editSource(sourceId, (prior) => validateSourceChanges(changes, prior,
          { getConnector: registry.getConnector, demoMode: config.demoMode }));
        return withSecurity(json(source));
      }
      const sourceMappings = path.match(/^\/api\/v1\/source-connections\/([^/]+)\/mappings$/);
      if (sourceMappings && ['GET', 'POST'].includes(request.method)) {
        requireApiKey(request, config, 'admin');
        const sourceId = requireUuid(sourceMappings[1], 'sourceId');
        if (request.method === 'GET') return withSecurity(json({ mappings: await store.listMappings(sourceId) }));
        const mapping = validateMapping(await readJson(request));
        return withSecurity(json(await store.createMapping(sourceId, mapping), 201));
      }
      const sourceTest = path.match(/^\/api\/v1\/source-connections\/([^/]+)\/test$/);
      if (request.method === 'POST' && sourceTest) {
        requireApiKey(request, config, 'admin');
        const body = await readJson(request, { allowEmpty: true });
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
          throw Object.assign(new Error('Connection test accepts an empty JSON object only'), { status: 422 });
        }
        const sourceId = requireUuid(sourceTest[1], 'sourceId');
        const target = await store.getSourceAdminContext(sourceId);
        const result = await testSourceConnection({ target, registry, resolveSecrets, demoMode: config.demoMode });
        return withSecurity(json(result, result.connected ? 200 : 502));
      }
      const mappingEdit = path.match(/^\/api\/v1\/source-connections\/([^/]+)\/mappings\/([^/]+)$/);
      if (request.method === 'PATCH' && mappingEdit) {
        requireApiKey(request, config, 'admin');
        const sourceId = requireUuid(mappingEdit[1], 'sourceId'), mappingId = requireUuid(mappingEdit[2], 'mappingId');
        const changes = validateMappingChanges(await readJson(request));
        return withSecurity(json(await store.editMapping(sourceId, mappingId, changes)));
      }
      const sourceAction = path.match(/^\/api\/v1\/source-connections\/([^/]+)\/(enable|disable)$/);
      if (request.method === 'POST' && sourceAction) {
        requireApiKey(request, config, 'admin');
        const sourceId = requireUuid(sourceAction[1], 'sourceId');
        const body = await readJson(request, { allowEmpty: true });
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
          throw Object.assign(new Error('Source action accepts an empty JSON object only'), { status: 422 });
        }
        if (sourceAction[2] === 'disable') return withSecurity(json(await store.disableSource(sourceId)));
        const target = await store.getSourceAdminContext(sourceId);
        if ((target.source.is_demo || registry.getConnector(target.source.plugin_id)?.manifest.demoOnly) && !config.demoMode) {
          throw Object.assign(new Error('Demonstration source disabled in live mode'), { status: 403 });
        }
        if (!target.source.enabled) {
          if (!target.mappings.length && target.source.collection_mode !== 'webhook') {
            throw Object.assign(new Error('Verify at least one community-site mapping before enabling collection'), { status: 422 });
          }
          const result = await testSourceConnection({ target, registry, resolveSecrets, demoMode: config.demoMode });
          if (!result.connected) return withSecurity(json(result, 502));
        }
        return withSecurity(json(await store.enableSource(sourceId, target.source)));
      }
      if (request.method === "GET" && path === "/api/v1/connectors") {
        return withSecurity(json({ connectors: registry.listConnectorManifests() }));
      }
      if (request.method === "GET" && path === "/api/v1/incidents") {
        return withSecurity(json({
          incidents: await store.listIncidents({
            status: url.searchParams.get("status"),
            countryCode: url.searchParams.get("country"),
          }),
        }));
      }
      const acknowledge = path.match(/^\/api\/v1\/incidents\/([^/]+)\/acknowledge$/);
      if (request.method === "POST" && acknowledge) {
        requireApiKey(request, config, "admin");
        const owner = requireText(await readJson(request), "owner", 160);
        return withSecurity(json(await store.acknowledgeIncident(acknowledge[1], owner)));
      }
      const resolve = path.match(/^\/api\/v1\/incidents\/([^/]+)\/resolve$/);
      if (request.method === "POST" && resolve) {
        requireApiKey(request, config, "admin");
        const resolution = requireText(await readJson(request), "resolution", 500);
        return withSecurity(json(await store.resolveIncident(resolve[1], resolution)));
      }
      if (request.method === "POST" && path === "/api/v1/ingest/observations:batch") {
        requireApiKey(request, config, "ingest");
        const result = await store.ingestObservations(validateObservationBatch(await readJson(request)));
        return withSecurity(json(result, 202));
      }
      const webhook = path.match(/^\/api\/v1\/source-connections\/([0-9a-f-]{36})\/webhook$/i);
      if (request.method === 'POST' && webhook) {
        const target = await store.getSourceContext(webhook[1]);
        const ref = target.source.config?.credential_refs?.webhookKey;
        const credentials = await resolveSecrets(ref ? { webhookKey: ref } : {});
        if (!requestHasKey(request, credentials.webhookKey, 'x-hubos-webhook-key')) {
          throw Object.assign(new Error('Valid source webhook key required'), { status: 401 });
        }
        if (target.source.is_demo && !config.demoMode) throw Object.assign(new Error('Demonstration source disabled'), { status: 403 });
        const connector = registry.getConnector(target.source.plugin_id);
        if (!connector?.webhook) throw Object.assign(new Error('Source has no webhook lifecycle'), { status: 422 });
        const normalized = await connector.webhook(await readJson(request, { allowEmpty: true }), { ...target, config: target.source.config,
          credentials, observedAt: new Date() });
        const result = await persistConnectorResult({ store, target, connector, normalized });
        if (result.accepted || result.monitor_samples || result.signals) await store.markSourceCollected(target.source.id, new Date());
        return withSecurity(json(result, 202));
      }

      return withSecurity(json({ error: "Not found" }, 404));
    } catch (error) {
      return withSecurity(errorResponse(error));
    }
  };
}

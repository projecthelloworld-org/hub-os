import indexHtml from "../public/index.html" with { type: "text" };
import appCss from "../public/app.css" with { type: "text" };
import appJs from "../public/app.js" with { type: "text" };

import { listConnectorManifests, getConnector } from "./connectors/registry.js";
import { json, noContent, readJson, requestHasKey, text } from "./http.js";
import { buildOpenApi } from "./openapi.js";
import { StoreError } from "./store/errors.js";
import { requireText, validateObservationBatch } from "./validation.js";
import { safeError } from './privacy.js';
import { resolveCredentials } from './connector-runtime/secrets.js';
import { persistConnectorResult } from './connector-runtime/results.js';
import { profileFor } from './demo/data.js';

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

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
}

function errorResponse(error) {
  const status = error instanceof StoreError ? error.status : error.status ?? 500;
  const message = status >= 500 ? "Unexpected server error" : error.message;
  if (status >= 500) console.error(safeError(error));
  return json({ error: message }, status);
}

export function createApp({ store, config, resolveSecrets = resolveCredentials, registry = { getConnector } }) {
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
        return withSecurity(text(indexHtml, "text/html; charset=utf-8"));
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
        return withSecurity(json(await store.getDashboardData()));
      }
      if (request.method === "GET" && path === "/api/v1/sites") {
        return withSecurity(json({ sites: await store.listSites(url.searchParams.get("country")) }));
      }
      const siteStatus = path.match(/^\/api\/v1\/sites\/([^/]+)\/status$/);
      if (request.method === "GET" && siteStatus) {
        return withSecurity(json(await store.getSiteStatus(siteStatus[1])));
      }
      if (request.method === "GET" && path === "/api/v1/source-connections") {
        return withSecurity(json({ source_connections: await store.listSourceConnections() }));
      }
      if (request.method === "GET" && path === "/api/v1/connectors") {
        return withSecurity(json({ connectors: listConnectorManifests() }));
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
        const normalized = await connector.webhook(await readJson(request), { ...target, config: target.source.config,
          credentials, observedAt: new Date() });
        return withSecurity(json(await persistConnectorResult({ store, target, connector, normalized }), 202));
      }

      return withSecurity(json({ error: "Not found" }, 404));
    } catch (error) {
      return withSecurity(errorResponse(error));
    }
  };
}

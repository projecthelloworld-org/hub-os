import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { buildDemoState } from '../../src/demo/data.js';
import { MemoryStore } from '../../src/store/memory.js';
import { stableId } from '../../src/ids.js';

const state = buildDemoState();
state.sourceConnections.push({ id: stableId('source', 'access-fixture-kuma'), organisation_id: state.organisation.id,
  name: 'Owned access fixture', plugin_id: 'uptime-kuma', connector_type: 'uptime_kuma', enabled: true,
  is_demo: true, config: { adapter_version: '2.5.6', credential_refs: { webhookKey: 'env:ACCESS_FIXTURE_WEBHOOK_KEY' } },
  poll_interval_seconds: 60, freshness_seconds: 300 });
const app = createApp({ store: new MemoryStore(state), config: loadConfig({ HUBOS_ENV: 'test', HUBOS_DEMO_MODE: 'true',
  HUBOS_INGEST_KEY: 'fixture-only-ingest-key', HUBOS_ADMIN_KEY: 'fixture-only-admin-key' }),
  resolveSecrets: async () => ({ webhookKey: 'fixture-only-webhook-key' }) });
Bun.serve({ hostname: '0.0.0.0', port: 3000, fetch: async (request) => {
  const boundary = { authorizationPresent: request.headers.has('authorization'),
    adminKeyExpected: request.headers.get('x-hubos-admin-key') === 'fixture-only-admin-key',
    adminKeyPresent: request.headers.has('x-hubos-admin-key'), ingestKeyPresent: request.headers.has('x-hubos-ingest-key'),
    webhookKeyPresent: request.headers.has('x-hubos-webhook-key') };
  if (new URL(request.url).pathname === '/fixture/header-boundary') return Response.json(boundary);
  const response = await app(request);
  const headers = new Headers(response.headers);
  headers.set('x-fixture-authorization-present', String(boundary.authorizationPresent));
  headers.set('x-fixture-admin-key-present', String(boundary.adminKeyPresent));
  return new Response(response.body, { status: response.status, headers });
} });

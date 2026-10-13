import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/store/memory.js';
import { buildDemoState } from '../src/demo/data.js';
import { createNotificationSender, deliverNextNotification } from '../src/alerts/delivery.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createConnectorRegistry } from '../src/connectors/loader.js';
import kuma from '../src/connectors/uptime-kuma/index.js';
import { parseKumaMetrics, projectKumaSamples } from '../src/kuma/metrics.js';
import { Kuma256Session } from '../src/kuma/adapter-2.5.6.js';

async function fixture() {
  const store = new MemoryStore(buildDemoState());
  const source = store.state.sourceConnections[0];
  source.plugin_id = 'uptime-kuma';
  source.config = { adapter_version: '2.5.6', credential_refs: { webhookKey: 'env:TEST_WEBHOOK_KEY' } };
  const monitor = await store.registerMonitor({ source_connection_id: source.id, external_id: '42',
    name: 'Fixture target (infrastructure)', scope: 'infrastructure', site_id: null });
  return { store, source, monitor };
}

describe('operational incident signals and delivery', () => {
  test('deduplicates repeated active signals, ignores old evidence, and requires explicit recovery', async () => {
    const { store, source, monitor } = await fixture();
    const base = Date.now() - 60000;
    const signal = (state, offset) => ({ rule_id: 'availability', subject_type: 'monitor', subject_id: monitor.id,
      observed_at: new Date(base + offset).toISOString(), state });
    const opened = await store.applySignal(source.id, signal('active', 0));
    expect(opened.transition).toBe('opened');
    expect((await store.applySignal(source.id, signal('active', 1000))).transition).toBe('updated');
    expect((await store.applySignal(source.id, signal('healthy', 0))).transition).toBe('ignored');
    expect((await store.applySignal(source.id, signal('unknown', 2000))).transition).toBe('unknown');
    const incident = store.state.incidents.find((item) => item.id === opened.incident_id);
    expect(incident.status).toBe('open');
    expect(incident.site_id).toBeNull();
    expect(incident.details.scope).toBe('infrastructure');
    expect(store.state.notifications).toHaveLength(1);
    expect((await store.applySignal(source.id, signal('healthy', 3000))).transition).toBe('recovered');
    expect(incident.status).toBe('resolved');
    expect(store.state.notifications).toHaveLength(2);
    expect((await store.applySignal(source.id, signal('healthy', 4000))).transition).toBe('healthy');
    expect(store.state.notifications).toHaveLength(2);
    const next = await store.applySignal(source.id, signal('active', 5000));
    expect(next.transition).toBe('opened');
    expect(next.incident_id).not.toBe(opened.incident_id);
  });

  test('retains acknowledgement and ownership when further active signals arrive', async () => {
    const { store, source, monitor } = await fixture();
    const signal = { rule_id: 'availability', subject_type: 'monitor', subject_id: monitor.id, state: 'active',
      observed_at: new Date(Date.now() - 5000).toISOString() };
    const { incident_id } = await store.applySignal(source.id, signal);
    await store.acknowledgeIncident(incident_id, 'network-support');
    await store.applySignal(source.id, { ...signal, observed_at: new Date().toISOString() });
    const incident = store.state.incidents.find((item) => item.id === incident_id);
    expect(incident.status).toBe('acknowledged');
    expect(incident.owner).toBe('network-support');
    expect(store.state.notifications).toHaveLength(1);
  });

  test('retries delivery durably and reclaims sends after a worker restart', async () => {
    const { store, source, monitor } = await fixture();
    await store.applySignal(source.id, { rule_id: 'availability', subject_type: 'monitor', subject_id: monitor.id,
      state: 'active', observed_at: new Date().toISOString() });
    expect((await deliverNextNotification({ store, send: async () => { throw new Error('SMTP secret'); } })).delivered).toBe(false);
    expect(store.state.notifications[0].last_error).toBe('COLLECTION_FAILED');
    store.state.notifications[0].next_attempt_at = new Date(0).toISOString();
    const old = await store.claimNotification();
    store.state.notifications[0].locked_at = new Date(0).toISOString();
    const resumed = await store.claimNotification();
    await store.finishNotification(old);
    expect(store.state.notifications[0].status).toBe('sending');
    await store.finishNotification(resumed);
    expect(store.state.notifications[0].status).toBe('delivered');
    expect(await store.claimNotification()).toBeNull();
  });

  test('external SMTP requires explicit recipients and uses TLS', async () => {
    expect(() => createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'smtp' })).toThrow('recipients');
    expect(() => createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'smtp', HUBOS_SMTP_HOST: 'smtp.fixture.invalid',
      HUBOS_NOTIFICATION_RECIPIENTS: '' })).toThrow('recipients');
    let settings;
    const send = createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'smtp', HUBOS_SMTP_HOST: 'smtp.fixture.invalid',
      HUBOS_NOTIFICATION_RECIPIENTS: 'operator@fixture.invalid' }, (config) => {
      settings = config;
      return { sendMail: async (message) => { expect(message.to).toEqual(['operator@fixture.invalid']); } };
    });
    expect(settings.requireTLS).toBe(true);
    await send({ id: 'fixture', event_kind: 'opened', incident: { id: 'incident', title: 'Fixture outage', severity: 'high' } });
    expect(createNotificationSender({ HUBOS_NOTIFICATION_MODE: 'disabled' })).toBeNull();
  });

  test('pausing a source fences late monitor evidence and recovery without changing the incident ledger', async () => {
    const { store, source, monitor } = await fixture();
    const signal = { rule_id: 'availability', subject_type: 'monitor', subject_id: monitor.id,
      state: 'active', observed_at: new Date(Date.now() - 5000).toISOString() };
    const opened = await store.applySignal(source.id, signal);
    await store.disableSource(source.id);
    await expect(store.applySignal(source.id, { ...signal, state: 'healthy', observed_at: new Date().toISOString() }))
      .rejects.toThrow('Source is disabled');
    await expect(store.ingestMonitorSamples(source.id, [{ monitor_id: monitor.id, status: 1,
      response_ms: 20, origin: 'webhook', observed_at: new Date().toISOString() }])).rejects.toThrow('Source is disabled');
    await store.markSourceCollected(source.id, new Date());
    const context = await store.getSourceAdminContext(source.id);
    expect(context.source.status).toBe('disabled');
    expect(context.source.last_success_at).toBeNull();
    expect(store.state.monitorSamples).toHaveLength(0);
    expect(store.state.incidents.find((item) => item.id === opened.incident_id).status).toBe('open');
    expect(store.state.notifications).toHaveLength(1);
  });

  test('pausing one source makes its status unknown in both site and console views without changing other evidence', async () => {
    const store = new MemoryStore(buildDemoState());
    const site = (await store.listSites()).find((site) => site.site_code === 'UG-DEMO-01');
    const source = store.state.sourceConnections.find((source) => source.key === 'ug-unifi');
    expect((await store.getSiteStatus(site.id)).statuses.find((status) => status.domain === 'connectivity').status).toBe('healthy');
    await store.disableSource(source.id);
    const statuses = (await store.getSiteStatus(site.id)).statuses;
    expect(statuses.find((status) => status.domain === 'connectivity').status).toBe('unknown');
    expect(statuses.find((status) => status.domain === 'power').status).toBe('healthy');
    const dashboard = await store.getDashboardData();
    expect(dashboard.sites.find((row) => row.id === site.id).statuses.find((status) => status.domain === 'connectivity').status).toBe('unknown');
    await store.enableSource(source.id, (await store.getSourceAdminContext(source.id)).source);
    expect((await store.getSiteStatus(site.id)).statuses.find((status) => status.domain === 'connectivity').status).toBe('unknown');
  });
});

describe('source-scoped generic webhook lifecycle', () => {
  test('pausing while a webhook authenticates rejects its stale context before recording recovery', async () => {
    const { store, source, monitor } = await fixture();
    const opened = await store.applySignal(source.id, { rule_id: 'availability', subject_type: 'monitor', subject_id: monitor.id,
      state: 'active', observed_at: new Date(Date.now() - 5000).toISOString() });
    const app = createApp({ store, config: loadConfig({ HUBOS_DEMO_MODE: 'true' }), registry: createConnectorRegistry([kuma]),
      resolveSecrets: async () => { await store.disableSource(source.id); return { webhookKey: 'fixture-webhook-key' }; } });
    const response = await app(new Request(`http://fixture/api/v1/source-connections/${source.id}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hubos-webhook-key': 'fixture-webhook-key' },
      body: JSON.stringify({ monitor: { id: 42 }, heartbeat: { status: 1, time: new Date().toISOString(), ping: 20 } }),
    }));
    expect(response.status).toBe(422);
    expect(store.state.monitorSamples).toHaveLength(0);
    expect(store.state.incidents.find((incident) => incident.id === opened.incident_id).status).toBe('open');
    expect(store.state.notifications).toHaveLength(1);
  });
  test('authenticated empty connection tests are ignored, not healthy evidence', async () => {
    const { store, source } = await fixture();
    const app = createApp({ store, config: loadConfig({ HUBOS_DEMO_MODE: 'true' }), registry: createConnectorRegistry([kuma]),
      resolveSecrets: async () => ({ webhookKey: 'fixture-webhook-key' }) });
    const read = async (path) => (await app(new Request(`http://fixture${path}`))).json();
    const before = (await read('/api/v1/source-connections')).source_connections.find((item) => item.id === source.id);
    const incidents = (await read('/api/v1/incidents')).incidents.length;
    const post = (key) => app(new Request(`http://fixture/api/v1/source-connections/${source.id}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hubos-webhook-key': key }, body: '',
    }));
    expect((await post('wrong-key')).status).toBe(401);
    const accepted = await post('fixture-webhook-key');
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: 0, signals: 0, monitor_samples: 0 });
    const after = (await read('/api/v1/source-connections')).source_connections.find((item) => item.id === source.id);
    expect(after.last_success_at).toEqual(before.last_success_at);
    expect((await read('/api/v1/incidents')).incidents).toHaveLength(incidents);
  });
  test('rejects the ingestion/admin keys, discards vendor text, and deduplicates Kuma messages', async () => {
    const { store, source, monitor } = await fixture();
    const app = createApp({ store, config: loadConfig({ HUBOS_DEMO_MODE: 'true' }), registry: createConnectorRegistry([kuma]),
      resolveSecrets: async () => ({ webhookKey: 'fixture-webhook-key' }) });
    const payload = { monitor: { id: 42, name: 'secret person name', url: 'https://token:password@private.invalid' },
      heartbeat: { status: 0, time: new Date(Date.now() - 5000).toISOString(), msg: 'secret response body', ping: -1 },
      msg: 'browsing history' };
    const post = (key, body = payload) => app(new Request(`http://fixture/api/v1/source-connections/${source.id}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hubos-webhook-key': key }, body: JSON.stringify(body),
    }));
    expect((await post('local-demo-admin-key')).status).toBe(401);
    expect((await post('local-demo-ingest-key')).status).toBe(401);
    expect((await post('fixture-webhook-key')).status).toBe(202);
    expect((await post('fixture-webhook-key')).status).toBe(202);
    expect(store.state.notifications).toHaveLength(1);
    const persisted = JSON.stringify({ samples: store.state.monitorSamples, signals: store.state.signalStates, incidents: store.state.incidents });
    expect(persisted).not.toContain('secret');
    expect(persisted).not.toContain('browsing history');
    expect(store.state.monitorSamples[0].monitor_id).toBe(monitor.id);
    expect(store.state.monitorSamples[0].response_ms).toBeNull();
  });
});

describe('pinned Kuma adapter and metrics projection', () => {
  test('uses only numeric status/latency and requires fresh matching heartbeat evidence', () => {
    const metrics = parseKumaMetrics('monitor_status{monitor_id="42",monitor_name="Private name",monitor_url="secret"} 1\nmonitor_response_time{monitor_id="42"} 21');
    expect(JSON.stringify([...metrics])).not.toContain('secret');
    const now = new Date();
    const monitor = { id: 'canonical', external_id: '42', interval_seconds: 60, enabled: true };
    const context = { metrics, monitors: [monitor], observedAt: now, liveMonitors: { 42: { active: true, interval: 60 } },
      beats: new Map([['42', { status: 1, time: now.toISOString() }]]) };
    expect(projectKumaSamples(context)[0].status).toBe(1);
    expect(projectKumaSamples(context)[0].response_ms).toBe(21);
    context.beats.get('42').time = '2000-01-01 00:00:00.000';
    expect(projectKumaSamples(context)[0].status).toBeNull();
    context.beats.get('42').time = now.toISOString();
    context.liveMonitors[42].active = false;
    expect(projectKumaSamples(context)[0].status).toBeNull();
    metrics.get('42').status = 3;
    context.liveMonitors[42].active = true;
    expect(projectKumaSamples(context)[0].status).toBeNull();
    expect(() => parseKumaMetrics('monitor_status{monitor_name="missing id"} 1')).toThrow('MONITOR_ID');
  });

  test('pins setup events, preserves existing accounts, and refuses another version', async () => {
    const listeners = new Map();
    const calls = [];
    const fake = {
      on: (name, fn) => { listeners.set(name, fn); }, once: (name, fn) => { listeners.set(name, fn); },
      connect: () => { listeners.get('info')({}); listeners.get('connect')(); }, disconnect() {},
      timeout() { return this; },
      async emitWithAck(name, ...args) {
        calls.push([name, ...args]);
        if (name === 'needSetup') return false;
        if (name === 'login') { listeners.get('info')({ version: '2.5.6' }); return { ok: true }; }
        return { ok: true, monitorID: 42 };
      },
    };
    const session = new Kuma256Session({ url: 'http://fixture', username: 'operator', password: 'private', socketFactory: () => fake });
    await session.open({ allowSetup: true });
    expect(calls.some(([name]) => name === 'setup')).toBe(false);
    await session.addMonitor({ name: 'Fixture', url: 'http://fixture/health' }, 7);
    const add = calls.find(([name]) => name === 'add')[1];
    expect(add.notificationIDList).toEqual({ 7: true });
    expect(add.saveErrorResponse).toBe(false);
    session.close();
    fake.emitWithAck = async (name) => {
      if (name === 'needSetup') return false;
      listeners.get('info')({ version: '3.0.0' });
      return { ok: true };
    };
    await expect(session.open()).rejects.toThrow('KUMA_UNSUPPORTED_VERSION');
  });
});

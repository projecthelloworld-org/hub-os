import { withKumaSession } from '../../kuma/adapter-2.5.6.js';
import { parseKumaMetrics, projectKumaSamples, kumaTimestamp } from '../../kuma/metrics.js';
import { CollectionError } from '../../connector-runtime/http-client.js';

export default {
  manifest: {
    id: 'uptime-kuma', name: 'Uptime Kuma 2.5.6 reachability', version: '1.0.0', protocolVersion: '1.0',
    collectionModes: ['scheduled-pull', 'webhook'], capabilities: ['service-availability', 'response-time', 'operational-alerts'],
  },
  async validateConfig(config) { return { valid: config.adapter_version === '2.5.6', errors: ['Kuma adapter version must be 2.5.6'] }; },
  async provision(context) {
    const { provisionKuma } = await import('../../kuma/bootstrap.js');
    return provisionKuma(context);
  },
  async collect({ source, credentials, monitors, observedAt, requestText, signal }) {
    const text = await requestText(new URL('/metrics', source.base_url), {
      headers: { authorization: `Basic ${Buffer.from(`:${credentials.metricsKey}`).toString('base64')}` }, signal,
    });
    const metrics = parseKumaMetrics(text);
    return withKumaSession({ url: source.base_url, username: credentials.username, password: credentials.password }, async (session) => {
      if (signal.aborted) throw new CollectionError('COLLECTION_CANCELLED');
      return projectKumaSamples({ metrics, beats: session.beats, liveMonitors: session.monitors, monitors, observedAt });
    });
  },
  async normalize(samples) {
    return { envelopes: [], monitorSamples: samples,
      signals: samples.map((sample) => ({ rule_id: 'availability', subject_type: 'monitor', subject_id: sample.monitor_id,
        observed_at: sample.observed_at, state: sample.status === 1 ? 'healthy' : sample.status === 0 ? 'active' : 'unknown' })) };
  },
  async webhook(body, { monitors }) {
    if (!body?.heartbeat && !body?.monitor) return { envelopes: [], monitorSamples: [], signals: [] }; // Native test notification.
    const monitor = monitors.find((monitor) => monitor.enabled && String(monitor.external_id) === String(body.monitor?.id));
    const beat = body.heartbeat;
    const time = kumaTimestamp(beat?.time);
    if (!monitor || !time || ![0, 1, 2, 3].includes(beat.status)) throw new CollectionError('KUMA_INVALID_WEBHOOK');
    const sample = { monitor_id: String(monitor.id), observed_at: time, status: [0, 1].includes(beat.status) ? beat.status : null,
      response_ms: beat.status === 1 && Number.isFinite(beat.ping) && beat.ping >= 0 ? beat.ping : null, origin: 'webhook' };
    return this.normalize([sample]);
  },
  async health({ source, credentials, requestText }) {
    const text = await requestText(new URL('/metrics', source.base_url), {
      headers: { authorization: `Basic ${Buffer.from(`:${credentials.metricsKey}`).toString('base64')}` },
    });
    parseKumaMetrics(text);
    return withKumaSession({ url: source.base_url, username: credentials.username, password: credentials.password },
      async () => ({ status: 'healthy', version: '2.5.6' }));
  },
};

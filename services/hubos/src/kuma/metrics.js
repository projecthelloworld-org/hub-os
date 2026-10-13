import { CollectionError } from '../connector-runtime/http-client.js';

export function parseKumaMetrics(text) {
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw new CollectionError('KUMA_MALFORMED_METRICS');
  const result = new Map();
  for (const line of text.split('\n')) {
    if (!/^(monitor_status|monitor_response_time)\{/.test(line)) continue;
    const match = line.match(/^(monitor_status|monitor_response_time)\{(.*)\}\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i);
    if (!match) throw new CollectionError('KUMA_MALFORMED_METRICS');
    // Extract only a numeric monitor id. URL, name, hostname and arbitrary tags are discarded.
    const id = match[2].match(/(?:^|,)monitor_id="(\d+)"(?:,|$)/)?.[1];
    if (!id) throw new CollectionError('KUMA_MISSING_MONITOR_ID');
    const value = Number(match[3]);
    if (!Number.isFinite(value)) throw new CollectionError('KUMA_MALFORMED_METRICS');
    const record = result.get(id) ?? {};
    if (match[1] === 'monitor_status') record.status = value;
    else record.response_ms = value >= 0 ? value : null;
    result.set(id, record);
  }
  return result;
}

export function kumaTimestamp(value) {
  if (typeof value !== 'string') return null;
  const iso = value.replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : 'Z');
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

export function projectKumaSamples({ metrics, beats, liveMonitors, monitors, observedAt }) {
  return monitors.filter((monitor) => monitor.enabled).map((monitor) => {
    const id = String(monitor.external_id);
    const metric = metrics.get(id);
    const beat = beats.get(id);
    const live = liveMonitors[id];
    const time = kumaTimestamp(beat?.time);
    const fresh = time && Date.parse(time) <= observedAt.getTime() + 60000
      && Date.parse(time) >= observedAt.getTime() - (live?.interval ?? monitor.interval_seconds) * 2000;
    const supported = [0, 1].includes(metric?.status) && beat?.status === metric.status;
    const valid = Boolean(live?.active && fresh && supported);
    return { monitor_id: String(monitor.id), observed_at: valid ? time : observedAt.toISOString(),
      status: valid ? metric.status : null, response_ms: valid && metric.status === 1 ? metric.response_ms ?? null : null,
      origin: 'metrics' };
  });
}

import { apiBase, approvedEnvelopes, fail, integer, uuid } from '../../connector-runtime/local-api.js';

async function session(context) {
  const { source, config, credentials, requestJson, signal } = context;
  const base = apiBase(source, config);
  if (['api.ui.com', 'unifi.ui.com'].includes(base.hostname)) fail('UNIFI_LOCAL_API_REQUIRED');
  if (!credentials.apiKey) fail('CREDENTIAL_UNAVAILABLE');
  const get = (path) => requestJson(new URL(path, base), {
    headers: { accept: 'application/json', 'x-api-key': credentials.apiKey }, signal,
  });
  const info = await get('v1/info');
  if (typeof info?.applicationVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(info.applicationVersion)) fail();
  return { get, version: info.applicationVersion };
}

async function pages(get, path, validate) {
  const items = [], ids = new Set();
  let total;
  for (let page = 0, offset = 0; page < 40; page++) {
    const response = await get(`${path}?offset=${offset}&limit=50`);
    if (!Array.isArray(response?.data) || !integer(response.offset) || response.offset !== offset
      || !integer(response.limit, 1) || response.limit > 200 || !integer(response.count)
      || response.count !== response.data.length || response.count > response.limit
      || !integer(response.totalCount) || response.totalCount > 2000
      || (total !== undefined && response.totalCount !== total)) fail('SOURCE_INCOMPLETE_INVENTORY');
    total = response.totalCount;
    for (const item of response.data) {
      if (!validate(item) || ids.has(item.id)) fail('SOURCE_INCOMPLETE_INVENTORY');
      ids.add(item.id); items.push(item);
    }
    offset += response.count;
    if (offset === total) return items;
    if (!response.count || offset > total) fail('SOURCE_INCOMPLETE_INVENTORY');
  }
  fail('SOURCE_COLLECTION_LIMIT');
}

const siteShape = (v) => uuid(v?.id) && typeof v.name === 'string' && typeof v.internalReference === 'string';
const deviceShape = (v) => uuid(v?.id) && ['name', 'model', 'macAddress', 'ipAddress', 'state'].every((key) => typeof v[key] === 'string')
  && Array.isArray(v.features) && Array.isArray(v.interfaces);
const clientShape = (v) => uuid(v?.id) && typeof v.name === 'string' && ['WIRED', 'WIRELESS', 'VPN', 'TELEPORT'].includes(v.type)
  && v.access && typeof v.access === 'object' && (!['WIRED', 'WIRELESS'].includes(v.type)
    || (typeof v.macAddress === 'string' && uuid(v.uplinkDeviceId) && typeof v.access.type === 'string'));

export default {
  manifest: { id: 'unifi', name: 'UniFi official local Network API', version: '1.0.0', protocolVersion: '1.0',
    collectionModes: ['controller-pull'], capabilities: ['network-inventory', 'network-device-health'] },
  async validateConfig(config = {}) {
    return { valid: typeof config.credential_refs?.apiKey === 'string'
      && (config.statistics_max_age_seconds === undefined || (integer(config.statistics_max_age_seconds, 30) && config.statistics_max_age_seconds <= 86400)), errors: [] };
  },
  async collect(context) {
    const { get, version } = await session(context);
    const sites = await pages(get, 'v1/sites', siteShape);
    const rows = [];
    for (const mapping of context.mappings) {
      if (!sites.some((site) => site.id === mapping.external_id)) fail('UNMAPPED_IDENTIFIER');
      const path = `v1/sites/${mapping.external_id}`;
      const devices = await pages(get, `${path}/devices`, (value) => deviceShape(value)
        && (!version.startsWith('10.') || (typeof value.firmwareUpdatable === 'boolean' && typeof value.supported === 'boolean')));
      const clients = await pages(get, `${path}/clients`, clientShape);
      if (devices.length > 200) fail('SOURCE_COLLECTION_LIMIT');
      const records = [ ['network.devices.total.count', devices.length],
        ['network.devices.online.count', devices.filter((v) => v.state === 'ONLINE').length],
        ['network.devices.offline.count', devices.filter((v) => v.state === 'OFFLINE').length],
        ['network.devices.other.count', devices.filter((v) => !['ONLINE', 'OFFLINE'].includes(v.state)).length],
        ['network.clients.connected.count', clients.length] ];
      for (const type of ['WIRED', 'WIRELESS', 'VPN', 'TELEPORT']) records.push([
        `network.clients.${type.toLowerCase()}.count`, clients.filter((v) => v.type === type).length]);
      const cpu = [], memory = [], uptime = [];
      let fresh = 0;
      for (const device of devices) {
        const stats = await get(`${path}/devices/${device.id}/statistics/latest`);
        if (!stats?.interfaces || typeof stats.interfaces !== 'object' || Array.isArray(stats.interfaces)) fail();
        for (const [key, max] of [['uptimeSec', Infinity], ['cpuUtilizationPct', 100], ['memoryUtilizationPct', 100]]) {
          if (stats[key] != null && (!Number.isFinite(stats[key]) || stats[key] < 0 || stats[key] > max)) fail();
        }
        const heartbeat = Date.parse(stats.lastHeartbeatAt);
        const age = context.observedAt.getTime() - heartbeat;
        if (!Number.isFinite(heartbeat) || age < -60000 || age > (context.config.statistics_max_age_seconds ?? 300) * 1000) continue;
        fresh++;
        if (stats.cpuUtilizationPct != null) cpu.push(stats.cpuUtilizationPct);
        if (stats.memoryUtilizationPct != null) memory.push(stats.memoryUtilizationPct);
        if (stats.uptimeSec != null) uptime.push(stats.uptimeSec);
      }
      records.push(['network.statistics.fresh_device.count', fresh]);
      if (cpu.length) records.push(['network.device.cpu.average.percent', cpu.reduce((a, b) => a + b, 0) / cpu.length, 'percent']);
      if (memory.length) records.push(['network.device.memory.average.percent', memory.reduce((a, b) => a + b, 0) / memory.length, 'percent']);
      if (uptime.length) records.push(['network.device.uptime.minimum.seconds', Math.min(...uptime), 'seconds']);
      rows.push({ external_id: mapping.external_id, site_id: mapping.site_id,
        observed_at: context.observedAt.toISOString(), records, cpu_samples: cpu.length, memory_samples: memory.length });
    }
    const grouped = new Map();
    for (const row of rows) {
      const prior = grouped.get(row.site_id);
      if (!prior) { grouped.set(row.site_id, row); continue; }
      for (const record of row.records) {
        const existing = prior.records.find(([metric]) => metric === record[0]);
        if (!existing) { prior.records.push(record); continue; }
        if (record[0].endsWith('.count')) existing[1] += record[1];
        else if (record[0].endsWith('.minimum.seconds')) existing[1] = Math.min(existing[1], record[1]);
        else {
          const key = record[0].includes('.cpu.') ? 'cpu_samples' : 'memory_samples';
          existing[1] = (existing[1] * prior[key] + record[1] * row[key]) / (prior[key] + row[key]);
        }
      }
      prior.cpu_samples += row.cpu_samples; prior.memory_samples += row.memory_samples;
    }
    return [...grouped.values()].map(({ external_id, observed_at, records }) => ({ external_id, observed_at, records }));
    // No names, addresses, client identifiers or raw statistics cross this boundary.
  },
  async normalize(rows, { source }) { return approvedEnvelopes(rows, 'unifi', source); },
  async health(context) {
    const { get, version } = await session(context);
    await pages(get, 'v1/sites', siteShape);
    return { status: 'healthy', version }; // API access, not WAN availability.
  },
};

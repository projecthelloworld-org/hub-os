import { createHash } from 'node:crypto';
import { apiBase, approvedEnvelopes, fail, integer } from '../../connector-runtime/local-api.js';

async function session({ source, config, credentials, requestJson, signal }) {
  const base = apiBase(source, config);
  if (!credentials.username || !credentials.password) fail('CREDENTIAL_UNAVAILABLE');
  let token;
  async function login() {
    const value = await requestJson(new URL('rest/public/jwt/login', base), { method: 'POST', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ login: credentials.username,
        password: createHash('md5').update(credentials.password).digest('hex').toUpperCase() }) });
    if (typeof value?.id_token !== 'string' || !value.id_token) fail();
    token = value.id_token;
  }
  await login();
  return async (path, body) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await requestJson(new URL(`rest/private/${path}`, base), { signal,
          method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (response?.status !== 'OK') fail('HEADWIND_APPLICATION_ERROR');
        return response.data;
      } catch (error) {
        if (attempt || error.code !== 'SOURCE_AUTHENTICATION_FAILED') throw error;
        await login();
      }
    }
  };
}

export default {
  manifest: { id: 'headwind', name: 'Headwind Community inventory and check-ins', version: '1.0.0', protocolVersion: '1.0',
    collectionModes: ['controller-pull'], capabilities: ['device-inventory', 'device-check-ins'] },
  async validateConfig(config = {}) {
    return { valid: ['username', 'password'].every((key) => typeof config.credential_refs?.[key] === 'string')
      && (config.check_in_max_age_seconds === undefined || (integer(config.check_in_max_age_seconds, 60) && config.check_in_max_age_seconds <= 2592000)), errors: [] };
  },
  async collect(context) {
    const read = await session(context), devices = [], seen = new Set();
    const known = new Set();
    for (const [path, prefix] of [['groups/search', 'group'], ['configurations/list', 'configuration']]) {
      const list = await read(path);
      if (!Array.isArray(list) || list.some((v) => !integer(v.id, 1))) fail();
      for (const item of list) known.add(`${prefix}:${item.id}`);
    }
    if (context.mappings.some((mapping) => !known.has(mapping.external_id))) fail('UNMAPPED_IDENTIFIER');
    let total;
    for (let pageNum = 1; pageNum <= 40; pageNum++) {
      const data = await read('devices/search', { pageSize: 50, pageNum, sortBy: 'NUMBER', sortDir: 'ASC' });
      const page = data?.devices;
      if (!Array.isArray(page?.items) || !integer(page.totalItemsCount) || page.totalItemsCount > 2000
        || page.items.length > 50 || (total !== undefined && total !== page.totalItemsCount)) fail('SOURCE_INCOMPLETE_INVENTORY');
      total = page.totalItemsCount;
      for (const device of page.items) {
        if (!integer(device.id, 1) || seen.has(device.id)
          || (device.configurationId != null && !integer(device.configurationId, 1))
          || (device.groups != null && (!Array.isArray(device.groups) || device.groups.some((v) => !integer(v.id, 1))))) fail();
        seen.add(device.id); devices.push(device);
      }
      if (pageNum * 50 >= total) break;
      if (pageNum === 40) fail('SOURCE_COLLECTION_LIMIT');
    }
    if (devices.length !== total) fail('SOURCE_INCOMPLETE_INVENTORY');
    const assignments = new Map(), rows = new Map();
    for (const mapping of context.mappings) {
      if (!/^(group|configuration):[1-9]\d*$/.test(mapping.external_id)) fail('INVALID_HEADWIND_MAPPING');
      if (!rows.has(mapping.site_id)) rows.set(mapping.site_id, { external_id: mapping.external_id,
        observed_at: context.observedAt.toISOString(), counts: [0, 0, 0, 0] });
      assignments.set(mapping.external_id, mapping.site_id);
    }
    for (const device of devices) {
      const identifiers = [`configuration:${device.configurationId}`, ...(device.groups ?? []).map((group) => `group:${group.id}`)];
      const sites = new Set(identifiers.map((id) => assignments.get(id)).filter(Boolean));
      if (sites.size > 1) fail('AMBIGUOUS_DEVICE_MAPPING');
      if (!sites.size) continue;
      const row = rows.get([...sites][0]); row.counts[0]++;
      const time = device.lastUpdate, age = context.observedAt.getTime() - time;
      if (!integer(time, 1) || age < -60000) row.counts[3]++;
      else if (age > (context.config.check_in_max_age_seconds ?? 86400) * 1000) row.counts[2]++;
      else row.counts[1]++;
    }
    return [...rows.values()].map(({ counts, ...row }) => ({ ...row, records: [
      ['devices.inventory.count', counts[0]], ['devices.check_in.recent.count', counts[1]],
      ['devices.check_in.stale.count', counts[2]], ['devices.check_in.unknown.count', counts[3]],
    ] }));
  },
  async normalize(rows, { source }) { return approvedEnvelopes(rows, 'headwind', source); },
  async health(context) {
    const read = await session(context);
    for (const path of ['groups/search', 'configurations/list']) {
      const list = await read(path);
      if (!Array.isArray(list) || list.some((v) => !integer(v.id, 1))) fail();
    }
    return { status: 'healthy' };
  },
};

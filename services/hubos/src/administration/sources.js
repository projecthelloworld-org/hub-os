import { boundedText, requireUuid } from './sites.js';
import { apiBase } from '../connector-runtime/local-api.js';

const fail = (message) => { throw Object.assign(new Error(message), { status: 422 }); };
const fields = ['organisation_id', 'name', 'plugin_id', 'collection_mode', 'base_url', 'config', 'is_demo', 'poll_interval_seconds', 'freshness_seconds'];
const integer = (value, fallback, maximum, field) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 10 || result > maximum) fail(`${field} is outside its supported range`);
  return result;
};

function nonSecretConfig(config) {
  if (new TextEncoder().encode(JSON.stringify(config)).byteLength > 16384) fail('Source configuration exceeds 16 KiB');
  let nodes = 0;
  const inspect = (value, depth = 0) => {
    if (++nodes > 512 || depth > 6) fail('Source configuration is too complex');
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return; }
    for (const [key, setting] of Object.entries(value)) {
      if (depth === 0 && key === 'credential_refs') {
        if (!setting || typeof setting !== 'object' || Array.isArray(setting)) fail('Credential references must be an object');
        for (const [name, reference] of Object.entries(setting)) {
          if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) || typeof reference !== 'string' || reference.length > 1024
            || /[\u0000-\u001f\u007f]/.test(reference)
            || (!/^env:[A-Z][A-Z0-9_]*$/.test(reference) && !/^file:\/.+/.test(reference))) fail('Use an environment or absolute-file credential reference');
        }
      } else {
        if (/password|passwd|secret|token|api.?key|authorization|credentials?/i.test(key)) fail('Literal credential settings are not permitted');
        if (key === 'mapping_policy') fail('Automatic mapping policies are reserved for tool provisioning');
        inspect(setting, depth + 1);
      }
    }
  };
  inspect(config);
}

export async function validateSource(body, { getConnector, demoMode = false }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Source metadata must be an object');
  if (Object.keys(body).some((key) => !fields.includes(key))) fail('Unsupported source field');
  const source = { organisation_id: requireUuid(body.organisation_id, 'organisation_id'),
    name: boundedText(body.name, 'name', 160), plugin_id: boundedText(body.plugin_id, 'plugin_id', 80) };
  const connector = getConnector(source.plugin_id);
  if (!connector) fail('Installed connector plugin required');
  if (typeof body.collection_mode !== 'string' || !connector.manifest.collectionModes.includes(body.collection_mode.replaceAll('_', '-'))) {
    fail('Collection mode is not supported by this plugin');
  }
  source.collection_mode = body.collection_mode.replaceAll('-', '_');
  if (body.is_demo !== undefined && typeof body.is_demo !== 'boolean') fail('is_demo must be a boolean');
  source.is_demo = body.is_demo ?? false;
  if (source.is_demo && !demoMode) fail('Demonstration sources cannot be created in live mode');
  source.config = body.config ?? {};
  if (!source.config || typeof source.config !== 'object' || Array.isArray(source.config)) fail('Source configuration must be an object');
  nonSecretConfig(source.config);
  if ((connector.manifest.demoOnly || source.config.demo === true) && !source.is_demo) fail('Demonstration collectors require synthetic source classification');
  const validation = await connector.validateConfig(source.config);
  if (!validation?.valid) fail('Configuration is not valid for this plugin');
  source.base_url = body.base_url ?? null;
  if (source.base_url !== null) {
    if (typeof source.base_url !== 'string' || source.base_url.length > 2048 || /[\u0000-\u0020\u007f]/.test(source.base_url)) fail('Invalid source URL');
    try { apiBase(source, source.config); } catch { fail('Source URL requires verified HTTPS or explicit local HTTP'); }
  }
  source.poll_interval_seconds = integer(body.poll_interval_seconds, 60, 86400, 'poll_interval_seconds');
  source.freshness_seconds = integer(body.freshness_seconds, 300, 604800, 'freshness_seconds');
  return source;
}

export async function validateSourceChanges(body, source, options) {
  const editable = ['name', 'base_url', 'config', 'poll_interval_seconds', 'freshness_seconds'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length
    || Object.keys(body).some((field) => !editable.includes(field))) fail('Unsupported or immutable source field');
  const complete = Object.fromEntries(fields.map((field) => [field, source[field]]));
  return validateSource({ ...complete, ...body }, options);
}

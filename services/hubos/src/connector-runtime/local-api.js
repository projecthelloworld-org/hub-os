import { CollectionError } from './http-client.js';

export const fail = (code = 'SOURCE_MALFORMED_RESPONSE') => { throw new CollectionError(code); };
export const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
export const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// HTTP is an explicit local deployment exception, never an implicit TLS fallback.
export function apiBase(source, config = {}) {
  let url;
  try { url = new URL(source.base_url); } catch { fail('INVALID_SOURCE_URL'); }
  if (url.username || url.password || url.search || url.hash
    || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && config.allow_local_http !== true)) fail('SOURCE_TLS_REQUIRED');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !/^[a-z][a-z0-9-]*$/.test(url.hostname)) fail('SOURCE_TLS_REQUIRED');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  return url;
}

export function approvedEnvelopes(rows, connectorId, source) {
  return { envelopes: rows.filter((row) => row.records.length).map((row) => ({
    schema_version: '1.0', connector_id: connectorId, source_connection_id: source.id,
    external_entity: { type: 'site', id: row.external_id },
    external_record_id: `${connectorId}:${row.external_id}:${row.observed_at}`,
    observed_at: row.observed_at,
    records: row.records.map(([metric, value, unit = 'count', quality = 'valid']) => ({ metric, value, unit, quality,
      attributes: { scope: source.is_demo ? 'synthetic' : 'community', synthetic: Boolean(source.is_demo) } })),
  })) };
}

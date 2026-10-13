const scopes = new Set(['community', 'infrastructure', 'synthetic']);

// Project evidence onto an explicit vocabulary; never copy arbitrary vendor attributes.
export function sanitizeAttributes(value = {}) {
  value ??= {};
  const result = {};
  if (typeof value.synthetic === 'boolean') result.synthetic = value.synthetic;
  if (scopes.has(value.scope)) result.scope = value.scope;
  if (typeof value.connector_id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.connector_id)) {
    result.connector_id = value.connector_id;
  }
  if (Number.isInteger(value.sample_interval_seconds) && value.sample_interval_seconds >= 10
      && value.sample_interval_seconds <= 86400) result.sample_interval_seconds = value.sample_interval_seconds;
  return result;
}

export function safeError(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'COLLECTION_FAILED';
}

export function evidenceProjection(observations) {
  return {
    schema_version: '1.0',
    observations: observations.map((item) => ({
      site_id: item.site_id, metric: item.metric, value: item.value,
      unit: item.unit, quality: item.quality, observed_at: item.observed_at,
      attributes: sanitizeAttributes(item.attributes),
    })),
  };
}

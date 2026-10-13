import { sanitizeAttributes } from '../privacy.js';

const allowedModes = new Set(["api-pull", "controller-pull", "webhook", "file-import", "site-agent-push", "scheduled-pull"]);

export function validateConnector(connector) {
  const { manifest } = connector ?? {};
  if (!manifest || typeof manifest !== "object") throw new Error("Connector manifest is required");
  for (const field of ["id", "name", "version", "protocolVersion"]) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) throw new Error(`Connector manifest field ${field} is required`);
  }
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(manifest.id)) throw new Error('Invalid connector id');
  if (manifest.protocolVersion !== '1.0') throw new Error('Unsupported connector protocol version');
  if (manifest.demoOnly !== undefined && typeof manifest.demoOnly !== 'boolean') throw new Error('demoOnly must be a boolean');
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Connector version must be semver');
  if (!Array.isArray(manifest.collectionModes) || manifest.collectionModes.length === 0) {
    throw new Error(`Connector ${manifest.id} must declare at least one collection mode`);
  }
  if (manifest.collectionModes.some((mode) => !allowedModes.has(mode))) {
    throw new Error(`Connector ${manifest.id} declares an unsupported collection mode`);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error(`Connector ${manifest.id} must declare capabilities`);
  }
  for (const method of ["validateConfig", "collect", "normalize", "health"]) {
    if (typeof connector[method] !== "function") {
      throw new Error(`Connector ${manifest.id} must implement ${method}()`);
    }
  }
  for (const method of ['provision', 'webhook']) {
    if (connector[method] !== undefined && typeof connector[method] !== 'function') {
      throw new Error(`Optional lifecycle ${method} must be a function`);
    }
  }
  return connector;
}

export function flattenEnvelope(envelope) {
  if (envelope.schema_version !== "1.0") throw new Error("Unsupported connector envelope version");
  if (!envelope.source_connection_id || !envelope.external_entity?.id) {
    throw new Error("Connector envelope is missing its source or external entity");
  }
  if (!Array.isArray(envelope.records) || !envelope.records.length || envelope.records.length > 1000) {
    throw new Error('Connector envelope requires between 1 and 1000 records');
  }
  return envelope.records.map((record) => ({
    site_id: envelope.external_entity.hubos_id,
    site_code: envelope.external_entity.site_code,
    source_connection_id: envelope.source_connection_id,
    external_record_id: envelope.external_record_id,
    external_entity_id: envelope.external_entity.id,
    metric: record.metric,
    value: record.value,
    unit: record.unit ?? null,
    quality: record.quality ?? "valid",
    observed_at: envelope.observed_at,
    attributes: sanitizeAttributes({ ...(record.attributes ?? {}), connector_id: envelope.connector_id }),
  }));
}

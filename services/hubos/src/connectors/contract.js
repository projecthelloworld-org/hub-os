const allowedModes = new Set(["api-pull", "controller-pull", "webhook", "file-import", "site-agent-push", "scheduled-pull"]);

export function validateConnector(connector) {
  const { manifest } = connector;
  if (!manifest || typeof manifest !== "object") throw new Error("Connector manifest is required");
  for (const field of ["id", "name", "version", "protocolVersion"]) {
    if (!manifest[field]) throw new Error(`Connector manifest field ${field} is required`);
  }
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
  return connector;
}

export function flattenEnvelope(envelope) {
  if (envelope.schema_version !== "1.0") throw new Error("Unsupported connector envelope version");
  if (!envelope.source_connection_id || !envelope.external_entity?.id) {
    throw new Error("Connector envelope is missing its source or external entity");
  }
  return envelope.records.map((record) => ({
    site_id: envelope.external_entity.hubos_id,
    site_code: envelope.external_entity.site_code,
    source_connection_id: envelope.source_connection_id,
    external_record_id: envelope.external_record_id,
    metric: record.metric,
    value: record.value,
    unit: record.unit ?? null,
    quality: record.quality ?? "valid",
    observed_at: envelope.observed_at,
    attributes: { ...(record.attributes ?? {}), connector_id: envelope.connector_id },
  }));
}

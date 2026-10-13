// Deliberately synthetic. Replace collect() with a read-only upstream client for real use.
export default {
  manifest: {
    id: 'starter-environment', name: 'Starter environment plugin (synthetic)',
    version: '1.0.0', protocolVersion: '1.0', collectionModes: ['scheduled-pull'],
    capabilities: ['environment-telemetry'],
  },
  async validateConfig(config) {
    return { valid: config.demo === true && Number.isFinite(config.temperature),
      errors: ['The starter requires demo mode and a numeric temperature'] };
  },
  async collect({ source, mappings, config, observedAt }) {
    if (!source.is_demo) throw new Error('Starter connector is demonstration-only');
    return { source_id: source.id, at: observedAt.toISOString(),
      rows: mappings.map((mapping) => ({ id: mapping.external_id, value: config.temperature })) };
  },
  async normalize(raw) {
    return { envelopes: raw.rows.map((row) => ({
      schema_version: '1.0', connector_id: 'starter-environment', source_connection_id: raw.source_id,
      external_entity: { type: 'site', id: row.id }, external_record_id: `starter:${row.id}:${raw.at}`,
      observed_at: raw.at, records: [{ metric: 'environment.temperature.celsius', value: row.value,
        unit: 'C', attributes: { synthetic: true, scope: 'synthetic' } }],
    })), statuses: [] };
  },
  async health() { return { status: 'healthy', synthetic: true }; },
};

import { validateConnector, flattenEnvelope } from './contract.js';
import { validateObservationBatch } from '../validation.js';

// Reusable by local plugin authors; this checks protocol shape, not deployment compatibility.
export async function checkConnectorConformance(connector, context) {
  validateConnector(connector);
  const validation = await connector.validateConfig(context.config);
  if (!validation?.valid) throw new Error('Conformance fixture configuration is invalid');
  const raw = await connector.collect(context);
  const normalized = await connector.normalize(raw, context);
  if (!Array.isArray(normalized?.envelopes)) throw new Error('Connector must return envelopes');
  let count = 0;
  for (const envelope of normalized.envelopes) {
    if (envelope.connector_id !== connector.manifest.id || envelope.source_connection_id !== context.source.id) {
      throw new Error('Envelope connector/source identity mismatch');
    }
    const mapping = context.mappings.find((item) => item.external_id === envelope.external_entity?.id);
    if (!mapping) throw new Error('Conformance fixture contains an unmapped identifier');
    const observations = flattenEnvelope({ ...envelope,
      external_entity: { ...envelope.external_entity, hubos_id: mapping.site_id } });
    count += validateObservationBatch({ observations }).length;
  }
  return { envelopes: normalized.envelopes.length, observations: count };
}

import { flattenEnvelope } from '../connectors/contract.js';
import { validateObservationBatch } from '../validation.js';
import { evidenceProjection } from '../privacy.js';
import { validateSignal } from '../alerts/signals.js';
import { CollectionError } from './http-client.js';

export async function persistConnectorResult({ store, target, connector, normalized, runId = null }) {
  if (!Array.isArray(normalized?.envelopes)) throw new CollectionError('INVALID_CONNECTOR_ENVELOPE');
  const envelopes = normalized.envelopes.map((envelope) => {
    const mapping = target.mappings.find((item) => item.external_id === envelope.external_entity?.id);
    if (!mapping || String(envelope.source_connection_id) !== String(target.source.id)) throw new CollectionError('UNMAPPED_IDENTIFIER');
    return { ...envelope, connector_id: connector.manifest.id,
      external_entity: { ...envelope.external_entity, hubos_id: mapping.site_id, site_code: mapping.site_code },
      records: envelope.records.map((record) => ({ ...record, attributes: {
        ...record.attributes, synthetic: Boolean(target.source.is_demo || mapping.is_demo),
        sample_interval_seconds: target.source.poll_interval_seconds,
      } })),
    };
  });
  const batches = envelopes.map((envelope) => validateObservationBatch({ observations: flattenEnvelope(envelope) }));
  const samples = normalized.monitorSamples ?? [];
  const signals = normalized.signals ?? [];
  const statuses = normalized.statuses ?? [];
  if (samples.length > 1000 || signals.length > 1000 || statuses.length > 1000) throw new CollectionError('CONNECTOR_RESULT_TOO_LARGE');
  if (samples.some((sample) => !(target.monitors ?? []).some((monitor) => String(monitor.id) === sample.monitor_id && monitor.enabled))) {
    throw new CollectionError('UNMAPPED_IDENTIFIER');
  }
  const projectedSamples = samples.map((sample) => {
    if (!Number.isFinite(Date.parse(sample.observed_at)) || Date.parse(sample.observed_at) > Date.now() + 60000
      || ![0, 1, null].includes(sample.status) || !['webhook', 'metrics'].includes(sample.origin)
      || (sample.response_ms != null && (!Number.isFinite(sample.response_ms) || sample.response_ms < 0))) {
      throw new CollectionError('INVALID_MONITOR_SAMPLE');
    }
    return { monitor_id: sample.monitor_id, observed_at: new Date(sample.observed_at).toISOString(),
      status: sample.status, response_ms: sample.status === 1 ? sample.response_ms ?? null : null, origin: sample.origin };
  });
  const projectedSignals = signals.map(validateSignal);
  if (projectedSignals.some((signal) => signal.subject_type === 'monitor'
    ? !(target.monitors ?? []).some((monitor) => String(monitor.id) === signal.subject_id && monitor.enabled)
    : !target.mappings.some((mapping) => mapping.site_id === signal.subject_id))) throw new CollectionError('UNMAPPED_IDENTIFIER');
  if (statuses.some((status) => !target.mappings.some((mapping) => mapping.site_id === status.site_id))) throw new CollectionError('UNMAPPED_IDENTIFIER');
  if (statuses.some((status) => !['connectivity', 'power', 'devices', 'usage', 'survey', 'support'].includes(status.domain)
    || !['healthy', 'degraded', 'critical', 'unknown'].includes(status.status)
    || Number.isNaN(Date.parse(status.observed_at)))) throw new CollectionError('INVALID_CONNECTOR_STATUS');
  const summary = { accepted: 0, duplicates: 0, rejected: 0, monitor_samples: 0, signals: 0 };
  // All identifiers and shapes are validated before any vendor evidence is persisted.
  for (const [index, envelope] of envelopes.entries()) {
    const result = await store.ingestObservations(batches[index]);
    if (result.rejected) throw new CollectionError('OBSERVATION_REJECTED');
    await store.recordRawPayload({ sourceConnectionId: envelope.source_connection_id, connectorRunId: runId,
      externalRecordId: envelope.external_record_id, observedAt: envelope.observed_at, payload: evidenceProjection(batches[index]) });
    summary.accepted += result.accepted;
    summary.duplicates += result.duplicates;
  }
  if (projectedSamples.length) summary.monitor_samples = (await store.ingestMonitorSamples(target.source.id, projectedSamples)).accepted;
  for (const signal of projectedSignals) { await store.applySignal(target.source.id, signal); summary.signals += 1; }
  await store.upsertStatuses(statuses.map((status) => ({
    site_id: status.site_id, domain: status.domain, status: status.status, observed_at: status.observed_at,
    reason: `Operational evidence reported ${status.status} by ${connector.manifest.id}`,
    rule_version: `${connector.manifest.id}:${connector.manifest.version}`,
  })));
  return summary;
}

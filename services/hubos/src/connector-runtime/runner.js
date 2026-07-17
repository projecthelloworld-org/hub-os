import { flattenEnvelope } from "../connectors/contract.js";
import { getConnector } from "../connectors/registry.js";

export async function runConnectorJob({ store, job, workerId, observedAt = new Date() }) {
  const connector = getConnector(job.connector_id);
  if (!connector) throw new Error(`Connector ${job.connector_id} is not installed`);
  const validation = await connector.validateConfig(job.payload ?? {});
  if (!validation.valid) throw new Error(validation.errors.join("; "));

  const runId = await store.startConnectorRun(job, workerId);
  try {
    const targets = await store.listConnectorTargets(job);
    const summary = { targets: targets.length, accepted: 0, duplicates: 0, rejected: 0 };
    for (const target of targets) {
      const raw = await connector.collect({ target, observedAt });
      const normalized = await connector.normalize(raw);
      const observations = normalized.envelopes.flatMap(flattenEnvelope);
      for (const envelope of normalized.envelopes) {
        await store.recordRawPayload({
          sourceConnectionId: envelope.source_connection_id,
          connectorRunId: runId,
          externalRecordId: envelope.external_record_id,
          observedAt: envelope.observed_at,
          payload: raw,
        });
      }
      const result = await store.ingestObservations(observations);
      await store.upsertStatuses(normalized.statuses);
      summary.accepted += result.accepted;
      summary.duplicates += result.duplicates;
      summary.rejected += result.rejected;
    }
    await store.finishConnectorRun(runId, summary);
    await store.completeConnectorJob(job);
    return summary;
  } catch (error) {
    await store.failConnectorRun(runId, error);
    await store.failConnectorJob(job, error);
    throw error;
  }
}

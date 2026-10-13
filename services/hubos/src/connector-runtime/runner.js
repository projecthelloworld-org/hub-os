import { flattenEnvelope } from "../connectors/contract.js";
import { getConnector } from "../connectors/registry.js";
import { evidenceProjection } from '../privacy.js';
import { validateObservationBatch } from '../validation.js';
import { resolveCredentials } from './secrets.js';
import { CollectionError, createHttpClient } from './http-client.js';

export async function runConnectorJob({ store, job, workerId, observedAt = new Date(),
  registry = { getConnector }, demoMode = false, resolveSecrets = resolveCredentials,
  requestJson = createHttpClient(), maximumDurationMs = 240000,
}) {
  let runId = null;
  let timeout;
  let heartbeat;
  let leaseLost = false;
  let renewing = Promise.resolve();
  const controller = new AbortController();
  const renew = async () => {
    if (!(await store.renewConnectorLease(job))) {
      leaseLost = true;
      controller.abort();
    }
  };
  try {
    runId = await store.startConnectorRun(job, workerId);
    const connector = registry.getConnector(job.connector_id);
    if (!connector) throw new CollectionError('PLUGIN_NOT_INSTALLED');
    const targets = await store.listConnectorTargets(job);
    const summary = { targets: targets.length, accepted: 0, duplicates: 0, rejected: 0 };
    heartbeat = setInterval(() => {
      renewing = renewing.then(renew).catch(() => { leaseLost = true; controller.abort(); });
    }, 10000);
    const execute = async () => {
      for (const target of targets) {
        if (target.source.is_demo && !demoMode) throw new CollectionError('DEMO_SOURCE_DISABLED');
        const config = target.source.config ?? {};
        const validation = await connector.validateConfig(config);
        if (!validation?.valid) throw new CollectionError('INVALID_CONNECTOR_CONFIGURATION');
        const credentials = await resolveSecrets(config.credential_refs);
        const context = { target, source: target.source, mappings: target.mappings, config,
          observedAt, credentials, requestJson, signal: controller.signal };
        const raw = await connector.collect(context);
        const normalized = await connector.normalize(raw, context);
        await renewing;
        await renew();
        if (leaseLost || controller.signal.aborted) throw new CollectionError('WORKER_LEASE_LOST');
        if (!Array.isArray(normalized?.envelopes)) throw new CollectionError('INVALID_CONNECTOR_ENVELOPE');
        const envelopes = normalized.envelopes.map((envelope) => {
          const mapping = target.mappings.find((item) => item.external_id === envelope.external_entity?.id);
          if (!mapping || String(envelope.source_connection_id) !== String(target.source.id)) {
            throw new CollectionError('UNMAPPED_IDENTIFIER');
          }
          return { ...envelope, connector_id: connector.manifest.id,
            external_entity: { ...envelope.external_entity, hubos_id: mapping.site_id, site_code: mapping.site_code },
            records: envelope.records.map((record) => ({ ...record, attributes: {
              ...record.attributes, synthetic: Boolean(target.source.is_demo || mapping.is_demo),
              sample_interval_seconds: target.source.poll_interval_seconds,
            } })),
          };
        });
        const batches = envelopes.map((envelope) => validateObservationBatch({ observations: flattenEnvelope(envelope) }));
        // Validate every identifier before persistence; vendor raw data is never stored.
        for (const [index, envelope] of envelopes.entries()) {
          const result = await store.ingestObservations(batches[index]);
          if (result.rejected) throw new CollectionError('OBSERVATION_REJECTED');
          await store.recordRawPayload({
            sourceConnectionId: envelope.source_connection_id, connectorRunId: runId,
            externalRecordId: envelope.external_record_id, observedAt: envelope.observed_at,
            payload: evidenceProjection(batches[index]),
          });
          summary.accepted += result.accepted;
          summary.duplicates += result.duplicates;
        }
        const statuses = normalized.statuses ?? [];
        if (statuses.some((status) => !target.mappings.some((mapping) => mapping.site_id === status.site_id))) {
          throw new CollectionError('UNMAPPED_IDENTIFIER');
        }
        if (statuses.some((status) => !['connectivity', 'power', 'devices', 'usage', 'survey', 'support'].includes(status.domain)
          || !['healthy', 'degraded', 'critical', 'unknown'].includes(status.status)
          || Number.isNaN(Date.parse(status.observed_at)))) throw new CollectionError('INVALID_CONNECTOR_STATUS');
        // Never retain arbitrary vendor text as a status explanation.
        await store.upsertStatuses(statuses.map((status) => ({
          site_id: status.site_id, domain: status.domain, status: status.status, observed_at: status.observed_at,
          reason: `Operational evidence reported ${status.status} by ${connector.manifest.id}`,
          rule_version: `${connector.manifest.id}:${connector.manifest.version}`,
        })));
        await store.markSourceCollected(target.source.id, observedAt);
      }
    };
    await Promise.race([execute(), new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new CollectionError('COLLECTION_TIMEOUT')); }, maximumDurationMs);
    })]);
    clearInterval(heartbeat);
    await renewing;
    if (leaseLost) throw new CollectionError('WORKER_LEASE_LOST');
    await store.finishConnectorRun(runId, summary);
    await store.completeConnectorJob(job);
    return summary;
  } catch (error) {
    if (runId !== null) await store.failConnectorRun(runId, error);
    await store.failConnectorJob(job, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    controller.abort();
  }
}

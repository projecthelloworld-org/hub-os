import { getConnector } from "../connectors/registry.js";
import { resolveCredentials } from './secrets.js';
import { CollectionError, createHttpClient } from './http-client.js';
import { persistConnectorResult } from './results.js';

export async function runConnectorJob({ store, job, workerId, observedAt = new Date(),
  registry = { getConnector }, demoMode = false, resolveSecrets = resolveCredentials,
  requestJson = createHttpClient(), requestText = createHttpClient({ responseType: 'text' }), maximumDurationMs = 240000,
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
        const context = { target, source: target.source, mappings: target.mappings, monitors: target.monitors ?? [], config,
          observedAt, credentials, requestJson, requestText, signal: controller.signal };
        const raw = await connector.collect(context);
        const normalized = await connector.normalize(raw, context);
        await renewing;
        await renew();
        if (leaseLost || controller.signal.aborted) throw new CollectionError('WORKER_LEASE_LOST');
        const result = await persistConnectorResult({ store, target, connector, normalized, runId });
        summary.accepted += result.accepted;
        summary.duplicates += result.duplicates;
        summary.monitor_samples = (summary.monitor_samples ?? 0) + result.monitor_samples;
        summary.signals = (summary.signals ?? 0) + result.signals;
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

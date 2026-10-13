import { CollectionError, createHttpClient } from '../connector-runtime/http-client.js';
import { safeError } from '../privacy.js';

export async function testSourceConnection({ target, registry, resolveSecrets, demoMode, maximumDurationMs = 15000 }) {
  const { source } = target;
  const result = { source_connection_id: source.id, scope: 'source_access_only', checked_at: new Date().toISOString() };
  const controller = new AbortController();
  let timer;
  try {
    const connector = registry.getConnector(source.plugin_id);
    if (!connector) throw new CollectionError('PLUGIN_NOT_INSTALLED');
    if ((source.is_demo || connector.manifest.demoOnly) && !demoMode) throw new CollectionError('DEMO_SOURCE_DISABLED');
    const check = async () => {
      if (!(await connector.validateConfig(source.config)).valid) throw new CollectionError('INVALID_CONNECTOR_CONFIGURATION');
      const credentials = await resolveSecrets(source.config.credential_refs);
      const bounded = (responseType) => {
        const request = createHttpClient({ responseType });
        return (url, options = {}) => request(url, { ...options, signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      };
      const health = await connector.health({ ...target, target, config: source.config, credentials, observedAt: new Date(),
        signal: controller.signal, requestJson: bounded('json'), requestText: bounded('text') });
      if (health?.status !== 'healthy') throw new CollectionError('SOURCE_HEALTH_UNCONFIRMED');
    };
    await Promise.race([check(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new CollectionError('SOURCE_TIMEOUT')); }, maximumDurationMs);
    })]);
    return { ...result, connected: true };
  } catch (error) {
    return { ...result, connected: false, code: safeError(error) };
  } finally { clearTimeout(timer); controller.abort(); }
}

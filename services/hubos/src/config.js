import packageMetadata from '../package.json' with { type: 'json' };

const developmentPlaceholders = new Set([
  "local-demo-ingest-key",
  "local-demo-admin-key",
  "replace-for-any-shared-environment",
]);

function readBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const siteAddress = env.HUBOS_SITE_ADDRESS ?? ':80';
  if (/[\s{}]/.test(siteAddress)) throw new Error('HUBOS_SITE_ADDRESS must be :80 or an explicit HTTPS origin');
  let operatorOrigin;
  if (siteAddress !== ':80') {
    let url;
    try { url = new URL(siteAddress); } catch { throw new Error('HUBOS_SITE_ADDRESS must be :80 or an explicit HTTPS origin'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('HUBOS_SITE_ADDRESS must be :80 or an explicit HTTPS origin');
    }
    operatorOrigin = url.origin;
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(env.HUBOS_BIND_ADDRESS ?? '127.0.0.1') && !operatorOrigin) {
    throw new Error('Remote exposure requires an explicit HTTPS HUBOS_SITE_ADDRESS');
  }
  if (readBoolean(env.HUBOS_TLS_ENABLED) && !operatorOrigin) {
    throw new Error('TLS deployment requires an explicit HTTPS HUBOS_SITE_ADDRESS');
  }
  const config = {
    environment: env.HUBOS_ENV ?? "development",
    host: env.HUBOS_HOST ?? "127.0.0.1",
    port: readInteger(env.HUBOS_PORT, 3000),
    databaseUrl:
      env.HUBOS_DATABASE_URL ??
      env.DATABASE_URL ??
      "postgresql://hubos:hubos-local-only@localhost:5432/hubos",
    demoMode: readBoolean(env.HUBOS_DEMO_MODE),
    ingestKey: env.HUBOS_INGEST_KEY ?? "local-demo-ingest-key",
    adminKey: env.HUBOS_ADMIN_KEY ?? "local-demo-admin-key",
    operatorConsoleEnabled: readBoolean(env.HUBOS_OPERATOR_CONSOLE_ENABLED, true),
    operatorOrigin,
    workerPollIntervalMs: readInteger(env.HUBOS_WORKER_POLL_INTERVAL_MS, 2000),
    workerLeaseSeconds: readInteger(env.HUBOS_WORKER_LEASE_SECONDS, 300),
    version: env.HUBOS_VERSION ?? packageMetadata.version,
  };

  if (config.workerLeaseSeconds < 30 || config.workerLeaseSeconds > 3600) {
    throw new Error('HUBOS_WORKER_LEASE_SECONDS must be between 30 and 3600');
  }

  if (config.environment.toLowerCase() === "production") {
    if (config.demoMode) {
      throw new Error("HUBOS_DEMO_MODE must be disabled in production");
    }
    if (
      developmentPlaceholders.has(config.ingestKey) ||
      developmentPlaceholders.has(config.adminKey)
    ) {
      throw new Error("Production API keys must not use scaffold placeholder values");
    }
    if (config.adminKey.length < 32 || config.ingestKey.length < 32 || config.adminKey === config.ingestKey) {
      throw new Error('Production API keys must be distinct and at least 32 characters');
    }
  }

  return Object.freeze(config);
}

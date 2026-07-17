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
  const config = {
    environment: env.HUBOS_ENV ?? "development",
    host: env.HUBOS_HOST ?? "0.0.0.0",
    port: readInteger(env.HUBOS_PORT, 3000),
    databaseUrl:
      env.HUBOS_DATABASE_URL ??
      env.DATABASE_URL ??
      "postgresql://hubos:hubos-local-only@localhost:5432/hubos",
    demoMode: readBoolean(env.HUBOS_DEMO_MODE),
    ingestKey: env.HUBOS_INGEST_KEY ?? "local-demo-ingest-key",
    adminKey: env.HUBOS_ADMIN_KEY ?? "local-demo-admin-key",
    operatorConsoleEnabled: readBoolean(env.HUBOS_OPERATOR_CONSOLE_ENABLED, true),
    workerPollIntervalMs: readInteger(env.HUBOS_WORKER_POLL_INTERVAL_MS, 2000),
    workerLeaseSeconds: readInteger(env.HUBOS_WORKER_LEASE_SECONDS, 300),
    version: env.HUBOS_VERSION ?? "0.2.0",
  };

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
  }

  return Object.freeze(config);
}

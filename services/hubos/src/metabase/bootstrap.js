function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadMetabaseBootstrapConfig(env = process.env) {
  return Object.freeze({
    url: (env.METABASE_URL ?? "http://metabase:3000").replace(/\/$/, ""),
    siteName: env.METABASE_SITE_NAME ?? "HubOS Monitoring and Evaluation",
    adminFirstName: env.METABASE_ADMIN_FIRST_NAME ?? "HubOS",
    adminLastName: env.METABASE_ADMIN_LAST_NAME ?? "Administrator",
    adminEmail: env.METABASE_ADMIN_EMAIL ?? "admin@hubos.local",
    adminPassword: env.METABASE_ADMIN_PASSWORD ?? "hubos-local-admin-1",
    databaseName: env.METABASE_HUBOS_DATABASE_NAME ?? "HubOS PostgreSQL",
    databaseHost: env.METABASE_HUBOS_DB_HOST ?? "db",
    databasePort: integer(env.METABASE_HUBOS_DB_PORT, 5432),
    database: env.METABASE_HUBOS_DB_NAME ?? env.POSTGRES_DB ?? "hubos",
    databaseUser: env.METABASE_HUBOS_DB_USER ?? env.POSTGRES_USER ?? "hubos",
    databasePassword:
      env.METABASE_HUBOS_DB_PASSWORD ?? env.POSTGRES_PASSWORD ?? "hubos-local-only",
    schemaPatterns: env.METABASE_HUBOS_SCHEMAS ?? "analytics,public",
  });
}

export function buildSetupPayload(config, token) {
  return {
    token,
    user: {
      first_name: config.adminFirstName,
      last_name: config.adminLastName,
      email: config.adminEmail,
      password: config.adminPassword,
    },
    prefs: {
      site_name: config.siteName,
    },
  };
}

export function buildDatabasePayload(config) {
  return {
    name: config.databaseName,
    engine: "postgres",
    is_full_sync: true,
    is_on_demand: false,
    connection_source: "admin",
    details: {
      host: config.databaseHost,
      port: config.databasePort,
      dbname: config.database,
      user: config.databaseUser,
      password: config.databasePassword,
      ssl: false,
      "schema-filters-type": "inclusion",
      "schema-filters-patterns": config.schemaPatterns,
    },
  };
}

async function responseBody(response) {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export async function bootstrapMetabase({
  config = loadMetabaseBootstrapConfig(),
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const propertiesResponse = await fetchImpl(`${config.url}/api/session/properties`, {
    headers: { accept: "application/json" },
  });
  if (!propertiesResponse.ok) {
    throw new Error(`Metabase properties request failed with status ${propertiesResponse.status}`);
  }

  const properties = await propertiesResponse.json();
  let sessionId = null;
  let initializedNow = false;
  const setupToken = properties["setup-token"];

  if (setupToken) {
    const setupResponse = await fetchImpl(`${config.url}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildSetupPayload(config, setupToken)),
    });
    const body = await responseBody(setupResponse);
    if (setupResponse.ok) {
      sessionId = body?.id;
      initializedNow = true;
    } else if (setupResponse.status !== 403) {
      const reason = typeof body === "string" ? body : body?.message ?? body?.errors ?? "unknown error";
      throw new Error(`Metabase setup failed with status ${setupResponse.status}: ${JSON.stringify(reason)}`);
    }
  }

  if (!sessionId) {
    const sessionResponse = await fetchImpl(`${config.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: config.adminEmail, password: config.adminPassword }),
    });
    const sessionBody = await responseBody(sessionResponse);
    if (!sessionResponse.ok || !sessionBody?.id) {
      throw new Error(
        "Metabase already has an administrator. Set METABASE_ADMIN_EMAIL and " +
          "METABASE_ADMIN_PASSWORD to that account, or recreate the local Metabase application volume.",
      );
    }
    sessionId = sessionBody.id;
  }

  const authHeaders = { accept: "application/json", "x-metabase-session": sessionId };
  const databasesResponse = await fetchImpl(`${config.url}/api/database`, { headers: authHeaders });
  if (!databasesResponse.ok) {
    throw new Error(`Metabase database inventory failed with status ${databasesResponse.status}`);
  }
  const databaseBody = await databasesResponse.json();
  const databases = Array.isArray(databaseBody) ? databaseBody : databaseBody?.data ?? [];
  if (databases.some((database) => database.name === config.databaseName)) {
    logger.log(`Metabase already contains ${config.databaseName}; bootstrap made no changes`);
    return { status: initializedNow ? "configured" : "already-configured" };
  }

  const databaseResponse = await fetchImpl(`${config.url}/api/database`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(buildDatabasePayload(config)),
  });
  const databaseResult = await responseBody(databaseResponse);
  if (!databaseResponse.ok) {
    const reason =
      typeof databaseResult === "string"
        ? databaseResult
        : databaseResult?.message ?? databaseResult?.errors ?? "unknown error";
    throw new Error(
      `Metabase database connection failed with status ${databaseResponse.status}: ${JSON.stringify(reason)}`,
    );
  }

  logger.log(`Configured Metabase and connected ${config.databaseName}`);
  return { status: "configured", databaseId: databaseResult?.id };
}

if (import.meta.main) {
  await bootstrapMetabase();
}

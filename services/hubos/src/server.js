import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresStore } from "./store/postgres.js";

const config = loadConfig();
const store = new PostgresStore({ databaseUrl: config.databaseUrl });
const app = createApp({ store, config });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app,
  error(error) {
    console.error(error);
    return Response.json({ error: "Unexpected server error" }, { status: 500 });
  },
});

console.log(`HubOS ${config.version} listening on ${server.url}`);

async function shutdown() {
  await server.stop();
  await store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

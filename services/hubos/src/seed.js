import { loadConfig } from "./config.js";
import { buildDemoState } from "./demo/data.js";
import { PostgresStore } from "./store/postgres.js";

const config = loadConfig();
if (!config.demoMode) throw new Error("Demo seed requires HUBOS_DEMO_MODE=true");

const store = new PostgresStore({ databaseUrl: config.databaseUrl });
try {
  await store.seedDemo(buildDemoState());
  console.log("Seeded 10 synthetic HubOS demonstration sites");
} finally {
  await store.close();
}

import { hostname } from "node:os";

import { loadConfig } from "./config.js";
import { runConnectorJob } from "./connector-runtime/runner.js";
import { randomId } from "./ids.js";
import { PostgresStore } from "./store/postgres.js";

const config = loadConfig();
const store = new PostgresStore({ databaseUrl: config.databaseUrl });
const workerId = `${hostname()}:${randomId().slice(0, 8)}`;
let stopping = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log(`HubOS worker ${workerId} started`);
while (!stopping) {
  try {
    const job = await store.claimConnectorJob(workerId, config.workerLeaseSeconds);
    if (!job) {
      await delay(config.workerPollIntervalMs);
      continue;
    }
    const summary = await runConnectorJob({ store, job, workerId });
    console.log(`Connector job ${job.id} completed`, summary);
  } catch (error) {
    console.error("Connector job failed", error);
    await delay(config.workerPollIntervalMs);
  }
}

async function shutdown() {
  stopping = true;
  await store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

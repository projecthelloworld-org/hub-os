import { getConnector } from './connectors/registry.js';
import { loadConfig } from './config.js';
import { PostgresStore } from './store/postgres.js';
import { safeError } from './privacy.js';

const config = loadConfig();
const store = new PostgresStore({ databaseUrl: config.databaseUrl });
try {
  const plugins = process.argv.slice(2);
  if (!plugins.length) throw new Error('Provisioning requires explicitly named installed plugins');
  for (const id of plugins) {
    const plugin = getConnector(id);
    if (!plugin?.provision) throw Object.assign(new Error('Plugin has no provisioning lifecycle'), { code: 'PLUGIN_CANNOT_PROVISION' });
    await store.db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`hubos:provision:${id}`}))`;
      await plugin.provision({ store, env: process.env });
      console.log('Plugin provisioned', { plugin_id: id, status: 'completed' });
    });
  }
} catch (error) {
  console.error('Provisioning failed', safeError(error));
  process.exitCode = 1;
} finally { await store.close(); }

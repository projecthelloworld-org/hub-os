import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConnector } from './contract.js';

export function createConnectorRegistry(modules) {
  const connectors = new Map();
  for (const module of modules) {
    const connector = validateConnector(module);
    if (connectors.has(connector.manifest.id)) throw new Error('Duplicate connector plugin id');
    connectors.set(connector.manifest.id, connector);
  }
  return Object.freeze({
    getConnector: (id) => connectors.get(id) ?? null,
    listConnectorManifests: () => [...connectors.values()].map((connector) => structuredClone(connector.manifest)),
  });
}

async function importConnector(path, importer) {
  const module = await importer(pathToFileURL(path).href);
  if (!module.default) throw new Error('Connector package must export its lifecycle as default');
  return module.default;
}

export async function loadConnectorRegistry({
  builtinsDirectory = dirname(fileURLToPath(import.meta.url)),
  pluginConfigPath = process.env.HUBOS_PLUGIN_CONFIG,
  importer = (url) => import(url),
} = {}) {
  const modules = [];
  const entries = await readdir(builtinsDirectory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) modules.push(await importConnector(resolve(builtinsDirectory, entry.name, 'index.js'), importer));
  }
  if (pluginConfigPath) {
    const configPath = await realpath(pluginConfigPath);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!Array.isArray(config.plugins)) throw new Error('Local plugin configuration requires a plugins array');
    for (const item of config.plugins) {
      if (item.enabled !== true) continue;
      if (typeof item.path !== 'string' || !item.path) throw new Error('Enabled plugin requires a local package path');
      const root = await realpath(resolve(dirname(configPath), item.path));
      const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
      const entry = pkg.hubos?.connector;
      if (typeof entry !== 'string' || isAbsolute(entry)) throw new Error('Plugin package requires hubos.connector');
      const path = await realpath(resolve(root, entry));
      const inside = relative(root, path);
      if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Plugin entry must be inside its local package');
      modules.push(await importConnector(path, importer));
    }
  }
  // This imports explicitly trusted, operator-installed code. It is not a sandbox.
  return createConnectorRegistry(modules);
}

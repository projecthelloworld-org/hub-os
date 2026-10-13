import { loadConnectorRegistry } from './loader.js';

const registry = await loadConnectorRegistry();
export const getConnector = registry.getConnector;
export const listConnectorManifests = registry.listConnectorManifests;

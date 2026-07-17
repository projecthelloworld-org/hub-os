import { validateConnector } from "./contract.js";
import { mockSchoolConnector } from "./mock-school/index.js";

const connectors = new Map(
  [mockSchoolConnector].map((connector) => {
    const validConnector = validateConnector(connector);
    return [validConnector.manifest.id, validConnector];
  }),
);

export function getConnector(id) {
  return connectors.get(id) ?? null;
}

export function listConnectorManifests() {
  return [...connectors.values()].map(({ manifest }) => manifest);
}

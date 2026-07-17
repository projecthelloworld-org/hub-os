export function buildOpenApi(version = "0.1.0") {
  return {
    openapi: "3.1.0",
    info: {
      title: "HubOS API",
      version,
      description: "A small, vendor-neutral API for school connectivity operations.",
    },
    paths: {
      "/healthz": { get: { summary: "Process health", responses: { 200: { description: "Healthy" } } } },
      "/readyz": { get: { summary: "Database readiness", responses: { 200: { description: "Ready" } } } },
      "/api/v1/overview": { get: { summary: "Operator overview", responses: { 200: { description: "Current sites and incidents" } } } },
      "/api/v1/sites": { get: { summary: "List sites", responses: { 200: { description: "Sites" } } } },
      "/api/v1/sites/{siteId}/status": {
        get: {
          summary: "Get current site status",
          parameters: [{ name: "siteId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { 200: { description: "Site and status domains" }, 404: { description: "Not found" } },
        },
      },
      "/api/v1/source-connections": { get: { summary: "List source connections", responses: { 200: { description: "Sources" } } } },
      "/api/v1/connectors": { get: { summary: "List installed connectors", responses: { 200: { description: "Connector manifests" } } } },
      "/api/v1/incidents": { get: { summary: "List incidents", responses: { 200: { description: "Incidents" } } } },
      "/api/v1/incidents/{incidentId}/acknowledge": { post: { summary: "Acknowledge an incident", responses: { 200: { description: "Updated incident" } } } },
      "/api/v1/incidents/{incidentId}/resolve": { post: { summary: "Resolve an incident", responses: { 200: { description: "Updated incident" } } } },
      "/api/v1/ingest/observations:batch": { post: { summary: "Ingest normalized observations", responses: { 202: { description: "Ingestion result" } } } },
    },
  };
}

export function buildOpenApi(version = "0.1.0") {
  const siteMetadata = {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    timezone: { type: 'string', description: 'Supported time-zone identifier', default: 'UTC' },
    latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
    longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
    site_type: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$', default: 'other' },
  };
  const siteResponse = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Site' } } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "HubOS API",
      version,
      description: "A vendor-neutral API for community-site connectivity operations; schools are one supported site type.",
    },
    paths: {
      "/healthz": { get: { summary: "Process health", responses: { 200: { description: "Healthy" } } } },
      "/readyz": { get: { summary: "Database readiness", responses: { 200: { description: "Ready" } } } },
      "/api/v1/overview": { get: { summary: "Operator overview", responses: { 200: { description: "Current sites and incidents" } } } },
      '/api/v1/organisations': { get: { summary: 'List organisation identities for site registration',
        description: 'Protected by Caddy operator login. These grouping identifiers are not a partner-isolation boundary.',
        security: [{ operatorBasic: [] }], responses: { 200: { description: 'Organisation UUIDs, slugs and names' } } } },
      "/api/v1/sites": {
        get: { summary: "List sites", responses: { 200: { description: "Sites" } } },
        post: {
          summary: 'Create a community site',
          description: 'Operator login through Caddy supplies the private administrator credential. Creating a site does not create health evidence or a source mapping.',
          security: [{ operatorBasic: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SiteCreate' } } } },
          responses: { 201: { description: 'Created site', ...siteResponse }, 401: { description: 'Operator authentication required' },
            403: { description: 'Cross-origin mutation rejected' }, 409: { description: 'Duplicate organisation/site code' },
            422: { description: 'Invalid metadata, unknown organisation or synthetic site in live mode' } },
        },
      },
      '/api/v1/sites/{siteId}': { patch: {
        summary: 'Edit community site metadata without changing its identity', security: [{ operatorBasic: [] }],
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SiteUpdate' } } } },
        responses: { 200: { description: 'Updated site', ...siteResponse }, 401: { description: 'Operator authentication required' },
          403: { description: 'Cross-origin mutation rejected' }, 404: { description: 'Site not found' },
          422: { description: 'Invalid or immutable field' } },
      } },
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
      "/api/v1/source-connections/{sourceId}/webhook": {
        post: {
          summary: 'Ingest a source-scoped operational webhook through its installed plugin',
          parameters: [{ name: 'sourceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          security: [{ sourceWebhookKey: [] }],
          responses: { 202: { description: 'Validated observations, monitor samples and operational signals' },
            401: { description: 'Invalid source-specific credential' }, 422: { description: 'Unmapped or malformed evidence' } },
        },
      },
    },
    components: {
      securitySchemes: {
        operatorBasic: { type: 'http', scheme: 'basic', description: 'Operator authentication at Caddy; remote use requires HTTPS' },
        sourceWebhookKey: { type: 'apiKey', in: 'header', name: 'x-hubos-webhook-key' },
      },
      schemas: {
        SiteCreate: { type: 'object', additionalProperties: false, required: ['organisation_id', 'site_code', 'name', 'country_code'], properties: {
          organisation_id: { type: 'string', format: 'uuid' },
          site_code: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' },
          is_demo: { type: 'boolean', default: false, description: 'Synthetic records are allowed only in demonstration mode' }, ...siteMetadata,
        } },
        SiteUpdate: { type: 'object', additionalProperties: false, minProperties: 1, properties: siteMetadata },
        Site: { type: 'object', properties: {
          id: { type: 'string', format: 'uuid', readOnly: true }, organisation_id: { type: 'string', format: 'uuid' },
          site_code: { type: 'string' }, is_demo: { type: 'boolean' }, ...siteMetadata,
          created_at: { type: 'string', format: 'date-time', readOnly: true }, updated_at: { type: 'string', format: 'date-time', readOnly: true },
        } },
      },
    },
  };
}

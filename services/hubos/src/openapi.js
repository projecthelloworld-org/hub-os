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
  const sourceIdParameter = { name: 'sourceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const jsonBody = (schema) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } });
  const sourceSettings = {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    base_url: { type: ['string', 'null'], maxLength: 2048, description: 'Credential-free HTTPS URL; explicit local HTTP may be configured for a private deployment' },
    config: { type: 'object', description: 'Non-secret plugin settings, at most 16 KiB. Credentials use env:NAME or file:/absolute/path references only; configuration is never returned in source responses.' },
    poll_interval_seconds: { type: 'integer', minimum: 10, maximum: 86400, default: 60 },
    freshness_seconds: { type: 'integer', minimum: 10, maximum: 604800, default: 300 },
  };
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
      '/api/v1/source-connections': {
        get: { summary: 'List source connections without credential configuration', responses: { 200: { description: 'Sources' } } },
        post: { summary: 'Register a disabled source using an installed plugin', security: [{ operatorBasic: [] }],
          requestBody: jsonBody('SourceCreate'), responses: { 201: { description: 'Disabled source metadata; no configuration or credentials' },
            401: { description: 'Operator authentication required' }, 409: { description: 'Duplicate source name' }, 422: { description: 'Invalid plugin, settings, transport or credentials' } } },
      },
      '/api/v1/source-connections/{sourceId}': { patch: {
        summary: 'Edit settings while a source is disabled', description: 'Source identity, organisation, plugin, mode and synthetic classification remain fixed. Config replaces the complete settings object.',
        security: [{ operatorBasic: [] }], parameters: [sourceIdParameter], requestBody: jsonBody('SourceUpdate'),
        responses: { 200: { description: 'Source metadata without configuration' }, 401: { description: 'Operator authentication required' },
          404: { description: 'Source not found' }, 409: { description: 'Disable the source first, or duplicate name' }, 422: { description: 'Invalid or immutable field' } },
      } },
      '/api/v1/source-connections/{sourceId}/mappings': {
        get: { summary: 'List infrastructure site mappings for one source', security: [{ operatorBasic: [] }], parameters: [sourceIdParameter],
          responses: { 200: { description: 'Source-scoped site mappings' }, 401: { description: 'Operator authentication required' }, 404: { description: 'Source not found' } } },
        post: { summary: 'Associate an external infrastructure identifier with a community site', security: [{ operatorBasic: [] }],
          parameters: [sourceIdParameter], requestBody: jsonBody('MappingCreate'), responses: { 201: { description: 'Mapping; verification defaults to false' },
            401: { description: 'Operator authentication required' }, 409: { description: 'Duplicate external ID, active source or tool-owned mapping policy' },
            422: { description: 'Invalid identifier or site outside the source organisation' } } },
      },
      '/api/v1/source-connections/{sourceId}/mappings/{mappingId}': { patch: {
        summary: 'Correct an association or change verification while collection is paused', security: [{ operatorBasic: [] }],
        description: 'Changing the site defaults verification to false unless explicitly verified. Existing observations retain their original site association.',
        parameters: [sourceIdParameter, { name: 'mappingId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: jsonBody('MappingUpdate'), responses: { 200: { description: 'Updated mapping' }, 401: { description: 'Operator authentication required' },
          404: { description: 'Mapping not found in this source' }, 409: { description: 'Active source or tool-owned mapping' }, 422: { description: 'Invalid association or immutable field' } },
      } },
      '/api/v1/source-connections/{sourceId}/test': { post: {
        summary: 'Test read-only source access without collecting or changing health evidence', security: [{ operatorBasic: [] }],
        parameters: [sourceIdParameter], requestBody: jsonBody('EmptyAction'), responses: { 200: { description: 'Source access confirmed, not community connectivity' },
          401: { description: 'Operator authentication required' }, 404: { description: 'Source not found' }, 502: { description: 'Redacted connection failure' } },
      } },
      '/api/v1/source-connections/{sourceId}/enable': { post: {
        summary: 'Enable a configured source after connection testing', security: [{ operatorBasic: [] }], parameters: [sourceIdParameter], requestBody: jsonBody('EmptyAction'),
        description: 'Collection requires a verified site mapping; webhook-only sources do not schedule polling. Repeat activation preserves one existing job.',
        responses: { 200: { description: 'Enabled source; collection starts unknown until evidence arrives' }, 401: { description: 'Operator authentication required' },
          403: { description: 'Demonstration source in live mode' }, 409: { description: 'Settings changed during testing; retry' },
          422: { description: 'Verified mapping required' }, 502: { description: 'Source access test failed' } },
      } },
      '/api/v1/source-connections/{sourceId}/disable': { post: {
        summary: 'Pause a source and revoke its collector leases without deleting history', security: [{ operatorBasic: [] }],
        parameters: [sourceIdParameter], requestBody: jsonBody('EmptyAction'), responses: { 200: { description: 'Disabled source metadata' },
          401: { description: 'Operator authentication required' }, 404: { description: 'Source not found' } },
      } },
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
        SourceCreate: { type: 'object', additionalProperties: false, required: ['organisation_id', 'name', 'plugin_id', 'collection_mode'], properties: {
          organisation_id: { type: 'string', format: 'uuid' }, plugin_id: { type: 'string', maxLength: 80 },
          collection_mode: { type: 'string', enum: ['api_pull', 'controller_pull', 'webhook', 'file_import', 'site_agent_push', 'scheduled_pull'] },
          is_demo: { type: 'boolean', default: false }, ...sourceSettings,
        } },
        SourceUpdate: { type: 'object', additionalProperties: false, minProperties: 1, properties: sourceSettings },
        MappingCreate: { type: 'object', additionalProperties: false, required: ['site_id', 'external_id'], properties: {
          site_id: { type: 'string', format: 'uuid' }, external_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$' },
          verified: { type: 'boolean', default: false },
        } },
        MappingUpdate: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
          site_id: { type: 'string', format: 'uuid' }, verified: { type: 'boolean' },
        } },
        EmptyAction: { type: 'object', additionalProperties: false, maxProperties: 0 },
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

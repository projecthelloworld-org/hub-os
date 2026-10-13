import { createHash } from 'node:crypto';
import { apiBase, approvedEnvelopes, fail, integer } from '../../connector-runtime/local-api.js';

const pathPattern = /^[a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z][a-zA-Z0-9_]*)*$/;
const metrics = new Set(['field.report.fault.count', 'field.report.devices.usable.count',
  'field.report.connectivity.available', 'field.report.power.available']);
const valueAt = (object, path) => path.split('/').reduce((value, key) => value?.[key], object);
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;

async function session(context) {
  const { source, config, credentials, requestJson, signal } = context;
  const base = apiBase(source, config);
  if (!credentials.email || !credentials.password) fail('CREDENTIAL_UNAVAILABLE');
  let token;
  async function login() {
    const result = await requestJson(new URL('v1/sessions', base), { method: 'POST', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: credentials.email, password: credentials.password }) });
    if (typeof result?.token !== 'string' || !result.token || !Number.isFinite(timestamp(result.expiresAt))) fail();
    token = result.token;
  }
  await login();
  return { base, read: async (url) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await requestJson(url, { signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }); }
      catch (error) {
        if (attempt || error.httpStatus !== 401) throw error;
        await login();
      }
    }
  } };
}

function formPath(config) {
  return `v1/projects/${config.project_id}/forms/${encodeURIComponent(config.form_id)}`;
}

export default {
  manifest: { id: 'odk', name: 'ODK Central operational evidence', version: '1.0.0', protocolVersion: '1.0',
    collectionModes: ['api-pull'], capabilities: ['operational-field-evidence'] },
  async validateConfig(config = {}) {
    const fields = Object.entries(config.approved_fields ?? {});
    return { valid: integer(config.project_id, 1) && typeof config.form_id === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(config.form_id)
      && pathPattern.test(config.site_field ?? '') && (!config.event_time_field || pathPattern.test(config.event_time_field))
      && fields.length > 0 && fields.length <= 4 && fields.every(([path, metric]) => pathPattern.test(path) && metrics.has(metric))
      && new Set(fields.map(([, metric]) => metric)).size === fields.length
      && ['email', 'password'].every((key) => typeof config.credential_refs?.[key] === 'string')
      && integer(config.evidence_max_age_seconds, 60) && config.evidence_max_age_seconds <= 2592000, errors: [] };
  },
  async collect(context) {
    const { base, read } = await session(context), config = context.config;
    const form = await read(new URL(formPath(config), base));
    if (form?.xmlFormId !== config.form_id || !Number.isFinite(timestamp(form.publishedAt))) fail('ODK_FORM_NOT_PUBLISHED');
    const initial = new URL(`${formPath(config)}.svc/Submissions`, base);
    const selection = [...new Set(['__id', '__system/submissionDate', '__system/updatedAt', '__system/status',
      '__system/reviewState', '__system/deletedAt', config.site_field, config.event_time_field,
      ...Object.keys(config.approved_fields)].filter(Boolean))].join(',');
    initial.searchParams.set('$top', '50'); initial.searchParams.set('$select', selection);
    // Keep the crawl bounded; old reports are not re-dated when collected.
    initial.searchParams.set('$filter', `__system/submissionDate ge ${new Date(context.observedAt.getTime() - 2592000000).toISOString()}`);
    let next = initial, total;
    const links = new Set(), ids = new Set(), latest = new Map();
    for (let page = 0; next; page++) {
      if (page >= 40 || links.has(next.href)) fail('SOURCE_COLLECTION_LIMIT');
      links.add(next.href);
      const result = await read(next);
      if (!Array.isArray(result?.value) || result.value.length > 50) fail();
      if (result['@odata.count'] !== undefined) {
        if (!integer(result['@odata.count']) || (total !== undefined && total !== result['@odata.count'])) fail('SOURCE_INCOMPLETE_INVENTORY');
        total = result['@odata.count'];
      }
      for (const item of result.value) {
        if (typeof item.__id !== 'string' || !item.__id || ids.has(item.__id) || !item.__system) fail('SOURCE_INCOMPLETE_INVENTORY');
        ids.add(item.__id);
        const external_id = valueAt(item, config.site_field);
        if (typeof external_id !== 'string' || !context.mappings.some((v) => v.external_id === external_id)) fail('UNMAPPED_IDENTIFIER');
        const receipt = timestamp(item.__system.submissionDate);
        const event = config.event_time_field ? timestamp(valueAt(item, config.event_time_field)) : receipt;
        if (!Number.isFinite(receipt) || receipt > context.observedAt.getTime() + 60000) fail();
        const rank = Number.isFinite(event) ? event : receipt;
        const existing = latest.get(external_id);
        if (existing && (existing.rank > rank || (existing.rank === rank && existing.receipt >= receipt))) continue;
        const unavailable = !Number.isFinite(event) || event > context.observedAt.getTime() + 60000
          || event < context.observedAt.getTime() - config.evidence_max_age_seconds * 1000
          || ['notDecrypted', 'missingEncryptedFormData'].includes(item.__system.status)
          || item.__system.deletedAt != null || ['rejected', 'hasIssues'].includes(item.__system.reviewState)
          || (config.require_review_approval === true && item.__system.reviewState !== 'approved');
        const records = Object.entries(config.approved_fields).map(([path, metric]) => {
          const value = valueAt(item, path), max = metric.endsWith('.available') ? 1 : 1000000;
          const valid = !unavailable && Number.isFinite(value) && value >= 0 && value <= max
            && (max !== 1 || [0, 1].includes(value));
          return [metric, valid ? value : 0, max === 1 ? 'boolean' : 'count', valid ? 'valid' : 'invalid'];
        });
        latest.set(external_id, { external_id, rank, receipt,
          observed_at: new Date(Number.isFinite(event) && event <= context.observedAt.getTime() + 60000 ? event : receipt).toISOString(), records });
      }
      const link = result['@odata.nextLink'];
      if (link == null) { next = null; continue; }
      if (typeof link !== 'string' || !link) fail('ODK_UNSAFE_CONTINUATION');
      let candidate;
      try { candidate = new URL(link, initial); } catch { fail('ODK_UNSAFE_CONTINUATION'); }
      if (candidate.origin !== initial.origin || candidate.pathname !== initial.pathname || candidate.username || candidate.password || candidate.hash
        || !candidate.searchParams.get('$skiptoken') || candidate.searchParams.get('$select') !== selection
        || candidate.searchParams.get('$top') !== '50' || candidate.searchParams.get('$filter') !== initial.searchParams.get('$filter')
        || [...candidate.searchParams.keys()].some((key) => !['$top', '$select', '$filter', '$skiptoken'].includes(key))) fail('ODK_UNSAFE_CONTINUATION');
      next = candidate;
    }
    if (total !== undefined && total !== ids.size) fail('SOURCE_INCOMPLETE_INVENTORY');
    // Absence invalidates previous current values; it never creates healthy zero evidence.
    return context.mappings.map((mapping) => latest.get(mapping.external_id) ?? {
      external_id: mapping.external_id, observed_at: context.observedAt.toISOString(),
      records: Object.values(config.approved_fields).map((metric) => [metric, 0, metric.endsWith('.available') ? 'boolean' : 'count', 'invalid']),
    }).map(({ external_id, observed_at, records }) => ({ external_id, observed_at, records,
      evidence_key: createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16) }));
  },
  async normalize(rows, { source }) {
    const result = approvedEnvelopes(rows, 'odk', source);
    result.envelopes.forEach((envelope, index) => { envelope.external_record_id += `:${rows[index].evidence_key}`; });
    return result;
  },
  async health(context) {
    const { base, read } = await session(context);
    const form = await read(new URL(formPath(context.config), base));
    if (form?.xmlFormId !== context.config.form_id || !Number.isFinite(timestamp(form.publishedAt))) fail('ODK_FORM_NOT_PUBLISHED');
    return { status: 'healthy' };
  },
};

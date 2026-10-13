import { CollectionError } from '../../connector-runtime/http-client.js';

export default {
  manifest: { id: 'metabase-alerts', name: 'Metabase operational data alerts', version: '1.0.0', protocolVersion: '1.0',
    collectionModes: ['webhook'], capabilities: ['operational-alerts'] },
  async validateConfig(config) { return { valid: typeof config.question_rules === 'object', errors: ['Approved question mapping required'] }; },
  async collect() { return []; },
  async normalize() { return { envelopes: [], signals: [] }; },
  async health() { return { status: 'unknown', reason: 'Webhook evaluator; last successful delivery is monitored separately' }; },
  async provision(context) {
    const { provisionMetabaseMonitoring } = await import('../../metabase/provision.js');
    return provisionMetabaseMonitoring(context);
  },
  async webhook(body, { config }) {
    if (body?.alert_id === null || (body && typeof body === 'object' && Object.keys(body).length === 0)) {
      return { envelopes: [], signals: [] }; // Native channel test, not evidence.
    }
    const rule = config.question_rules?.[String(body?.data?.question_id)];
    const raw = body?.data?.raw_data;
    if (!rule || body.type !== 'alert' || !Array.isArray(raw?.cols) || !Array.isArray(raw.rows) || raw.rows.length > 1000) {
      throw Object.assign(new CollectionError('METABASE_UNAPPROVED_ALERT'), { status: 422 });
    }
    const columns = raw.cols.map((col) => typeof col === 'string' ? col.toLowerCase() : col?.name?.toLowerCase());
    const siteIndex = columns.indexOf('site_id');
    const timeIndex = columns.indexOf('observed_at');
    if (siteIndex < 0 || timeIndex < 0 || new Set(columns).size !== columns.length) {
      throw Object.assign(new CollectionError('METABASE_INVALID_ALERT_COLUMNS'), { status: 422 });
    }
    // Creator names, visualization PNG, URLs, free text and unapproved columns are discarded.
    return { envelopes: [], signals: raw.rows.map((row) => ({ rule_id: rule.rule_id,
      subject_type: 'site', subject_id: row[siteIndex], observed_at: row[timeIndex], state: rule.state })) };
  },
};

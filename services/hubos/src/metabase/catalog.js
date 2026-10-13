import { stableId } from '../ids.js';

const question = (key, name, view, select, tail = '', options = {}) => ({
  key, name, view, select, tail, display: 'table',
  dateField: ['community_operations', 'metric_current', 'device_evidence', 'field_evidence', 'collection_status', 'monitor_current'].includes(view) ? 'as_of' : 'observed_at', ...options,
});

export const questions = [
  question('operations-sites', 'Community site evidence', 'community_operations',
    'site_code, site_name, country_code, site_type, connectivity, power, devices, active_incidents, observed_at, synthetic',
    'ORDER BY active_incidents DESC, country_code, site_code',
    { description: 'Current status from evidence no older than five minutes. Missing/stale evidence is unknown. Synthetic sites are fictional.' }),
  question('operations-comparison', 'Connectivity evidence by country', 'community_operations',
    'country_code, connectivity, count(*) AS sites', 'GROUP BY country_code, connectivity ORDER BY country_code, connectivity',
    { display: 'bar', dimensions: ['country_code', 'connectivity'], metrics: ['sites'],
      description: 'Counts of sites by current connectivity evidence; unknown is not healthy. This is not an impact or beneficiary measure.' }),
  question('operations-incidents', 'Open support queue — opened in selected period', 'incident_history',
    'site_code, status, severity, title, owner, started_at, scope, synthetic, id AS incident_id',
    'AND status IN (\'open\', \'acknowledged\') ORDER BY started_at DESC',
    { dateField: 'started_at', description: 'Existing support issues, scoped by their opening date. Infrastructure checks have no community site.' }),
  question('availability-community', 'Community targets — observed uptime and coverage', 'monitor_daily',
    'site_code, monitor_name, scope, synthetic, 100.0 * sum(up_seconds) / nullif(sum(observed_seconds), 0) AS observed_uptime_percent, 100.0 * sum(observed_seconds) / nullif(sum(eligible_seconds), 0) AS coverage_percent, sum(observed_seconds) AS observed_seconds, sum(eligible_seconds) AS eligible_seconds',
    'AND scope <> \'infrastructure\' GROUP BY site_code, monitor_name, scope, synthetic ORDER BY site_code, monitor_name',
    { dateField: 'day', description: 'Observed uptime = up seconds / known seconds; coverage = known / eligible seconds. Central target reachability does not prove community internet availability.' }),
  question('availability-trend', 'Observed uptime and coverage — UTC days', 'monitor_daily',
    'day, 100.0 * sum(up_seconds) / nullif(sum(observed_seconds), 0) AS observed_uptime_percent, 100.0 * sum(observed_seconds) / nullif(sum(eligible_seconds), 0) AS coverage_percent',
    'AND scope <> \'infrastructure\' GROUP BY day ORDER BY day',
    { dateField: 'day', display: 'line', dimensions: ['day'], metrics: ['observed_uptime_percent', 'coverage_percent'],
      description: 'Weighted ratios, never averages of site percentages. Gaps do not become healthy time; both ratios use the selected period.' }),
  question('availability-infrastructure', 'Monitoring infrastructure — current reachability', 'monitor_current',
    'monitor_name, status, response_ms, observed_at, scope', 'AND scope = \'infrastructure\' ORDER BY monitor_name',
    { siteFilters: false, description: 'Only HubOS service health, not community connectivity. Site/country filters intentionally do not apply to infrastructure.' }),
  question('availability-response', 'Community target response time — UTC days', 'monitor_daily',
    'day, monitor_name, response_ms, synthetic', 'AND scope <> \'infrastructure\' ORDER BY day, monitor_name',
    { dateField: 'day', display: 'line', dimensions: ['day', 'monitor_name'], metrics: ['response_ms'],
      description: 'Time-weighted response time in milliseconds during observed up intervals; down/unknown measurements are unavailable, not zero.' }),
  question('network-aggregates', 'Network controller aggregates', 'metric_current',
    'site_code, source_name, metric, value, unit, quality, observed_at, synthetic',
    'AND metric LIKE \'network.%\' ORDER BY site_code, source_name, metric',
    { description: 'Only aggregates actually reported through the supported local Network API. Device uptime or online APs are not WAN availability.' }),
  question('devices-current', 'Managed-device inventory and check-ins', 'device_evidence',
    'site_code, source_name, inventory_count, recent_check_ins, stale_check_ins, unknown_check_ins, observed_at, synthetic',
    'ORDER BY site_code, source_name',
    { description: 'Controller-scoped device counts; inventories may overlap between controllers and must not be added as unique devices. Check-in is not human use.' }),
  question('devices-trend', 'Recent device check-ins — evidence over time', 'telemetry',
    'observed_at, site_code || \' / \' || source_name AS series, value AS recent_check_ins, synthetic',
    'AND metric = \'devices.check_in.recent.count\' AND quality = \'valid\' ORDER BY observed_at, site_code, source_name LIMIT 2000',
    { display: 'line', dimensions: ['observed_at', 'series'], metrics: ['recent_check_ins'],
      description: 'Reported recent check-ins, not learner activity. Historical evidence retains its observation time; no invented gap filling.' }),
  question('field-current', 'Operational inspections — latest approved evidence', 'field_evidence',
    'site_code, source_name, fault_count, usable_devices, reported_connectivity, reported_power, observed_at, synthetic',
    'ORDER BY site_code, source_name',
    { description: 'Approved numeric ODK operational fields only. These are field reports, not automatic probes or learning outcomes. Stale/missing values are unavailable.' }),
  question('collection-status', 'Collection freshness and source coverage', 'collection_status',
    'site_code, freshness, source_name, plugin_id, enabled, last_success_at, freshness_seconds, synthetic',
    'ORDER BY freshness, site_code, source_name',
    { description: 'Current collector freshness, not network health. Disabled, stale and never-collected sources remain visible; multiple mappings do not multiply source/site rows.' }),
  question('support-history', 'Incident history', 'incident_history',
    'site_code, status, severity, title, owner, started_at, resolved_at, signal_count, scope, synthetic, id AS incident_id',
    'ORDER BY started_at DESC LIMIT 1000',
    { dateField: 'started_at', description: 'Incident opening/recovery history and ownership. Repeated signals update an incident rather than create repeated openings.' }),
  question('support-delivery', 'Notification delivery queue', 'notification_delivery',
    'site_code, event_kind, status, attempts, title, created_at, delivered_at, scope, synthetic, incident_id',
    'ORDER BY created_at DESC LIMIT 1000',
    { dateField: 'created_at', description: 'Actual outbox delivery/retry states; disabled notification delivery is not reported as successful.' }),
  question('plugin-telemetry', 'Additional plugin telemetry', 'telemetry',
    'site_code, metric, value, unit, quality, source_name, plugin_id, observed_at, synthetic',
    'ORDER BY observed_at DESC, site_code, metric LIMIT 1000',
    { description: 'Generic canonical measurements from all enabled plugin types. Quality and synthetic classification remain visible; no vendor-specific reporting schema is required.' }),
];

export const dashboards = [
  { key: 'community-operations', name: 'Community Operations', cards: [
    ['operations-sites', 0, 0, 24, 7], ['operations-comparison', 7, 0, 10, 6], ['operations-incidents', 7, 10, 14, 6],
  ] },
  { key: 'availability-connectivity', name: 'Availability & Connectivity', cards: [
    ['availability-trend', 0, 0, 14, 6], ['availability-infrastructure', 0, 14, 10, 6],
    ['availability-community', 6, 0, 24, 7], ['availability-response', 13, 0, 14, 6], ['network-aggregates', 13, 14, 10, 6],
  ] },
  { key: 'devices-field', name: 'Devices & Field Evidence', cards: [
    ['devices-current', 0, 0, 24, 6], ['devices-trend', 6, 0, 24, 6], ['field-current', 12, 0, 24, 6],
  ] },
  { key: 'collection-support', name: 'Collection & Support', cards: [
    ['collection-status', 0, 0, 24, 6], ['support-history', 6, 0, 14, 7], ['support-delivery', 6, 14, 10, 7], ['plugin-telemetry', 13, 0, 24, 7],
  ] },
];

export function dashboardParameters() {
  return [
    { id: 'hubos-site', name: 'Community site', slug: 'site', type: 'string/=' },
    { id: 'hubos-country', name: 'Country', slug: 'country', type: 'string/=' },
    // Metabase excludes today without the trailing '~' (include current period).
    { id: 'hubos-date', name: 'Reporting date (UTC)', slug: 'date', type: 'date/all-options', default: 'past30days~' },
  ];
}

export function buildQuestion(definition, { databaseId, collectionId, fieldId }) {
  const titles = {
    site_code: 'Site', site_name: 'Community site', country_code: 'Country', site_type: 'Site type',
    active_incidents: 'Open incidents', observed_at: 'Observed (UTC)', synthetic: 'Demonstration',
    connectivity: 'Connectivity', power: 'Power', devices: 'Devices', source_name: 'Source', plugin_id: 'Plugin',
    monitor_name: 'Target', scope: 'Scope', status: 'Status', response_ms: 'Response (ms)',
    observed_uptime_percent: 'Observed uptime (%)', coverage_percent: 'Observation coverage (%)',
    observed_seconds: 'Known seconds', eligible_seconds: 'Eligible seconds', day: 'UTC day',
    inventory_count: 'Inventory', recent_check_ins: 'Recent check-ins', stale_check_ins: 'Stale check-ins', unknown_check_ins: 'Unknown check-ins',
    fault_count: 'Reported faults', usable_devices: 'Usable devices', reported_connectivity: 'Reported connectivity', reported_power: 'Reported power',
    enabled: 'Enabled', freshness: 'Freshness', last_success_at: 'Last collection (UTC)', freshness_seconds: 'Freshness limit (s)',
    title: 'Issue', severity: 'Severity', owner: 'Owner', started_at: 'Opened (UTC)', resolved_at: 'Recovered (UTC)', signal_count: 'Signals',
    incident_id: 'Incident identifier', event_kind: 'Event', attempts: 'Retries', created_at: 'Queued (UTC)', delivered_at: 'Delivered (UTC)',
    metric: 'Measurement', value: 'Value', unit: 'Unit', quality: 'Quality', series: 'Site / source', sites: 'Sites',
  };
  const columnSettings = Object.fromEntries(Object.entries(titles).map(([name, title]) => [JSON.stringify(['name', name]), { column_title: title }]));
  const tags = {};
  const fields = definition.siteFilters === false ? [['date', definition.dateField, 'date/all-options']]
    : [['site', 'site_code', 'string/='], ['country', 'country_code', 'string/='], ['date', definition.dateField, 'date/all-options']];
  for (const [name, column, widget] of fields) {
    tags[name] = { id: stableId('metabase-tag', `${definition.key}:${name}`), name, 'display-name': name,
      type: 'dimension', dimension: ['field', fieldId(definition.view, column), null], 'widget-type': widget };
  }
  const filters = fields.map(([name, column]) => name === 'date'
    ? `[[AND ({{date}} OR ${column} IS NULL)]]` : `[[AND {{${name}}}]]`).join('\n');
  return { name: definition.name, description: definition.description, collection_id: collectionId, display: definition.display,
    dataset_query: { database: databaseId, type: 'native', native: { query:
      `SELECT ${definition.select}\nFROM analytics.${definition.view}\nWHERE 1=1\n${filters}\n${definition.tail}`, 'template-tags': tags } },
    visualization_settings: definition.display === 'table' ? { column_settings: columnSettings } : {
      column_settings: columnSettings,
      'graph.dimensions': definition.dimensions, 'graph.metrics': definition.metrics,
      'graph.colors': ['#e76031', '#247a89', '#636464', '#8f4f9f'], 'graph.show_values': false,
      'graph.y_axis.auto_range': !definition.metrics?.includes('observed_uptime_percent'),
      'graph.y_axis.auto_split': false,
      ...(definition.metrics?.includes('observed_uptime_percent') ? { 'graph.y_axis.min': 0, 'graph.y_axis.max': 100 } : {}),
      'graph.missing': 'none',
    },
  };
}

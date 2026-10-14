const state = { data: null, country: 'ALL', request: 0, busyIncidents: new Set(), drafts: new Map(), expandedIncidents: new Set() };
const elements = Object.fromEntries([
  'updated-at', 'refresh-button', 'retry-button', 'error-banner', 'error-message', 'site-count',
  'country-breakdown', 'healthy-count', 'degraded-count', 'critical-count', 'unknown-count', 'visible-count',
  'site-list', 'incident-count', 'incident-list', 'source-list', 'country-filters', 'installation-mode',
  'installation-description', 'installation-note', 'action-feedback', 'attention-title',
].map((id) => [id, document.getElementById(id)]));
const domains = ['connectivity', 'power', 'devices'];
const statuses = new Set(['healthy', 'degraded', 'critical', 'unknown']);
const numbers = new Intl.NumberFormat();
let regions;
try { regions = new Intl.DisplayNames(undefined, { type: 'region' }); } catch { /* Country codes remain usable. */ }
const countryName = (code) => { try { return regions?.of(code) ?? code; } catch { return code; } };
const dateLabel = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
const classification = (value) => ({ school: 'School', community_centre: 'Community centre', library: 'Library', other: 'Other site' })[value]
  ?? (typeof value === 'string' ? value.replaceAll('_', ' ') : 'Other site');

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', signal: controller.signal,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
    if (!response.ok) throw Object.assign(new Error('API request failed'), { status: response.status });
    return await response.json();
  } finally { clearTimeout(timer); }
}

function errorLabel(error, action = false) {
  if (error.status === 401) return 'Your operator login is required. Sign in again, then retry.';
  if (error.status === 403) return 'This request was not permitted. Use the configured operator address and check your access.';
  if (error.status === 409) return 'This incident has changed. Refresh and review it before trying again.';
  if (error.status === 429) return 'Too many requests. Wait briefly, then retry.';
  if (action && [400, 422].includes(error.status)) return 'Check the required field and its length, then retry. Your entry has been kept.';
  return action ? 'The result could not be confirmed. Refresh to check the incident before submitting again.'
    : 'Current evidence could not be loaded. Check the connection and service, then try again.';
}

function domainStatus(site, domain) {
  const entry = (site.statuses ?? []).find((item) => item.domain === domain);
  return { status: statuses.has(entry?.status) ? entry.status : 'unknown',
    reason: entry?.reason || 'No current verified evidence for this domain.' };
}

function overallStatus(site) {
  const values = domains.map((domain) => domainStatus(site, domain).status);
  if (values.includes('critical')) return 'critical';
  if (values.includes('degraded')) return 'degraded';
  return values.every((value) => value === 'healthy') ? 'healthy' : 'unknown';
}

const currentSites = () => state.data.sites.filter((site) => state.country === 'ALL' || site.country_code === state.country);

function statusCell(site, domain) {
  const evidence = domainStatus(site, domain);
  const wrapper = node('div', 'domain-status');
  wrapper.append(node('span', 'domain-label', domain));
  const detail = node('details', 'domain-evidence');
  const summary = node('summary', 'domain-value', evidence.status);
  summary.setAttribute('aria-label', `${domain} evidence: ${evidence.status}`);
  const dot = node('i', `status-dot ${evidence.status}`);
  dot.setAttribute('aria-hidden', 'true');
  summary.prepend(dot);
  detail.append(summary, node('p', 'evidence-reason', evidence.reason));
  wrapper.append(detail);
  return wrapper;
}

function renderSites() {
  const sites = currentSites();
  elements['site-list'].replaceChildren();
  elements['site-list'].setAttribute('aria-busy', 'false');
  elements['visible-count'].textContent = `${numbers.format(sites.length)} ${sites.length === 1 ? 'site' : 'sites'}`;
  if (!sites.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('strong', null, state.data.sites.length ? 'No sites match this view' : 'No community sites configured'));
    empty.append(node('span', null, state.data.sites.length ? 'Choose another country to return to the register.'
      : 'Register a site, connect a source and verify its mappings. A new site remains unknown until evidence is collected.'));
    const guide = node('a', null, 'Site and connector setup guide');
    guide.href = 'https://github.com/projecthelloworld-org/hub-os/blob/main/docs/Live_Connectors.md';
    guide.rel = 'noreferrer';
    empty.append(guide);
    elements['site-list'].append(empty);
    return;
  }
  for (const site of sites) {
    const row = node('article', 'site-row');
    const identity = node('div', 'site-identity');
    identity.append(node('strong', null, site.name));
    identity.append(node('span', null, `${site.site_code} · ${countryName(site.country_code)} · ${classification(site.site_type)}${site.is_demo ? ' · Synthetic' : ''}`));
    row.append(identity, ...domains.map((domain) => statusCell(site, domain)));
    elements['site-list'].append(row);
  }
}

function renderSummary() {
  const sites = currentSites(), counts = { healthy: 0, degraded: 0, critical: 0, unknown: 0 };
  sites.forEach((site) => { counts[overallStatus(site)] += 1; });
  elements['site-count'].textContent = numbers.format(sites.length);
  for (const name of Object.keys(counts)) elements[`${name}-count`].textContent = numbers.format(counts[name]);
  const countries = [...new Set(sites.map((site) => site.country_code))].sort();
  elements['country-breakdown'].textContent = countries.length <= 3
    ? countries.map((code) => `${numbers.format(sites.filter((site) => site.country_code === code).length)} ${countryName(code)}`).join(' · ') || 'No sites configured'
    : `${numbers.format(countries.length)} countries`;
}

function incidentForm(incident, action, label, field, maximum) {
  const form = node('form', 'incident-form');
  const fieldId = `incident-${incident.id}-${field}`;
  const title = node('label', null, action === 'acknowledge' ? 'Responsible team' : 'Resolution and evidence');
  title.htmlFor = fieldId;
  const input = node(action === 'acknowledge' ? 'input' : 'textarea');
  input.id = fieldId; input.name = field; input.required = true; input.maxLength = maximum;
  input.value = state.drafts.get(fieldId) ?? (field === 'owner' ? incident.owner ?? '' : '');
  const hint = node('p', 'form-hint', action === 'acknowledge' ? 'Use a team or operator name; do not include participant details.'
    : 'Manual resolution is an operator decision, not proof of measured recovery.');
  hint.id = `${fieldId}-hint`; input.setAttribute('aria-describedby', hint.id);
  const feedback = node('p', 'form-feedback'); feedback.setAttribute('role', 'alert');
  const submit = node('button', 'button button-action', label); submit.type = 'submit';
  submit.disabled = state.busyIncidents.has(incident.id);
  input.addEventListener('input', () => state.drafts.set(fieldId, input.value));
  form.append(title, input, hint, submit, feedback);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busyIncidents.has(incident.id) || !form.reportValidity()) return;
    const value = input.value.trim();
    if (!value) { feedback.textContent = 'Enter a value before saving.'; input.focus(); return; }
    state.busyIncidents.add(incident.id);
    for (const button of form.closest('.incident').querySelectorAll('button')) button.disabled = true;
    feedback.textContent = 'Saving…';
    try {
      await api(`/api/v1/incidents/${encodeURIComponent(incident.id)}/${action}`, { method: 'POST', body: JSON.stringify({ [field]: value }) });
      state.drafts.delete(fieldId);
      elements['action-feedback'].textContent = action === 'acknowledge' ? 'Incident owner saved.' : 'Incident manually resolved.';
      await loadData();
      if (action === 'resolve') elements['attention-title'].focus();
      else [...elements['incident-list'].querySelectorAll('.incident')].find((card) => card.dataset.incidentId === incident.id)?.querySelector('summary')?.focus();
    } catch (error) { feedback.textContent = errorLabel(error, true); }
    finally {
      state.busyIncidents.delete(incident.id);
      for (const card of elements['incident-list'].querySelectorAll('.incident')) {
        for (const button of card.querySelectorAll('button')) button.disabled = state.busyIncidents.has(card.dataset.incidentId);
      }
    }
  });
  return form;
}

function renderIncidents() {
  const incidents = state.data.incidents.filter((incident) => state.country === 'ALL' || !incident.country_code || incident.country_code === state.country);
  elements['incident-count'].textContent = numbers.format(incidents.length);
  elements['incident-list'].replaceChildren();
  if (!incidents.length) { elements['incident-list'].append(node('p', 'empty-copy', 'No open incidents in this view.')); return; }
  for (const incident of incidents) {
    const card = node('article', 'incident');
    card.dataset.incidentId = incident.id;
    const top = node('div', 'incident-topline');
    top.append(node('span', incident.severity === 'high' ? 'severity-high' : '', `${incident.severity} priority`), node('span', null, incident.status));
    card.append(top, node('h3', null, incident.title));
    const location = incident.site_name ? `${incident.site_name} · ${countryName(incident.country_code)}`
      : incident.details?.scope === 'infrastructure' ? 'HubOS infrastructure · installation-wide' : 'Site association unavailable';
    card.append(node('p', null, location));
    if (incident.owner) card.append(node('p', null, `Owner: ${incident.owner}`));
    card.append(node('p', null, `Opened ${dateLabel(incident.started_at)}`));
    if (['open', 'acknowledged'].includes(incident.status)) {
      const actions = node('details', 'incident-actions');
      actions.open = state.expandedIncidents.has(incident.id);
      actions.addEventListener('toggle', () => {
        if (actions.open) state.expandedIncidents.add(incident.id); else state.expandedIncidents.delete(incident.id);
      });
      actions.append(node('summary', null, 'Respond to incident'));
      actions.append(incidentForm(incident, 'acknowledge', incident.owner ? 'Update owner' : 'Acknowledge', 'owner', 160));
      actions.append(incidentForm(incident, 'resolve', 'Resolve manually', 'resolution', 500));
      card.append(actions);
    }
    elements['incident-list'].append(card);
  }
}

function renderSources(sources) {
  elements['source-list'].replaceChildren();
  if (!sources.length) { elements['source-list'].append(node('p', 'empty-copy', 'No source connections configured.')); return; }
  for (const source of sources) {
    const card = node('article', 'source-card');
    const type = source.plugin_id ?? source.connector_type ?? 'connector';
    card.append(node('p', null, type === 'mock-school-telemetry' ? 'Community demonstration' : type.replaceAll('_', ' ')));
    card.append(node('h3', null, source.name));
    const label = node('span', null, `Collection: ${source.status}`);
    const dot = node('i', `status-dot ${source.status === 'healthy' ? 'healthy' : 'unknown'}`); dot.setAttribute('aria-hidden', 'true');
    label.prepend(dot); card.append(label, node('p', 'source-freshness', source.last_success_at ? `Last collected ${dateLabel(source.last_success_at)}` : 'No successful collection recorded'));
    elements['source-list'].append(card);
  }
}

function render() { renderSummary(); renderSites(); renderIncidents(); }

function renderEnvironment() {
  const demo = state.data.installation?.mode === 'demo';
  elements['installation-mode'].textContent = demo ? 'Synthetic demonstration' : 'Live installation';
  elements['installation-description'].textContent = demo
    ? 'Ten fictional community sites in Uganda and Angola: schools, community centres and libraries. All demonstration evidence is synthetic.'
    : 'Current evidence and support needs across the community sites configured for this installation. Schools are one supported kind of site.';
  elements['installation-note'].textContent = demo ? 'Fictional sites and evidence · not a field trial.' : 'Unknown evidence does not establish healthy service.';
}

function renderFilters() {
  const countries = [...new Set(state.data.sites.map((site) => site.country_code))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  if (state.country !== 'ALL' && !countries.includes(state.country)) state.country = 'ALL';
  elements['country-filters'].replaceChildren();
  for (const code of ['ALL', ...countries]) {
    const button = node('button', `filter${state.country === code ? ' is-active' : ''}`, code === 'ALL' ? 'All' : countryName(code));
    button.type = 'button'; button.dataset.country = code; button.setAttribute('aria-pressed', String(state.country === code));
    elements['country-filters'].append(button);
  }
}

async function loadData() {
  const sequence = ++state.request;
  elements['refresh-button'].disabled = true; elements['retry-button'].disabled = true;
  elements['error-banner'].hidden = true;
  const [overview, sources] = await Promise.allSettled([api('/api/v1/overview'), api('/api/v1/source-connections')]);
  if (sequence !== state.request) return;
  if (overview.status === 'fulfilled' && Array.isArray(overview.value.sites) && Array.isArray(overview.value.incidents)) {
    state.data = overview.value;
    renderEnvironment(); renderFilters(); render();
    elements['updated-at'].textContent = `Loaded ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    state.data = null;
    for (const id of ['site-count', 'healthy-count', 'degraded-count', 'critical-count', 'unknown-count', 'incident-count']) elements[id].textContent = '—';
    elements['site-list'].replaceChildren(node('p', 'empty-copy', 'No current overview available. Retry when the service is reachable.'));
    elements['incident-list'].replaceChildren(node('p', 'empty-copy', 'The support queue could not be loaded.'));
    elements['site-list'].setAttribute('aria-busy', 'false'); elements['visible-count'].textContent = 'Overview unavailable';
    elements['updated-at'].textContent = 'Current overview unavailable'; elements['country-breakdown'].textContent = 'Evidence not loaded';
    elements['error-message'].textContent = errorLabel(overview.reason ?? {}); elements['error-banner'].hidden = false;
  }
  if (sources.status === 'fulfilled' && Array.isArray(sources.value.source_connections)) renderSources(sources.value.source_connections);
  else elements['source-list'].replaceChildren(node('p', 'empty-copy', 'Source inventory could not be loaded. Use Refresh to retry.'));
  elements['refresh-button'].disabled = false; elements['retry-button'].disabled = false;
}

elements['country-filters'].addEventListener('click', (event) => {
  const button = event.target.closest('button[data-country]');
  if (!button || !state.data) return;
  state.country = button.dataset.country; renderFilters(); render();
  [...elements['country-filters'].querySelectorAll('button')].find((item) => item.dataset.country === state.country)?.focus();
});
elements['refresh-button'].addEventListener('click', loadData);
elements['retry-button'].addEventListener('click', loadData);
loadData();

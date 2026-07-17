const state = { data: null, country: "ALL" };

const elements = {
  updatedAt: document.querySelector("#updated-at"),
  refresh: document.querySelector("#refresh-button"),
  retry: document.querySelector("#retry-button"),
  errorBanner: document.querySelector("#error-banner"),
  errorMessage: document.querySelector("#error-message"),
  siteCount: document.querySelector("#site-count"),
  countryBreakdown: document.querySelector("#country-breakdown"),
  healthyCount: document.querySelector("#healthy-count"),
  degradedCount: document.querySelector("#degraded-count"),
  criticalCount: document.querySelector("#critical-count"),
  visibleCount: document.querySelector("#visible-count"),
  siteList: document.querySelector("#site-list"),
  incidentCount: document.querySelector("#incident-count"),
  incidentList: document.querySelector("#incident-list"),
  sourceList: document.querySelector("#source-list"),
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function overallStatus(site) {
  const statuses = site.statuses.map((item) => item.status);
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.length >= 3 && statuses.every((status) => status === "healthy")) return "healthy";
  return "unknown";
}

function currentSites() {
  return state.data.sites.filter((site) => state.country === "ALL" || site.country_code === state.country);
}

function statusCell(site, domain) {
  const status = site.statuses.find((item) => item.domain === domain);
  const wrapper = node("div", "domain-status");
  wrapper.append(node("span", "domain-label", domain));
  const value = node("span", "domain-value", status?.status ?? "unknown");
  const dot = node("i", `status-dot ${status?.status ?? "unknown"}`);
  dot.setAttribute("aria-hidden", "true");
  value.prepend(dot);
  if (status?.reason) value.title = status.reason;
  wrapper.append(value);
  return wrapper;
}

function renderSites() {
  const sites = currentSites();
  elements.siteList.replaceChildren();
  elements.siteList.setAttribute("aria-busy", "false");
  elements.visibleCount.textContent = `${sites.length} ${sites.length === 1 ? "school" : "schools"}`;

  if (sites.length === 0) {
    const empty = node("div", "empty-state");
    empty.append(node("strong", null, "No schools match this view"));
    empty.append(node("span", null, "Choose another country to return to the site register."));
    elements.siteList.append(empty);
    return;
  }

  for (const site of sites) {
    const row = node("article", "site-row");
    const identity = node("div", "site-identity");
    identity.append(node("strong", null, site.name));
    identity.append(node("span", null, `${site.site_code} · ${site.country_code}`));
    row.append(identity);
    row.append(statusCell(site, "connectivity"));
    row.append(statusCell(site, "power"));
    row.append(statusCell(site, "devices"));
    row.append(node("span", "row-chevron", "›"));
    elements.siteList.append(row);
  }
}

function renderSummary() {
  const sites = currentSites();
  const counts = { healthy: 0, degraded: 0, critical: 0, unknown: 0 };
  sites.forEach((site) => { counts[overallStatus(site)] += 1; });
  elements.siteCount.textContent = sites.length;
  elements.healthyCount.textContent = counts.healthy;
  elements.degradedCount.textContent = counts.degraded;
  elements.criticalCount.textContent = counts.critical;
  const ug = sites.filter((site) => site.country_code === "UG").length;
  const ao = sites.filter((site) => site.country_code === "AO").length;
  elements.countryBreakdown.textContent = state.country === "ALL" ? `${ug} Uganda · ${ao} Angola` : state.country === "UG" ? `${ug} Uganda` : `${ao} Angola`;
}

function renderIncidents() {
  const incidents = state.data.incidents.filter((incident) => state.country === "ALL" || incident.country_code === state.country);
  elements.incidentCount.textContent = incidents.length;
  elements.incidentList.replaceChildren();
  if (incidents.length === 0) {
    elements.incidentList.append(node("p", "empty-copy", "No open incidents in this view."));
    return;
  }
  for (const incident of incidents) {
    const card = node("article", "incident");
    const top = node("div", "incident-topline");
    top.append(node("span", `severity-${incident.severity}`, `${incident.severity} priority`));
    top.append(node("span", null, incident.status));
    card.append(top);
    card.append(node("h3", null, incident.title));
    card.append(node("p", null, `${incident.site_name} · ${incident.country_code}`));
    if (incident.owner) card.append(node("p", null, `Owner: ${incident.owner}`));
    card.append(node("p", null, `Opened ${new Date(incident.started_at).toLocaleString()}`));
    elements.incidentList.append(card);
  }
}

async function renderSources() {
  elements.sourceList.replaceChildren();
  try {
    const response = await fetch("/api/v1/source-connections", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Source inventory unavailable");
    const { source_connections: sources } = await response.json();
    for (const source of sources) {
      const card = node("article", "source-card");
      card.append(node("p", null, source.connector_type.replaceAll("_", " ")));
      card.append(node("h3", null, source.name));
      const status = node("span", null, source.status);
      status.prepend(node("i", `status-dot ${source.status === "healthy" ? "healthy" : "unknown"}`));
      card.append(status);
      elements.sourceList.append(card);
    }
  } catch {
    elements.sourceList.append(node("p", "empty-copy", "Source inventory could not be loaded."));
  }
}

function render() {
  renderSummary();
  renderSites();
  renderIncidents();
}

async function loadData() {
  elements.refresh.disabled = true;
  elements.errorBanner.hidden = true;
  try {
    const response = await fetch("/api/v1/overview", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The service responded with status ${response.status}.`);
    state.data = await response.json();
    render();
    await renderSources();
    elements.updatedAt.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    elements.errorMessage.textContent = error.message || "The current data could not be loaded.";
    elements.errorBanner.hidden = false;
    elements.siteList.setAttribute("aria-busy", "false");
  } finally {
    elements.refresh.disabled = false;
  }
}

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.country = button.dataset.country;
    document.querySelectorAll(".filter").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    if (state.data) render();
  });
});

elements.refresh.addEventListener("click", loadData);
elements.retry.addEventListener("click", loadData);
loadData();

const mutableFields = ['name', 'country_code', 'timezone', 'latitude', 'longitude', 'site_type'];
const createFields = ['organisation_id', 'site_code', 'is_demo', ...mutableFields];
const invalid = (message) => { throw Object.assign(new Error(message), { status: 422 }); };

export function requireUuid(value, field = 'Identifier') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    invalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function boundedText(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(`${field} must be non-empty text of at most ${maximum} characters without control characters`);
  }
  return value.trim();
}

export function validateSite(body, { partial = false, demoMode = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Site metadata must be an object');
  const allowed = partial ? mutableFields : createFields;
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('Unsupported or immutable site field');
  if (partial && Object.keys(body).length === 0) invalid('At least one editable site field is required');
  const site = {};
  if (!partial) {
    site.organisation_id = requireUuid(body.organisation_id, 'organisation_id');
    site.site_code = boundedText(body.site_code, 'site_code', 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(site.site_code)) invalid('site_code must contain only identifier characters');
    if (body.is_demo !== undefined && typeof body.is_demo !== 'boolean') invalid('is_demo must be a boolean');
    site.is_demo = body.is_demo ?? false;
    if (site.is_demo && !demoMode) invalid('Synthetic sites cannot be created in live mode');
  }
  for (const field of mutableFields) {
    if (partial && !Object.hasOwn(body, field)) continue;
    const value = body[field];
    if (field === 'name') site.name = boundedText(value, field, 160);
    else if (field === 'country_code') {
      if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) invalid('country_code must be two letters');
      site.country_code = value.toUpperCase();
    } else if (field === 'timezone') {
      site.timezone = boundedText(value ?? (partial ? '' : 'UTC'), field, 80);
      try { new Intl.DateTimeFormat('en', { timeZone: site.timezone }); }
      catch { invalid('timezone must be a supported time-zone identifier'); }
    } else if (field === 'site_type') {
      site.site_type = value ?? (partial ? '' : 'other');
      if (typeof site.site_type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(site.site_type)) invalid('site_type must be a lowercase classification identifier');
    } else {
      const limit = field === 'latitude' ? 90 : 180;
      const coordinate = value ?? null;
      if (coordinate !== null && (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > limit)) {
        invalid(`${field} must be null or a number within its geographic range`);
      }
      site[field] = coordinate;
    }
  }
  return site;
}

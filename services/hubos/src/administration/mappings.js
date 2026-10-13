import { requireUuid } from './sites.js';

export function validateMapping(body) {
  const invalid = (message) => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['site_id', 'external_id', 'verified'].includes(key))) invalid('Unsupported mapping fields');
  const site_id = requireUuid(body.site_id, 'site_id');
  if (typeof body.external_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(body.external_id)) {
    invalid('external_id must be a bounded infrastructure identifier without personal contact fields');
  }
  if (body.verified !== undefined && typeof body.verified !== 'boolean') invalid('verified must be a boolean');
  return { site_id, external_id: body.external_id, verified: body.verified ?? false };
}

export function validateMappingChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length
    || Object.keys(body).some((field) => !['site_id', 'verified'].includes(field))) {
    throw Object.assign(new Error('Only site association and verification can be edited'), { status: 422 });
  }
  if (Object.hasOwn(body, 'verified') && typeof body.verified !== 'boolean') {
    throw Object.assign(new Error('verified must be a boolean'), { status: 422 });
  }
  return { ...(Object.hasOwn(body, 'site_id') ? { site_id: requireUuid(body.site_id, 'site_id') } : {}),
    ...(Object.hasOwn(body, 'verified') ? { verified: body.verified } : {}) };
}

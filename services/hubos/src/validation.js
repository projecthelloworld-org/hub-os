import { sanitizeAttributes } from './privacy.js';

const observationKeys = [
  "source_connection_id",
  "external_record_id",
  "metric",
  "value",
  "observed_at",
];

export function validateObservationBatch(body) {
  if (!body || !Array.isArray(body.observations)) {
    throw Object.assign(new Error("Body must contain an observations array"), { status: 422 });
  }
  if (body.observations.length === 0 || body.observations.length > 1000) {
    throw Object.assign(new Error("observations must contain between 1 and 1000 records"), { status: 422 });
  }
  body.observations.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      throw Object.assign(new Error(`observations[${index}] must be an object`), { status: 422 });
    }
    for (const key of observationKeys) {
      if (item[key] === undefined || item[key] === null || item[key] === "") {
        throw Object.assign(new Error(`observations[${index}].${key} is required`), { status: 422 });
      }
    }
    if (!item.site_id && !item.site_code) {
      throw Object.assign(new Error(`observations[${index}] requires site_id or site_code`), { status: 422 });
    }
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
      throw Object.assign(new Error(`observations[${index}].value must be a finite number`), { status: 422 });
    }
    if (Number.isNaN(Date.parse(item.observed_at))) {
      throw Object.assign(new Error(`observations[${index}].observed_at must be an ISO date`), { status: 422 });
    }
    if (typeof item.metric !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(item.metric) || item.metric.length > 160) {
      throw Object.assign(new Error(`observations[${index}].metric must be a canonical metric name`), { status: 422 });
    }
    if (typeof item.external_record_id !== 'string' || item.external_record_id.length > 256) {
      throw Object.assign(new Error(`observations[${index}].external_record_id must be a bounded identifier`), { status: 422 });
    }
    if (!['valid', 'estimated', 'suspect', 'invalid'].includes(item.quality ?? 'valid')) {
      throw Object.assign(new Error(`observations[${index}].quality is invalid`), { status: 422 });
    }
    if (item.unit != null && (typeof item.unit !== 'string' || !/^[a-zA-Z0-9%/_.-]{1,32}$/.test(item.unit))) {
      throw Object.assign(new Error(`observations[${index}].unit is invalid`), { status: 422 });
    }
  });
  return body.observations.map((item) => ({
    ...item,
    unit: item.unit ?? null,
    quality: item.quality ?? "valid",
    attributes: sanitizeAttributes(item.attributes),
  }));
}

export function requireText(body, field, maximum = 500) {
  const value = body?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 422 });
  }
  if (value.length > maximum) {
    throw Object.assign(new Error(`${field} must be ${maximum} characters or fewer`), { status: 422 });
  }
  return value.trim();
}

// A read-time projection: silence never mutates the historical evidence/incident ledger.
export function isCurrentEvidence(observedAt, maximumAgeSeconds, now = Date.now()) {
  const timestamp = new Date(observedAt).getTime();
  return observedAt != null && Number.isFinite(timestamp)
    && timestamp >= now - maximumAgeSeconds * 1000 && timestamp <= now + 60000;
}

export function currentStatus(evidence, now = Date.now()) {
  return isCurrentEvidence(evidence.observed_at, 300, now) ? { ...evidence }
    : { ...evidence, status: 'unknown', reason: 'Evidence is missing, stale or outside the accepted clock tolerance' };
}

export function currentSource(source, now = Date.now()) {
  if (!source.enabled || source.status === 'disabled') return { ...source, status: 'disabled' };
  return isCurrentEvidence(source.last_success_at, source.freshness_seconds ?? 300, now) ? { ...source }
    : { ...source, status: 'unknown' };
}

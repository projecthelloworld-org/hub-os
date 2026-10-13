// A read-time projection: silence never mutates the historical evidence/incident ledger.
export function isCurrentEvidence(observedAt, maximumAgeSeconds, now = Date.now()) {
  const timestamp = new Date(observedAt).getTime();
  return observedAt != null && Number.isFinite(timestamp)
    && timestamp >= now - maximumAgeSeconds * 1000 && timestamp <= now + 60000;
}

export function currentStatus(evidence, now = Date.now()) {
  const { source_active, ...status } = evidence;
  return source_active !== false && isCurrentEvidence(evidence.observed_at, 300, now) ? status
    : { ...status, status: 'unknown', reason: 'Evidence is missing, stale, unattributed or from a disabled source' };
}

export function currentSource(source, now = Date.now()) {
  if (!source.enabled || source.status === 'disabled') return { ...source, status: 'disabled' };
  return isCurrentEvidence(source.last_success_at, source.freshness_seconds ?? 300, now) ? { ...source }
    : { ...source, status: 'unknown' };
}

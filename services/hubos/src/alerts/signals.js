import { StoreError } from '../store/errors.js';

export const rules = Object.freeze({
  availability: { title: 'Monitored target unavailable', severity: 'high' },
  'collection-freshness': { title: 'Collection overdue', severity: 'medium' },
  'device-check-in': { title: 'Managed-device check-ins stale', severity: 'medium' },
  'field-fault': { title: 'Operational fault reported', severity: 'high' },
});

// Bun SQL returns Date instances. Date.parse(Date) drops their milliseconds.
const timestamp = (value) => value instanceof Date ? value.getTime() : Date.parse(value);

export function validateSignal(signal) {
  if (!signal || !rules[signal.rule_id] || !['site', 'monitor'].includes(signal.subject_type)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(signal.subject_id ?? '')
    || !['active', 'healthy', 'unknown'].includes(signal.state)
    || Number.isNaN(timestamp(signal.observed_at))) throw new StoreError(422, 'Invalid operational signal');
  if (timestamp(signal.observed_at) > Date.now() + 60000) throw new StoreError(422, 'Signal time is in the future');
  return { rule_id: signal.rule_id, subject_type: signal.subject_type, subject_id: signal.subject_id,
    state: signal.state, observed_at: new Date(signal.observed_at).toISOString() };
}

export function decideSignalTransition(previous, signal, incident) {
  if (previous?.latest_at && timestamp(signal.observed_at) <= timestamp(previous.latest_at)) return 'ignored';
  const activeIncident = incident && ['open', 'acknowledged'].includes(incident.status);
  if (signal.state === 'active') return activeIncident ? 'updated' : 'opened';
  if (signal.state === 'healthy' && activeIncident) return 'recovered';
  return signal.state === 'unknown' ? 'unknown' : 'healthy';
}

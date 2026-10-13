import { randomId } from '../ids.js';
import { safeError } from '../privacy.js';
import { StoreError } from './errors.js';
import { rules, validateSignal, decideSignalTransition } from '../alerts/signals.js';

export async function registerMonitor(db, monitor) {
  const [source] = await db`SELECT organisation_id FROM source_connections WHERE id = ${monitor.source_connection_id}`;
  if (!source) throw new StoreError(404, 'Source not found');
  if (monitor.site_id) {
    const [site] = await db`SELECT organisation_id FROM sites WHERE id = ${monitor.site_id}`;
    if (!site || String(site.organisation_id) !== String(source.organisation_id)) throw new StoreError(422, 'Monitor site is not in the source organisation');
  }
  const [row] = await db`
    INSERT INTO monitors (id, source_connection_id, external_id, site_id, name, scope, interval_seconds, enabled, is_demo)
    VALUES (${monitor.id ?? randomId()}, ${monitor.source_connection_id}, ${monitor.external_id}, ${monitor.site_id ?? null},
      ${monitor.name}, ${monitor.scope}, ${monitor.interval_seconds ?? 60}, ${monitor.enabled ?? true}, ${monitor.is_demo ?? false})
    ON CONFLICT (source_connection_id, external_id) DO NOTHING RETURNING *
  `;
  // Never overwrite user-adjusted monitor metadata on repeat provisioning.
  return row ?? (await db`SELECT * FROM monitors WHERE source_connection_id = ${monitor.source_connection_id} AND external_id = ${monitor.external_id}`)[0];
}

export async function ingestMonitorSamples(db, sourceId, samples) {
  let accepted = 0;
  for (const item of samples) {
    if (!Number.isFinite(Date.parse(item.observed_at)) || ![null, 0, 1].includes(item.status)
      || (item.response_ms != null && (!Number.isFinite(item.response_ms) || item.response_ms < 0))) {
      throw new StoreError(422, 'Invalid monitor measurement');
    }
    const rows = await db`
      INSERT INTO monitor_samples (monitor_id, observed_at, status, response_ms, origin)
      SELECT id, ${item.observed_at}, ${item.status}, ${item.status === 1 ? item.response_ms ?? null : null}, ${item.origin}
      FROM monitors WHERE id = ${item.monitor_id} AND source_connection_id = ${sourceId} AND enabled
      ON CONFLICT (monitor_id, observed_at) DO NOTHING RETURNING id
    `;
    accepted += rows.length;
  }
  return { accepted, duplicates: samples.length - accepted };
}

export async function applySignal(db, sourceId, incoming) {
  const signal = validateSignal(incoming);
  return db.begin(async (tx) => {
    let subject;
    if (signal.subject_type === 'monitor') {
      [subject] = await tx`SELECT site_id, id AS monitor_id, name, scope, is_demo
        FROM monitors WHERE id = ${signal.subject_id} AND source_connection_id = ${sourceId} AND enabled`;
    } else {
      [subject] = await tx`SELECT s.id AS site_id, s.name, 'community' AS scope, s.is_demo
        FROM sites s JOIN external_identifiers ei ON ei.entity_id = s.id AND ei.entity_type = 'site'
        JOIN source_connections sc ON sc.id = ei.source_connection_id AND sc.organisation_id = s.organisation_id
        WHERE ei.source_connection_id = ${sourceId} AND ei.verified AND s.id = ${signal.subject_id} LIMIT 1`;
    }
    if (!subject) throw new StoreError(422, 'Signal subject is not mapped to this source');
    await tx`INSERT INTO alert_signal_state (source_connection_id, rule_id, subject_type, subject_id)
      VALUES (${sourceId}, ${signal.rule_id}, ${signal.subject_type}, ${signal.subject_id}) ON CONFLICT DO NOTHING`;
    const [previous] = await tx`SELECT * FROM alert_signal_state WHERE source_connection_id = ${sourceId}
      AND rule_id = ${signal.rule_id} AND subject_type = ${signal.subject_type} AND subject_id = ${signal.subject_id} FOR UPDATE`;
    const incident = previous.incident_id
      ? (await tx`SELECT * FROM incidents WHERE id = ${previous.incident_id} FOR UPDATE`)[0] : null;
    const transition = decideSignalTransition(previous, signal, incident);
    if (transition === 'ignored') return { transition, incident_id: previous.incident_id };
    let incidentId = previous.incident_id;
    if (transition === 'opened') {
      incidentId = randomId();
      const rule = rules[signal.rule_id];
      const title = `${rule.title}: ${subject.name}`;
      await tx`INSERT INTO incidents (id, site_id, monitor_id, source_connection_id, rule_id, title, severity,
        status, started_at, last_signal_at, details)
        VALUES (${incidentId}, ${subject.site_id ?? null}, ${subject.monitor_id ?? null}, ${sourceId}, ${signal.rule_id},
          ${title}, ${rule.severity}, 'open', ${signal.observed_at}, ${signal.observed_at},
          ${JSON.stringify({ synthetic: subject.is_demo, scope: subject.scope })}::jsonb)`;
    } else if (transition === 'updated') {
      await tx`UPDATE incidents SET last_signal_at = ${signal.observed_at}, signal_count = signal_count + 1 WHERE id = ${incidentId}`;
    } else if (transition === 'recovered') {
      await tx`UPDATE incidents SET status = 'resolved', resolved_at = ${signal.observed_at},
        last_signal_at = ${signal.observed_at}, resolution = 'Explicit healthy evidence received' WHERE id = ${incidentId}`;
    }
    if (['opened', 'recovered'].includes(transition)) {
      await tx`INSERT INTO notification_outbox (id, incident_id, event_kind)
        VALUES (${randomId()}, ${incidentId}, ${transition}) ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE alert_signal_state SET latest_at = ${signal.observed_at}, state = ${signal.state}, incident_id = ${incidentId}
      WHERE source_connection_id = ${sourceId} AND rule_id = ${signal.rule_id}
      AND subject_type = ${signal.subject_type} AND subject_id = ${signal.subject_id}`;
    return { transition, incident_id: incidentId };
  });
}

export async function claimNotification(db, leaseSeconds = 60) {
  const rows = await db`
    WITH candidate AS (SELECT id FROM notification_outbox queued
      WHERE attempts < max_attempts AND next_attempt_at <= now() AND
        (status IN ('pending', 'failed') OR (status = 'sending' AND locked_at < now() - make_interval(secs => ${leaseSeconds})))
      AND (event_kind = 'opened' OR NOT EXISTS (SELECT 1 FROM notification_outbox opening
        WHERE opening.incident_id = queued.incident_id AND opening.event_kind = 'opened' AND opening.status NOT IN ('delivered', 'dead')))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE notification_outbox o SET status = 'sending', lease_token = gen_random_uuid(), locked_at = now()
    FROM candidate WHERE o.id = candidate.id RETURNING o.*
  `;
  if (!rows[0]) return null;
  const [incident] = await db`SELECT id, title, severity, status, started_at, resolved_at FROM incidents WHERE id = ${rows[0].incident_id}`;
  return { ...rows[0], incident };
}

export async function finishNotification(db, job, error = null) {
  if (!error) {
    await db`UPDATE notification_outbox SET status = 'delivered', delivered_at = now(), locked_at = NULL, lease_token = NULL, last_error = NULL
      WHERE id = ${job.id} AND lease_token = ${job.lease_token}`;
  } else {
    await db`UPDATE notification_outbox SET attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'failed' END,
      next_attempt_at = now() + make_interval(secs => least(3600, 10 * power(2, attempts)::int)),
      last_error = ${safeError(error)}, locked_at = NULL, lease_token = NULL
      WHERE id = ${job.id} AND lease_token = ${job.lease_token}`;
  }
}

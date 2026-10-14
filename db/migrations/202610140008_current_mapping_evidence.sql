-- migrate:up
-- Historical identities stay unchanged. Only current, verified associations
-- can support present status or rule evaluation after a mapping correction.
CREATE OR REPLACE VIEW analytics.metric_current AS
SELECT latest.site_id, latest.source_connection_id, s.site_code, s.name AS site_name,
       s.country_code, s.site_type, sc.name AS source_name, sc.plugin_id,
       s.is_demo OR sc.is_demo AS synthetic, latest.metric, latest.unit, latest.quality, latest.observed_at,
       CASE WHEN evidence.fresh THEN latest.value END AS value, evidence.fresh, now() AS as_of
FROM (SELECT DISTINCT ON (site_id, source_connection_id, metric) * FROM observations
      ORDER BY site_id, source_connection_id, metric, observed_at DESC, id DESC) latest
JOIN sites s ON s.id = latest.site_id
JOIN source_connections sc ON sc.id = latest.source_connection_id AND sc.organisation_id = s.organisation_id
CROSS JOIN LATERAL (SELECT CASE
  WHEN sc.config->>'evidence_max_age_seconds' ~ '^[0-9]{1,7}$'
    THEN greatest(60, least(2592000, (sc.config->>'evidence_max_age_seconds')::integer))
  ELSE sc.freshness_seconds END AS seconds) horizon
CROSS JOIN LATERAL (SELECT coalesce(sc.enabled AND latest.quality = 'valid'
  AND EXISTS (SELECT 1 FROM external_identifiers ei WHERE ei.source_connection_id = sc.id
    AND ei.entity_type = 'site' AND ei.entity_id = latest.site_id AND ei.verified)
  AND latest.observed_at BETWEEN now() - make_interval(secs => horizon.seconds) AND now() + interval '1 minute'
  AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute', false) AS fresh) evidence;

CREATE OR REPLACE VIEW analytics.site_status_current AS
SELECT s.id AS site_id, s.site_code, s.name AS site_name, s.country_code, ss.domain,
       CASE WHEN sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.status ELSE 'unknown' END AS status,
       CASE WHEN sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.reason ELSE 'Evidence is missing, stale, unattributed, unmapped or from a disabled source' END AS reason,
       ss.observed_at, now() - ss.observed_at AS evidence_age
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id
LEFT JOIN source_connections sc ON sc.id = ss.source_connection_id AND sc.organisation_id = s.organisation_id
  AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
  AND EXISTS (SELECT 1 FROM external_identifiers ei WHERE ei.source_connection_id = sc.id
    AND ei.entity_type = 'site' AND ei.entity_id = ss.site_id AND ei.verified);

CREATE OR REPLACE VIEW analytics.community_operations AS
SELECT s.id AS site_id, s.organisation_id, s.site_code, s.name AS site_name, s.country_code, s.site_type, s.is_demo AS synthetic,
       max(ss.observed_at) AS observed_at,
       coalesce(max(CASE WHEN ss.domain = 'connectivity' AND sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS connectivity,
       coalesce(max(CASE WHEN ss.domain = 'power' AND sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS power,
       coalesce(max(CASE WHEN ss.domain = 'devices' AND sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS devices,
       (SELECT count(*) FROM incidents i WHERE i.site_id = s.id AND i.status IN ('open', 'acknowledged')) AS active_incidents,
       now() AS as_of
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id
LEFT JOIN source_connections sc ON sc.id = ss.source_connection_id AND sc.organisation_id = s.organisation_id
  AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
  AND EXISTS (SELECT 1 FROM external_identifiers ei WHERE ei.source_connection_id = sc.id
    AND ei.entity_type = 'site' AND ei.entity_id = ss.site_id AND ei.verified)
GROUP BY s.id;

-- migrate:down
-- Retain safe read-time rules when rolling application code back.
SELECT 1;

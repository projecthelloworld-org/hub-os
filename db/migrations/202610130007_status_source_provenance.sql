-- migrate:up
-- Preserve old snapshots verbatim. Unattributed evidence is not a current claim.
ALTER TABLE status_snapshots ADD COLUMN source_connection_id uuid
  REFERENCES source_connections(id) ON DELETE SET NULL;

CREATE OR REPLACE VIEW analytics.site_status_current AS
SELECT s.id AS site_id, s.site_code, s.name AS site_name, s.country_code, ss.domain,
       CASE WHEN sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.status ELSE 'unknown' END AS status,
       CASE WHEN sc.enabled AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.reason ELSE 'Evidence is missing, stale, unattributed or from a disabled source' END AS reason,
       ss.observed_at, now() - ss.observed_at AS evidence_age
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id
LEFT JOIN source_connections sc ON sc.id = ss.source_connection_id AND sc.organisation_id = s.organisation_id
  AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute';

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
GROUP BY s.id;

CREATE OR REPLACE VIEW analytics.monitor_current AS
SELECT m.id AS monitor_id, m.name AS monitor_name, m.scope, m.site_id,
       s.site_code, s.name AS site_name, s.country_code, m.is_demo AS synthetic,
       m.source_connection_id, ms.observed_at,
       CASE WHEN NOT m.enabled OR NOT sc.enabled OR sc.last_success_at IS NULL OR
                  sc.last_success_at NOT BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute' OR ms.observed_at IS NULL OR
                  ms.observed_at NOT BETWEEN now() - make_interval(secs => m.interval_seconds * 2) AND now() + interval '1 minute'
            THEN 'unknown' WHEN ms.status = 1 THEN 'up' WHEN ms.status = 0 THEN 'down' ELSE 'unknown' END AS status,
       CASE WHEN m.enabled AND sc.enabled AND sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
                  AND ms.status = 1 AND ms.observed_at BETWEEN
                  now() - make_interval(secs => m.interval_seconds * 2) AND now() + interval '1 minute'
            THEN ms.response_ms END AS response_ms, now() AS as_of
FROM monitors m JOIN source_connections sc ON sc.id = m.source_connection_id
LEFT JOIN sites s ON s.id = m.site_id
LEFT JOIN LATERAL (SELECT * FROM monitor_samples WHERE monitor_id = m.id ORDER BY observed_at DESC LIMIT 1) ms ON true;

-- migrate:down
-- Keep additive provenance and safe views when rolling application code back.
SELECT 1;

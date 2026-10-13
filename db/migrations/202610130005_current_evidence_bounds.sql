-- migrate:up
-- Apply the same missing/stale/future policy to old and new reporting surfaces.
CREATE OR REPLACE VIEW analytics.site_status_current AS
SELECT s.id AS site_id, s.site_code, s.name AS site_name, s.country_code, ss.domain,
       CASE WHEN ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.status ELSE 'unknown' END AS status,
       CASE WHEN ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute'
            THEN ss.reason ELSE 'Evidence is missing, stale or outside the accepted clock tolerance' END AS reason,
       ss.observed_at, now() - ss.observed_at AS evidence_age
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id;

CREATE OR REPLACE VIEW analytics.community_operations AS
SELECT s.id AS site_id, s.organisation_id, s.site_code, s.name AS site_name, s.country_code, s.site_type, s.is_demo AS synthetic,
       max(ss.observed_at) AS observed_at,
       coalesce(max(CASE WHEN ss.domain = 'connectivity' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS connectivity,
       coalesce(max(CASE WHEN ss.domain = 'power' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS power,
       coalesce(max(CASE WHEN ss.domain = 'devices' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS devices,
       (SELECT count(*) FROM incidents i WHERE i.site_id = s.id AND i.status IN ('open', 'acknowledged')) AS active_incidents
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id GROUP BY s.id;

CREATE OR REPLACE VIEW analytics.collection_status AS
SELECT sc.id AS source_connection_id, sc.name AS source_name, sc.plugin_id,
       sc.enabled, sc.is_demo AS synthetic, sc.last_success_at, sc.freshness_seconds,
       CASE WHEN NOT sc.enabled THEN 'disabled'
            WHEN sc.last_success_at IS NULL OR sc.last_success_at > now() + interval '1 minute' THEN 'unknown'
            WHEN sc.last_success_at < now() - make_interval(secs => sc.freshness_seconds) THEN 'stale'
            ELSE 'current' END AS freshness,
       ei.entity_id AS site_id, s.site_code, s.country_code, s.site_type
FROM source_connections sc
LEFT JOIN (SELECT DISTINCT source_connection_id, entity_id FROM external_identifiers
           WHERE entity_type = 'site' AND verified) ei ON ei.source_connection_id = sc.id
LEFT JOIN sites s ON s.id = ei.entity_id AND s.organisation_id = sc.organisation_id;

CREATE OR REPLACE VIEW analytics.connector_health AS
SELECT sc.id AS source_connection_id, sc.name, sc.connector_type, sc.collection_mode,
       CASE WHEN NOT sc.enabled OR sc.status = 'disabled' THEN 'disabled'
            WHEN sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
            THEN sc.status ELSE 'unknown' END AS status,
       sc.last_success_at, now() - sc.last_success_at AS time_since_success
FROM source_connections sc;

CREATE OR REPLACE VIEW analytics.operational_rule_conditions AS
SELECT s.id AS site_id, sc.id AS source_connection_id, 'collection-freshness'::text AS rule_id,
       CASE WHEN NOT sc.enabled OR sc.last_success_at > now() + interval '1 minute' THEN 'unknown'
            WHEN sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute' THEN 'healthy'
            WHEN coalesce(sc.last_success_at, sc.created_at) < now() - make_interval(secs => sc.freshness_seconds) THEN 'active'
            ELSE 'unknown' END AS state,
       CASE WHEN sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
            THEN sc.last_success_at ELSE now() END AS observed_at
FROM source_connections sc JOIN (SELECT DISTINCT source_connection_id, entity_id FROM external_identifiers WHERE entity_type = 'site' AND verified) ei ON ei.source_connection_id = sc.id
JOIN sites s ON s.id = ei.entity_id AND s.organisation_id = sc.organisation_id
WHERE (sc.enabled OR sc.last_success_at IS NOT NULL) AND sc.collection_mode IN ('api_pull', 'controller_pull', 'scheduled_pull')
UNION ALL
SELECT site_id, source_connection_id, 'availability',
       CASE WHEN NOT fresh OR value IS NULL THEN 'unknown' WHEN value = 0 THEN 'active' WHEN value = 1 THEN 'healthy' ELSE 'unknown' END,
       observed_at
FROM analytics.metric_current WHERE metric = 'connectivity.wan.available'
UNION ALL
SELECT d.site_id, d.source_connection_id, 'device-check-in',
       CASE WHEN d.stale_check_ins > CASE WHEN sc.config#>>'{alert_thresholds,stale_device_count}' ~ '^[0-9]{1,6}$'
                    THEN (sc.config#>>'{alert_thresholds,stale_device_count}')::integer ELSE 0 END THEN 'active'
            WHEN d.inventory_count > 0 AND d.stale_check_ins IS NOT NULL AND d.unknown_check_ins = 0 THEN 'healthy'
            ELSE 'unknown' END, d.observed_at
FROM analytics.device_evidence d JOIN source_connections sc ON sc.id = d.source_connection_id
UNION ALL
SELECT f.site_id, f.source_connection_id, 'field-fault',
       CASE WHEN f.fault_count IS NULL THEN 'unknown'
            WHEN f.fault_count > CASE WHEN sc.config#>>'{alert_thresholds,fault_count}' ~ '^[0-9]{1,6}$'
                    THEN (sc.config#>>'{alert_thresholds,fault_count}')::integer ELSE 0 END THEN 'active' ELSE 'healthy' END, f.observed_at
FROM analytics.field_evidence f JOIN source_connections sc ON sc.id = f.source_connection_id;

-- migrate:down
-- Retain safe read-time bounds when rolling back application code.
SELECT 1;

-- migrate:up
-- Report validity can differ from polling freshness (e.g. a weekly inspection).
-- This generic configuration applies to any plugin; no vendor-specific tables.
CREATE OR REPLACE VIEW analytics.metric_current AS
SELECT latest.site_id, latest.source_connection_id, s.site_code, s.name AS site_name,
       s.country_code, s.site_type, sc.name AS source_name, sc.plugin_id,
       s.is_demo OR sc.is_demo AS synthetic, latest.metric, latest.unit, latest.quality, latest.observed_at,
       CASE WHEN evidence.fresh THEN latest.value END AS value, evidence.fresh, now() AS as_of
FROM (SELECT DISTINCT ON (site_id, source_connection_id, metric) * FROM observations
      ORDER BY site_id, source_connection_id, metric, observed_at DESC, id DESC) latest
JOIN sites s ON s.id = latest.site_id JOIN source_connections sc ON sc.id = latest.source_connection_id
CROSS JOIN LATERAL (SELECT CASE
  WHEN sc.config->>'evidence_max_age_seconds' ~ '^[0-9]{1,7}$'
    THEN greatest(60, least(2592000, (sc.config->>'evidence_max_age_seconds')::integer))
  ELSE sc.freshness_seconds END AS seconds) horizon
CROSS JOIN LATERAL (SELECT sc.enabled AND latest.quality = 'valid'
  AND latest.observed_at BETWEEN now() - make_interval(secs => horizon.seconds) AND now() + interval '1 minute'
  AND (NOT (sc.config ? 'evidence_max_age_seconds') OR
       sc.last_success_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute') AS fresh) evidence;

CREATE OR REPLACE VIEW analytics.community_operations AS
SELECT s.id AS site_id, s.organisation_id, s.site_code, s.name AS site_name, s.country_code, s.site_type, s.is_demo AS synthetic,
       max(ss.observed_at) AS observed_at,
       coalesce(max(CASE WHEN ss.domain = 'connectivity' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS connectivity,
       coalesce(max(CASE WHEN ss.domain = 'power' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS power,
       coalesce(max(CASE WHEN ss.domain = 'devices' AND ss.observed_at BETWEEN now() - interval '5 minutes' AND now() + interval '1 minute' THEN ss.status END), 'unknown') AS devices,
       (SELECT count(*) FROM incidents i WHERE i.site_id = s.id AND i.status IN ('open', 'acknowledged')) AS active_incidents,
       now() AS as_of
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id GROUP BY s.id;

CREATE OR REPLACE VIEW analytics.device_evidence AS
SELECT site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic,
       max(observed_at) AS observed_at,
       max(value) FILTER (WHERE metric = 'devices.inventory.count') AS inventory_count,
       max(value) FILTER (WHERE metric = 'devices.check_in.recent.count') AS recent_check_ins,
       max(value) FILTER (WHERE metric = 'devices.check_in.stale.count') AS stale_check_ins,
       max(value) FILTER (WHERE metric = 'devices.check_in.unknown.count') AS unknown_check_ins,
       now() AS as_of
FROM analytics.metric_current WHERE metric LIKE 'devices.%'
GROUP BY site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic;

CREATE OR REPLACE VIEW analytics.field_evidence AS
SELECT site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic,
       max(observed_at) AS observed_at,
       max(value) FILTER (WHERE metric = 'field.report.fault.count') AS fault_count,
       max(value) FILTER (WHERE metric = 'field.report.devices.usable.count') AS usable_devices,
       max(value) FILTER (WHERE metric = 'field.report.connectivity.available') AS reported_connectivity,
       max(value) FILTER (WHERE metric = 'field.report.power.available') AS reported_power,
       now() AS as_of
FROM analytics.metric_current WHERE metric LIKE 'field.report.%'
GROUP BY site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic;

CREATE OR REPLACE VIEW analytics.collection_status AS
SELECT sc.id AS source_connection_id, sc.name AS source_name, sc.plugin_id,
       sc.enabled, sc.is_demo AS synthetic, sc.last_success_at, sc.freshness_seconds,
       CASE WHEN NOT sc.enabled THEN 'disabled'
            WHEN sc.last_success_at IS NULL OR sc.last_success_at > now() + interval '1 minute' THEN 'unknown'
            WHEN sc.last_success_at < now() - make_interval(secs => sc.freshness_seconds) THEN 'stale'
            ELSE 'current' END AS freshness,
       ei.entity_id AS site_id, s.site_code, s.country_code, s.site_type, now() AS as_of
FROM source_connections sc
LEFT JOIN (SELECT DISTINCT source_connection_id, entity_id FROM external_identifiers
           WHERE entity_type = 'site' AND verified) ei ON ei.source_connection_id = sc.id
LEFT JOIN sites s ON s.id = ei.entity_id AND s.organisation_id = sc.organisation_id;

CREATE OR REPLACE VIEW analytics.monitor_current AS
SELECT m.id AS monitor_id, m.name AS monitor_name, m.scope, m.site_id,
       s.site_code, s.name AS site_name, s.country_code, m.is_demo AS synthetic,
       m.source_connection_id, ms.observed_at,
       CASE WHEN NOT m.enabled OR ms.observed_at IS NULL OR
                  ms.observed_at NOT BETWEEN now() - make_interval(secs => m.interval_seconds * 2) AND now() + interval '1 minute'
            THEN 'unknown' WHEN ms.status = 1 THEN 'up' WHEN ms.status = 0 THEN 'down' ELSE 'unknown' END AS status,
       CASE WHEN m.enabled AND ms.status = 1 AND ms.observed_at BETWEEN
                  now() - make_interval(secs => m.interval_seconds * 2) AND now() + interval '1 minute'
            THEN ms.response_ms END AS response_ms, now() AS as_of
FROM monitors m LEFT JOIN sites s ON s.id = m.site_id
LEFT JOIN LATERAL (SELECT * FROM monitor_samples WHERE monitor_id = m.id ORDER BY observed_at DESC LIMIT 1) ms ON true;

-- migrate:down
-- Additive reporting columns are retained so preserved dashboards stay usable.
SELECT 1;

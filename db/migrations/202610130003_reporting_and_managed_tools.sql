-- migrate:up

CREATE TABLE managed_tool_resources (
  tool text NOT NULL,
  kind text NOT NULL,
  resource_key text NOT NULL,
  external_id bigint NOT NULL,
  provisioned boolean NOT NULL DEFAULT false,
  definition_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool, kind, resource_key)
);
COMMENT ON TABLE managed_tool_resources IS 'Owned tool resource identifiers only; no channel secrets or dashboard data.';

CREATE VIEW analytics.metric_current AS
SELECT latest.site_id, latest.source_connection_id, s.site_code, s.name AS site_name,
       s.country_code, s.site_type, sc.name AS source_name, sc.plugin_id,
       s.is_demo OR sc.is_demo AS synthetic, latest.metric, latest.unit, latest.quality, latest.observed_at,
       CASE WHEN sc.enabled AND latest.quality = 'valid'
                  AND latest.observed_at BETWEEN now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute'
            THEN latest.value END AS value,
       sc.enabled AND latest.quality = 'valid' AND latest.observed_at BETWEEN
         now() - make_interval(secs => sc.freshness_seconds) AND now() + interval '1 minute' AS fresh
FROM (SELECT DISTINCT ON (site_id, source_connection_id, metric) * FROM observations
      ORDER BY site_id, source_connection_id, metric, observed_at DESC, id DESC) latest
JOIN sites s ON s.id = latest.site_id JOIN source_connections sc ON sc.id = latest.source_connection_id;

CREATE VIEW analytics.community_operations AS
SELECT s.id AS site_id, s.organisation_id, s.site_code, s.name AS site_name, s.country_code, s.site_type, s.is_demo AS synthetic,
       max(ss.observed_at) AS observed_at,
       coalesce(max(CASE WHEN ss.domain = 'connectivity' AND ss.observed_at >= now() - interval '5 minutes' THEN ss.status END), 'unknown') AS connectivity,
       coalesce(max(CASE WHEN ss.domain = 'power' AND ss.observed_at >= now() - interval '5 minutes' THEN ss.status END), 'unknown') AS power,
       coalesce(max(CASE WHEN ss.domain = 'devices' AND ss.observed_at >= now() - interval '5 minutes' THEN ss.status END), 'unknown') AS devices,
       (SELECT count(*) FROM incidents i WHERE i.site_id = s.id AND i.status IN ('open', 'acknowledged')) AS active_incidents
FROM sites s LEFT JOIN status_snapshots ss ON ss.site_id = s.id GROUP BY s.id;

CREATE VIEW analytics.device_evidence AS
SELECT site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic,
       max(observed_at) AS observed_at,
       max(value) FILTER (WHERE metric = 'devices.inventory.count') AS inventory_count,
       max(value) FILTER (WHERE metric = 'devices.check_in.recent.count') AS recent_check_ins,
       max(value) FILTER (WHERE metric = 'devices.check_in.stale.count') AS stale_check_ins,
       max(value) FILTER (WHERE metric = 'devices.check_in.unknown.count') AS unknown_check_ins
FROM analytics.metric_current WHERE metric LIKE 'devices.%'
GROUP BY site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic;

CREATE VIEW analytics.field_evidence AS
SELECT site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic,
       max(observed_at) AS observed_at,
       max(value) FILTER (WHERE metric = 'field.report.fault.count') AS fault_count,
       max(value) FILTER (WHERE metric = 'field.report.devices.usable.count') AS usable_devices,
       max(value) FILTER (WHERE metric = 'field.report.connectivity.available') AS reported_connectivity,
       max(value) FILTER (WHERE metric = 'field.report.power.available') AS reported_power
FROM analytics.metric_current WHERE metric LIKE 'field.report.%'
GROUP BY site_id, source_connection_id, site_code, site_name, country_code, source_name, synthetic;

CREATE VIEW analytics.notification_delivery AS
SELECT n.id, n.incident_id, n.event_kind, n.status, n.attempts, n.created_at, n.delivered_at,
       i.site_id, s.site_code, s.country_code, i.title, coalesce(m.scope, 'community') AS scope,
       coalesce(s.is_demo, false) OR coalesce(m.is_demo, false) AS synthetic
FROM notification_outbox n JOIN incidents i ON i.id = n.incident_id
LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN monitors m ON m.id = i.monitor_id;

-- Conditions at one site are assessed together; partial healthy evidence is never a recovery.
CREATE VIEW analytics.operational_rule_conditions AS
SELECT s.id AS site_id, sc.id AS source_connection_id, 'collection-freshness'::text AS rule_id,
       CASE WHEN NOT sc.enabled THEN 'unknown'
            WHEN sc.last_success_at IS NOT NULL AND sc.last_success_at >= now() - make_interval(secs => sc.freshness_seconds) THEN 'healthy'
            WHEN coalesce(sc.last_success_at, sc.created_at) < now() - make_interval(secs => sc.freshness_seconds) THEN 'active'
            ELSE 'unknown' END AS state,
       CASE WHEN sc.last_success_at IS NOT NULL AND sc.last_success_at >= now() - make_interval(secs => sc.freshness_seconds)
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

CREATE VIEW analytics.operational_rule_state AS
SELECT c.site_id, s.organisation_id, s.site_code, s.country_code, s.is_demo AS synthetic, c.rule_id,
       CASE WHEN bool_or(c.state = 'active') THEN 'active' WHEN bool_and(c.state = 'healthy') THEN 'healthy' ELSE 'unknown' END AS state,
       CASE WHEN bool_or(c.state = 'active') THEN max(c.observed_at) FILTER (WHERE c.state = 'active') ELSE max(c.observed_at) END AS observed_at
FROM analytics.operational_rule_conditions c JOIN sites s ON s.id = c.site_id
GROUP BY c.site_id, s.organisation_id, s.site_code, s.country_code, s.is_demo, c.rule_id;

-- migrate:down

DROP VIEW analytics.operational_rule_state;
DROP VIEW analytics.operational_rule_conditions;
DROP VIEW analytics.notification_delivery;
DROP VIEW analytics.field_evidence;
DROP VIEW analytics.device_evidence;
DROP VIEW analytics.community_operations;
DROP VIEW analytics.metric_current;
DROP TABLE managed_tool_resources;

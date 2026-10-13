-- migrate:up

-- Additive upgrade: canonical identities and existing evidence are not rewritten.
ALTER TABLE sites ADD COLUMN site_type text NOT NULL DEFAULT 'other'
  CHECK (site_type ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE source_connections ADD COLUMN plugin_id text;
UPDATE source_connections SET plugin_id = connector_type;
ALTER TABLE source_connections ALTER COLUMN plugin_id SET NOT NULL;
ALTER TABLE source_connections ADD COLUMN enabled boolean NOT NULL DEFAULT false;
ALTER TABLE source_connections ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE source_connections ADD COLUMN poll_interval_seconds integer NOT NULL DEFAULT 60
  CHECK (poll_interval_seconds BETWEEN 10 AND 86400);
ALTER TABLE source_connections ADD COLUMN freshness_seconds integer NOT NULL DEFAULT 300
  CHECK (freshness_seconds BETWEEN 10 AND 604800);

-- Preserve the legacy demonstration scheduler without implying live vendor integrations.
UPDATE source_connections sc SET plugin_id = 'mock-school-telemetry', enabled = true, is_demo = true,
  config = jsonb_build_object('demo', true, 'profile', CASE
    WHEN connector_type IN ('unifi', 'mikrotik') THEN 'connectivity'
    WHEN connector_type = 'innovex_remot' THEN 'power'
    WHEN connector_type = 'headwind' THEN 'devices'
    WHEN connector_type = 'odk' THEN 'survey' ELSE 'none' END)
FROM organisations org WHERE sc.organisation_id = org.id AND org.slug = 'phw-demo'
  AND EXISTS (SELECT 1 FROM external_identifiers ei JOIN sites s ON s.id = ei.entity_id
              WHERE ei.source_connection_id = sc.id AND ei.entity_type = 'site' AND s.is_demo)
  AND NOT EXISTS (SELECT 1 FROM external_identifiers ei JOIN sites s ON s.id = ei.entity_id
                  WHERE ei.source_connection_id = sc.id AND ei.entity_type = 'site' AND NOT s.is_demo);

-- One remote identifier has one meaning; several remote identifiers can name one site.
ALTER TABLE external_identifiers
  DROP CONSTRAINT external_identifiers_source_connection_id_entity_type_entit_key;
ALTER TABLE connector_jobs ADD COLUMN source_connection_id uuid
  REFERENCES source_connections(id) ON DELETE CASCADE;
ALTER TABLE connector_jobs ADD COLUMN lease_token uuid;
DROP INDEX connector_jobs_due_idx;
CREATE INDEX connector_jobs_due_idx ON connector_jobs (next_run_at, created_at)
  WHERE status IN ('pending', 'failed', 'running');
CREATE UNIQUE INDEX connector_jobs_source_collect_idx ON connector_jobs (source_connection_id, job_type)
  WHERE source_connection_id IS NOT NULL;

CREATE VIEW analytics.telemetry AS
SELECT o.id, o.site_id, s.site_code, s.name AS site_name, s.country_code, s.site_type,
       o.source_connection_id, sc.name AS source_name, sc.plugin_id,
       o.metric, o.value, o.unit, o.quality, o.observed_at, o.received_at,
       s.is_demo OR sc.is_demo AS synthetic,
       CASE WHEN o.attributes->>'scope' IN ('infrastructure', 'community', 'synthetic')
         THEN o.attributes->>'scope' ELSE 'community' END AS scope
FROM observations o JOIN sites s ON s.id = o.site_id
JOIN source_connections sc ON sc.id = o.source_connection_id;

CREATE VIEW analytics.collection_status AS
SELECT sc.id AS source_connection_id, sc.name AS source_name, sc.plugin_id,
       sc.enabled, sc.is_demo AS synthetic, sc.last_success_at, sc.freshness_seconds,
       CASE WHEN NOT sc.enabled THEN 'disabled'
            WHEN sc.last_success_at IS NULL THEN 'unknown'
            WHEN sc.last_success_at < now() - make_interval(secs => sc.freshness_seconds) THEN 'stale'
            ELSE 'current' END AS freshness,
       ei.entity_id AS site_id, s.site_code, s.country_code, s.site_type
FROM source_connections sc
LEFT JOIN (SELECT DISTINCT source_connection_id, entity_id FROM external_identifiers
           WHERE entity_type = 'site' AND verified) ei ON ei.source_connection_id = sc.id
LEFT JOIN sites s ON s.id = ei.entity_id;

-- migrate:down

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM external_identifiers
             GROUP BY source_connection_id, entity_type, entity_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Cannot downgrade: several external identifiers map to one entity';
  END IF;
END $$;
DROP VIEW analytics.collection_status;
DROP VIEW analytics.telemetry;
DROP INDEX connector_jobs_source_collect_idx;
DROP INDEX connector_jobs_due_idx;
CREATE INDEX connector_jobs_due_idx ON connector_jobs (next_run_at, created_at)
  WHERE status IN ('pending', 'failed');
ALTER TABLE connector_jobs DROP COLUMN lease_token, DROP COLUMN source_connection_id;
ALTER TABLE external_identifiers ADD UNIQUE (source_connection_id, entity_type, entity_id);
ALTER TABLE source_connections DROP COLUMN freshness_seconds, DROP COLUMN poll_interval_seconds,
  DROP COLUMN is_demo, DROP COLUMN enabled, DROP COLUMN plugin_id;
ALTER TABLE sites DROP COLUMN site_type;

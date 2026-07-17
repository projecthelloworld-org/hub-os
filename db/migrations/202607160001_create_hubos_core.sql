-- migrate:up

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  site_code text NOT NULL,
  name text NOT NULL,
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  timezone text NOT NULL DEFAULT 'UTC',
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, site_code)
);

CREATE TABLE source_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL,
  connector_type text NOT NULL,
  collection_mode text NOT NULL CHECK (collection_mode IN (
    'api_pull', 'controller_pull', 'webhook', 'file_import', 'site_agent_push', 'scheduled_pull'
  )),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy', 'degraded', 'critical', 'unknown', 'disabled')),
  base_url text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

COMMENT ON COLUMN source_connections.config IS 'Non-secret connector settings only; secrets belong in the deployment secret store.';

CREATE TABLE external_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('site', 'device', 'person', 'subscription', 'asset')),
  entity_id uuid NOT NULL,
  external_id text NOT NULL,
  mapping_method text NOT NULL DEFAULT 'manual',
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_connection_id, entity_type, external_id),
  UNIQUE (source_connection_id, entity_type, entity_id)
);

CREATE TABLE connector_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id text NOT NULL,
  job_type text NOT NULL DEFAULT 'collect',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'failed', 'completed', 'dead')),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  schedule_interval_seconds integer CHECK (schedule_interval_seconds IS NULL OR schedule_interval_seconds >= 10),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connector_job_id uuid REFERENCES connector_jobs(id) ON DELETE SET NULL,
  connector_id text NOT NULL,
  worker_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE TABLE raw_payloads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  connector_run_id bigint REFERENCES connector_runs(id) ON DELETE SET NULL,
  external_record_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  UNIQUE (source_connection_id, external_record_id)
);

CREATE TABLE observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  external_record_id text NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  value double precision NOT NULL,
  unit text,
  quality text NOT NULL DEFAULT 'valid' CHECK (quality IN ('valid', 'estimated', 'suspect', 'invalid')),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_connection_id, external_record_id, metric)
);

CREATE TABLE status_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('connectivity', 'power', 'devices', 'usage', 'survey', 'support')),
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'critical', 'unknown')),
  reason text NOT NULL,
  observed_at timestamptz NOT NULL,
  rule_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, domain)
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'closed')),
  owner text,
  started_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sites_country_idx ON sites (country_code, site_code);
CREATE INDEX external_identifiers_entity_idx ON external_identifiers (entity_type, entity_id);
CREATE INDEX connector_jobs_due_idx ON connector_jobs (next_run_at, created_at) WHERE status IN ('pending', 'failed');
CREATE INDEX connector_runs_started_idx ON connector_runs (started_at DESC);
CREATE INDEX raw_payloads_observed_idx ON raw_payloads (source_connection_id, observed_at DESC);
CREATE INDEX observations_site_metric_time_idx ON observations (site_id, metric, observed_at DESC);
CREATE INDEX observations_source_time_idx ON observations (source_connection_id, observed_at DESC);
CREATE INDEX incidents_active_idx ON incidents (severity, started_at DESC) WHERE status IN ('open', 'acknowledged');

CREATE TRIGGER organisations_updated_at BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sites_updated_at BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER source_connections_updated_at BEFORE UPDATE ON source_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER connector_jobs_updated_at BEFORE UPDATE ON connector_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER status_snapshots_updated_at BEFORE UPDATE ON status_snapshots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE SCHEMA analytics;

CREATE VIEW analytics.site_status_current AS
SELECT
  s.id AS site_id,
  s.site_code,
  s.name AS site_name,
  s.country_code,
  ss.domain,
  ss.status,
  ss.reason,
  ss.observed_at,
  now() - ss.observed_at AS evidence_age
FROM sites s
LEFT JOIN status_snapshots ss ON ss.site_id = s.id;

CREATE VIEW analytics.connector_health AS
SELECT
  sc.id AS source_connection_id,
  sc.name,
  sc.connector_type,
  sc.collection_mode,
  sc.status,
  sc.last_success_at,
  now() - sc.last_success_at AS time_since_success
FROM source_connections sc;

CREATE VIEW analytics.open_incidents AS
SELECT
  i.id,
  i.title,
  i.severity,
  i.status,
  i.owner,
  i.started_at,
  now() - i.started_at AS age,
  s.site_code,
  s.name AS site_name,
  s.country_code
FROM incidents i
JOIN sites s ON s.id = i.site_id
WHERE i.status IN ('open', 'acknowledged');

CREATE VIEW analytics.connectivity_daily AS
SELECT
  o.site_id,
  date_trunc('day', o.observed_at) AS day,
  avg(o.value) FILTER (WHERE o.metric = 'connectivity.wan.available') AS availability,
  avg(o.value) FILTER (WHERE o.metric = 'connectivity.latency.ms') AS latency_ms,
  avg(o.value) FILTER (WHERE o.metric = 'connectivity.packet_loss.percent') AS packet_loss_percent
FROM observations o
WHERE o.metric LIKE 'connectivity.%'
GROUP BY o.site_id, date_trunc('day', o.observed_at);

CREATE VIEW analytics.power_daily AS
SELECT
  o.site_id,
  date_trunc('day', o.observed_at) AS day,
  avg(o.value) FILTER (WHERE o.metric = 'power.battery.voltage') AS battery_voltage,
  avg(o.value) FILTER (WHERE o.metric = 'power.solar.output') AS solar_output_watts
FROM observations o
WHERE o.metric LIKE 'power.%'
GROUP BY o.site_id, date_trunc('day', o.observed_at);

CREATE VIEW analytics.device_activity_daily AS
SELECT
  o.site_id,
  date_trunc('day', o.observed_at) AS day,
  avg(o.value) FILTER (WHERE o.metric = 'devices.active.count') AS average_active_devices,
  max(o.value) FILTER (WHERE o.metric = 'devices.active.count') AS peak_active_devices
FROM observations o
WHERE o.metric LIKE 'devices.%'
GROUP BY o.site_id, date_trunc('day', o.observed_at);

CREATE VIEW analytics.data_freshness AS
SELECT
  s.id AS site_id,
  s.site_code,
  s.country_code,
  max(o.observed_at) AS latest_observation_at,
  now() - max(o.observed_at) AS evidence_age
FROM sites s
LEFT JOIN observations o ON o.site_id = s.id
GROUP BY s.id, s.site_code, s.country_code;

-- migrate:down

DROP SCHEMA IF EXISTS analytics CASCADE;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS status_snapshots;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS raw_payloads;
DROP TABLE IF EXISTS connector_runs;
DROP TABLE IF EXISTS connector_jobs;
DROP TABLE IF EXISTS external_identifiers;
DROP TABLE IF EXISTS source_connections;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS organisations;
DROP FUNCTION IF EXISTS set_updated_at();

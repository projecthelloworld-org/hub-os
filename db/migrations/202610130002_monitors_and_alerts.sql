-- migrate:up

-- Monitors are vendor-neutral targets. Infrastructure has no fictional community site.
CREATE TABLE monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('infrastructure', 'community', 'synthetic')),
  interval_seconds integer NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 20 AND 86400),
  enabled boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_connection_id, external_id),
  CHECK ((scope = 'infrastructure' AND site_id IS NULL) OR (scope <> 'infrastructure' AND site_id IS NOT NULL)),
  CHECK (scope <> 'synthetic' OR is_demo)
);

CREATE TABLE monitor_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status smallint CHECK (status IN (0, 1)),
  response_ms double precision CHECK (response_ms >= 0 AND response_ms < 86400000),
  origin text NOT NULL CHECK (origin IN ('metrics', 'webhook')),
  UNIQUE (monitor_id, observed_at)
);
CREATE INDEX monitor_samples_time_idx ON monitor_samples (monitor_id, observed_at DESC);

ALTER TABLE incidents ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE incidents ADD COLUMN monitor_id uuid REFERENCES monitors(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN source_connection_id uuid REFERENCES source_connections(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN rule_id text;
ALTER TABLE incidents ADD COLUMN last_signal_at timestamptz;
ALTER TABLE incidents ADD COLUMN signal_count integer NOT NULL DEFAULT 1;

CREATE TABLE alert_signal_state (
  source_connection_id uuid NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('site', 'monitor')),
  subject_id uuid NOT NULL,
  latest_at timestamptz,
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('active', 'healthy', 'unknown')),
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  PRIMARY KEY (source_connection_id, rule_id, subject_type, subject_id)
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_kind text NOT NULL CHECK (event_kind IN ('opened', 'recovered')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_token uuid,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, event_kind)
);

CREATE VIEW analytics.monitor_current AS
SELECT m.id AS monitor_id, m.name AS monitor_name, m.scope, m.site_id,
       s.site_code, s.name AS site_name, s.country_code, m.is_demo AS synthetic,
       m.source_connection_id, ms.observed_at,
       CASE WHEN NOT m.enabled OR ms.observed_at IS NULL OR
                  ms.observed_at < now() - make_interval(secs => m.interval_seconds * 2)
            THEN 'unknown' WHEN ms.status = 1 THEN 'up' WHEN ms.status = 0 THEN 'down' ELSE 'unknown' END AS status,
       CASE WHEN m.enabled AND ms.status = 1 AND ms.observed_at >= now() - make_interval(secs => m.interval_seconds * 2)
            THEN ms.response_ms END AS response_ms
FROM monitors m LEFT JOIN sites s ON s.id = m.site_id
LEFT JOIN LATERAL (SELECT * FROM monitor_samples WHERE monitor_id = m.id ORDER BY observed_at DESC LIMIT 1) ms ON true;

-- A measurement supports at most one interval, never a whole missing-data gap.
CREATE VIEW analytics.monitor_intervals AS
SELECT monitor_id, observed_at AS period_start,
       least(coalesce(next_at, 'infinity'::timestamptz), observed_at + make_interval(secs => interval_seconds)) AS period_end,
       status, response_ms
FROM (
  SELECT ms.*, m.interval_seconds,
         lead(ms.observed_at) OVER (PARTITION BY ms.monitor_id ORDER BY ms.observed_at) AS next_at
  FROM monitor_samples ms JOIN monitors m ON m.id = ms.monitor_id
) evidence;

CREATE VIEW analytics.monitor_daily AS
WITH windows AS (
  SELECT m.*, day, greatest(m.created_at, day) AS window_start,
         least(now(), day + interval '1 day') AS window_end
  FROM monitors m CROSS JOIN LATERAL generate_series(date_trunc('day', m.created_at), date_trunc('day', now()), interval '1 day') day
), durations AS (
  SELECT w.id AS monitor_id, w.day, w.scope, w.site_id, w.source_connection_id,
         w.is_demo AS synthetic, w.name AS monitor_name,
         greatest(0, extract(epoch FROM w.window_end - w.window_start)) AS eligible_seconds,
         i.status, i.response_ms,
         greatest(0, extract(epoch FROM least(i.period_end, w.window_end) - greatest(i.period_start, w.window_start))) AS seconds
  FROM windows w LEFT JOIN analytics.monitor_intervals i ON i.monitor_id = w.id
    AND i.period_start < w.window_end AND i.period_end > w.window_start
), totals AS (
  SELECT monitor_id, day, scope, site_id, source_connection_id, synthetic, monitor_name, eligible_seconds,
         coalesce(sum(seconds) FILTER (WHERE status IN (0, 1)), 0) AS observed_seconds,
         coalesce(sum(seconds) FILTER (WHERE status = 1), 0) AS up_seconds,
         coalesce(sum(seconds) FILTER (WHERE status = 0), 0) AS down_seconds,
         sum(response_ms * seconds) FILTER (WHERE status = 1) /
           nullif(sum(seconds) FILTER (WHERE status = 1 AND response_ms IS NOT NULL), 0) AS response_ms
  FROM durations GROUP BY monitor_id, day, scope, site_id, source_connection_id, synthetic, monitor_name, eligible_seconds
)
SELECT t.*, s.site_code, s.name AS site_name, s.country_code,
       observed_seconds / nullif(eligible_seconds, 0) AS observation_coverage,
       up_seconds / nullif(observed_seconds, 0) AS observed_uptime
FROM totals t LEFT JOIN sites s ON s.id = t.site_id;

CREATE VIEW analytics.incident_history AS
SELECT i.id, i.site_id, i.monitor_id, i.source_connection_id, i.rule_id,
       i.title, i.severity, i.status, i.owner, i.started_at, i.resolved_at, i.last_signal_at, i.signal_count,
       s.site_code, s.name AS site_name, s.country_code,
       coalesce(m.scope, 'community') AS scope, (coalesce(s.is_demo, false) OR coalesce(m.is_demo, false)) AS synthetic
FROM incidents i LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN monitors m ON m.id = i.monitor_id;

-- migrate:down

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM incidents WHERE site_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot downgrade: infrastructure incidents would be lost';
  END IF;
END $$;
DROP VIEW analytics.incident_history;
DROP VIEW analytics.monitor_daily;
DROP VIEW analytics.monitor_intervals;
DROP VIEW analytics.monitor_current;
DROP TABLE notification_outbox;
DROP TABLE alert_signal_state;
ALTER TABLE incidents DROP COLUMN signal_count, DROP COLUMN last_signal_at, DROP COLUMN rule_id,
  DROP COLUMN source_connection_id, DROP COLUMN monitor_id;
ALTER TABLE incidents ALTER COLUMN site_id SET NOT NULL;
DROP TABLE monitor_samples;
DROP TABLE monitors;

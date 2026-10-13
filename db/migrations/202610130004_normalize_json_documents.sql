-- migrate:up
-- Older Bun SQL clients encode a string parameter typed jsonb as a JSON string.
-- Preserve records and unwrap only valid JSON documents, never arbitrary text.
CREATE FUNCTION pg_temp.hubos_json_document(value jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE document jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'string' THEN RETURN value; END IF;
  BEGIN
    document := (value #>> '{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN value;
  END;
  IF jsonb_typeof(document) IN ('object', 'array') THEN RETURN document; END IF;
  RETURN value;
END $$;

UPDATE source_connections SET config = pg_temp.hubos_json_document(config) WHERE jsonb_typeof(config) = 'string';
UPDATE connector_jobs SET payload = pg_temp.hubos_json_document(payload) WHERE jsonb_typeof(payload) = 'string';
UPDATE connector_runs SET summary = pg_temp.hubos_json_document(summary) WHERE jsonb_typeof(summary) = 'string';
UPDATE raw_payloads SET payload = pg_temp.hubos_json_document(payload) WHERE jsonb_typeof(payload) = 'string';
UPDATE observations SET attributes = pg_temp.hubos_json_document(attributes) WHERE jsonb_typeof(attributes) = 'string';
UPDATE incidents SET details = pg_temp.hubos_json_document(details) WHERE jsonb_typeof(details) = 'string';
DROP FUNCTION pg_temp.hubos_json_document(jsonb);

-- migrate:down
-- Document normalization is intentionally retained: re-encoding it would corrupt
-- reporting semantics and is not needed by the v0.1 application reader.
SELECT 1;

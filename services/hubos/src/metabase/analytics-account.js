import { CollectionError } from '../connector-runtime/http-client.js';

export async function ensureAnalyticsAccount(db, { username, password, ownerUsername }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(username) || username === ownerUsername
    || ['postgres', 'metabase', 'hubos'].includes(username) || username.startsWith('pg_')
    || typeof password !== 'string' || password.length < 16) throw new CollectionError('INVALID_ANALYTICS_ACCOUNT');
  await db.begin(async (tx) => {
    const [role] = await tx`SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = ${username}`;
    if (role) {
      const [ownership] = await tx`SELECT EXISTS(SELECT 1 FROM pg_class WHERE relowner = ${role.oid})
        OR EXISTS(SELECT 1 FROM pg_database WHERE datdba = ${role.oid})
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner = ${role.oid})
        OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner = ${role.oid})
        OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member = ${role.oid}) AS unsafe`;
      if (ownership.unsafe || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication) {
        throw new CollectionError('ANALYTICS_ROLE_HAS_EXCESS_PRIVILEGES');
      }
    }
    // Values stay in this transaction; no password is embedded in saved SQL or logs.
    await tx`SELECT set_config('hubos.analytics_role', ${username}, true), set_config('hubos.analytics_password', ${password}, true)`;
    await tx.unsafe(`DO $$ DECLARE r text := current_setting('hubos.analytics_role'); BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', r);
      END IF;
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', r);
      EXECUTE format('ALTER ROLE %I PASSWORD %L', r, current_setting('hubos.analytics_password'));
      EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', r);
      EXECUTE format('ALTER ROLE %I SET timezone = %L', r, 'UTC');
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE CREATE ON SCHEMA public, analytics FROM %I', r);
      EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), r);
      EXECUTE format('GRANT USAGE ON SCHEMA analytics TO %I', r);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO %I', r);
    END $$`);
  });
  return { username, schemas: ['analytics'], read_only: true };
}

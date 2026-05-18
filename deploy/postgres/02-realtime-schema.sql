-- Runs once at first DB init (mounted at /docker-entrypoint-initdb.d/zz-realtime-schema.sql
-- by compose.infra.yml). The supabase/postgres image's entrypoint executes
-- every file in that directory as the postgres superuser, which is what we
-- need to CREATE SCHEMA AUTHORIZATION supabase_admin (postgres is NOT a
-- member of supabase_admin so this is the only safe place to do it).
--
-- Realtime's first boot fails with `(invalid_schema_name) no schema has
-- been selected to create in` unless this schema exists. Once present,
-- realtime auto-runs its own ecto migrations against it.

CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;

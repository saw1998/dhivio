-- Runs once at first DB init (mounted at /docker-entrypoint-initdb.d/
-- zz-dhivio-03-pgmq-grants.sql by compose.infra.yml). Executed by the
-- postgres superuser at initdb time, AFTER the supabase image's own seed
-- scripts have installed the pgmq extension and created the q_event_system /
-- q_embedding_jobs queues that our app uses out of the box.
--
-- Why this exists:
--   The supabase/postgres image installs pgmq with the schema and all q_*/a_*
--   tables owned by `supabase_admin`. Functions like pgmq.read/send/delete are
--   SECURITY INVOKER, so the wrapped UPDATE pgmq.q_<queue> runs as the calling
--   role. Our background jobs (Inngest event-queue cron in
--   packages/jobs/src/inngest/functions/events/queue.ts) connect as `postgres`
--   via SUPABASE_DB_URL / INNGEST_POSTGRES_URI — which has no DML on pgmq by
--   default — so every pgmq.read() fails with SQLSTATE 42501
--   ("permission denied for table q_event_system") and the ERP keeps logging
--   that error on every Inngest tick.
--
--   On hosted Supabase these grants are applied automatically the first time
--   "Expose Queues via PostgREST" is toggled in Studio. We mirror them here
--   so a fresh PGDATA volume comes up self-sufficient — no manual psql step
--   required after a clean-slate reset.
--
-- This script is wrapped in a DO block that catches undefined_schema /
-- undefined_object so a stripped-down supabase image (one without pgmq, or
-- one where pgmq is installed *after* zz-dhivio-03-* in lex order in the
-- future) doesn't abort initdb. In either case the rest of init proceeds
-- and we can re-apply this file by hand later.
--
-- Idempotent: GRANT / ALTER DEFAULT PRIVILEGES on the same (role, object,
-- privilege) tuple are no-ops on re-apply.

DO $pgmq_grants$
BEGIN
  -- 1. Schema-level USAGE (lets the role see pgmq.* objects at all).
  GRANT USAGE ON SCHEMA pgmq TO postgres, anon, authenticated, service_role;

  -- 2. Full DML for the trusted server-side roles. `postgres` is the
  --    connection role used by ERP + Inngest workers; `service_role` is
  --    the JWT-bearing bypass-RLS role for any future PostgREST / edge
  --    function consumers.
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgmq
    TO postgres, service_role;

  -- 3. Sequence access for client-facing roles (needed for currval()/
  --    nextval() if pgmq_public RPC wrappers are added later; harmless
  --    if they aren't).
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgmq
    TO anon, authenticated, service_role;

  -- 4. Future queues created by pgmq.create('queue_name') inherit grants
  --    automatically — so we never have to re-run this script to cover
  --    new queues.
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq
    GRANT ALL PRIVILEGES ON TABLES
    TO postgres, service_role;

  ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES
    TO anon, authenticated, service_role;

EXCEPTION
  WHEN undefined_schema OR undefined_object THEN
    RAISE NOTICE 'pgmq not present at init time — skipping grants. '
                 'Re-apply this file with `psql -U supabase_admin -f` '
                 'once the extension is installed.';
END
$pgmq_grants$;

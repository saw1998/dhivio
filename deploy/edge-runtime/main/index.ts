// Stub `main` dispatcher for supabase/edge-runtime.
//
// Replaced by .github/workflows/supabase.yml on every successful migrations
// run (which rsyncs packages/database/supabase/functions/* into
// /srv/dhivio/functions/ and restarts the edge-runtime container).
//
// Without this stub, edge-runtime crash-loops with:
//   "could not find an appropriate entrypoint"
// because compose.infra.yml's `command:` points at /home/deno/functions/main
// which is empty on a fresh VPS.
//
// Returns 200 + a marker JSON so health probes and `curl /functions/v1/main`
// succeed before any real functions are deployed.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(() => new Response(
  JSON.stringify({ status: "no-functions-deployed" }),
  { status: 200, headers: { "content-type": "application/json" } },
));

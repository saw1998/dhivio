// Edge-runtime `main` dispatcher for Dhivio self-hosted Supabase.
//
// supabase/edge-runtime is started with:
//   command: [start, --main-service, /home/deno/functions/main]
//
// The "--main-service" is NOT a passthrough function — it is the request
// ROUTER. edge-runtime hands EVERY incoming request to this dispatcher,
// which must:
//   1. Parse the function name from the URL path.
//   2. Boot a per-function Deno worker pointing at
//      /home/deno/functions/<name>/index.ts.
//   3. Forward the request to that worker and stream the response back.
//
// Before this rewrite, deploy/scripts/bootstrap.sh seeded a stub that
// returned `{status: "no-functions-deployed"}` for every URL — so every
// /functions/v1/<anything> call silently succeeded with that marker body.
// ERP got HTTP 201 from its supabase-js client (which treats any 2xx as
// success) and assumed seed-company had run, but in reality the function
// was never invoked. This file restores standard supabase/edge-runtime
// dispatcher behavior.
//
// Pattern is the upstream Supabase CLI's self-hosted template, adapted
// for our paths and edge-runtime v1.74.
//
// Logs every dispatch (function name + status) to docker logs for tracing.

// deno-lint-ignore-file no-explicit-any

console.log("main dispatcher booting (functions root: /home/deno/functions)");

const FUNCTIONS_ROOT = "/home/deno/functions";

// Conservative per-worker limits. Memory/timeouts are deliberately generous
// for our heavier functions (mrp, schedule, seed-company) but cap runaway
// workers. Tune via env if needed.
const WORKER_TIMEOUT_MS = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) ||
  150_000; // 150s — covers schedule/mrp long runs
const WORKER_MEMORY_MB = Number(Deno.env.get("EDGE_WORKER_MEMORY_MB")) || 256;
const NO_MODULE_CACHE = Deno.env.get("EDGE_NO_MODULE_CACHE") === "true";

// edge-runtime exposes `EdgeRuntime.userWorkers` as a global. Types aren't
// shipped, so we declare what we need.
declare const EdgeRuntime: {
  userWorkers: {
    create(opts: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      importMapPath?: string | null;
      envVars: [string, string][];
    }): Promise<{ fetch(req: Request): Promise<Response> }>;
  };
};

// Snapshot of env vars to pass through to every worker. We pre-compute once
// to avoid scanning Deno.env on every request.
const ENV_PASSTHROUGH: [string, string][] = Object.entries(Deno.env.toObject());

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // edge-runtime strips the `/functions/v1` prefix before forwarding to the
  // main service, so pathname looks like `/seed-company` or `/mrp/run`.
  // First non-empty segment is always the function name.
  const segments = url.pathname.split("/").filter(Boolean);
  const functionName = segments[0];

  if (!functionName) {
    return jsonResponse(400, {
      error: "missing function name",
      hint:
        "Expected POST /functions/v1/<name>. Got an empty path on the dispatcher.",
    });
  }

  const servicePath = `${FUNCTIONS_ROOT}/${functionName}`;

  // Cheap pre-check: if the function dir doesn't exist, return 404 instead
  // of asking edge-runtime to boot a worker pointing at nothing (which logs
  // a noisy stack trace).
  try {
    const stat = await Deno.stat(servicePath);
    if (!stat.isDirectory) throw new Error("not a directory");
  } catch {
    console.warn(`[main] 404 unknown function: ${functionName}`);
    return jsonResponse(404, {
      error: "function not found",
      function: functionName,
    });
  }

  const started = performance.now();
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: WORKER_MEMORY_MB,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      noModuleCache: NO_MODULE_CACHE,
      importMapPath: null,
      envVars: ENV_PASSTHROUGH,
    });

    const res = await worker.fetch(req);
    const elapsed = (performance.now() - started).toFixed(1);
    console.log(`[main] ${functionName} -> ${res.status} (${elapsed}ms)`);
    return res;
  } catch (err) {
    const elapsed = (performance.now() - started).toFixed(1);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[main] ${functionName} ERROR after ${elapsed}ms: ${msg}`);
    return jsonResponse(500, {
      error: "function execution failed",
      function: functionName,
      message: msg,
    });
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// edge-runtime v1.74 supports both `serve` and `Deno.serve`. Use the modern
// global API so we don't pull in std/http (which adds boot latency).
Deno.serve(handler);

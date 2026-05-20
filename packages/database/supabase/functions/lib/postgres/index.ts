import {
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresDialectConfig,
  PostgresIntrospector,
  PostgresQueryCompiler,
  Transaction,
} from "kysely";
import type { KyselifyDatabase } from "kysely-supabase";
// Aliased it as pg so can be imported as-is in Node environment
import { Pool } from "pg";
import type { Database as SupabaseDatabase } from "../../../../src/types.ts";

export type KyselyDatabase = KyselifyDatabase<SupabaseDatabase>;
export type KyselyTx = Transaction<KyselyDatabase>;
export type KyselyDbTx = KyselyDatabase | KyselyTx;

export type { Kysely } from "kysely";

export function getRuntime() {
  if (typeof (globalThis as Record<string, unknown>).Deno !== "undefined") {
    return "deno";
  }

  if (typeof globalThis.window !== "undefined") {
    return "browser";
  }

  return "node";
}

export function getPostgresConnectionPool(connections: number): Pool {
  const runtime = getRuntime();

  switch (runtime) {
    case "deno": {
      // @ts-expect-error -- Deno global is only available in Deno runtime
      const url = Deno.env.get("SUPABASE_DB_URL")!;
      const isHostedSupabase = url.includes("supabase.co");
      let connectionPoolerUrl = isHostedSupabase
        ? url.replace("5432", "6543")  // hosted: route via pgbouncer pooler
        : url;
      // Self-hosted postgres (e.g. supabase/postgres in our docker stack)
      // ships with `ssl = off` on the internal port. deno-postgres v0.17.0
      // defaults to `sslmode=prefer` which initiates a TLS handshake; when
      // the server replies "no SSL", the partial handshake leaves the
      // WebCrypto layer in a state where loading the (nonexistent) key
      // throws "No suitable key or wrong key type" — and every edge
      // function that uses this pool (seed-company, mrp, schedule, sync,
      // post-*, etc.) crashes at module-load time of getDatabaseClient.
      //
      // Force `sslmode=disable` whenever the URL doesn't already specify
      // an sslmode AND we're NOT talking to hosted Supabase (which
      // mandates TLS over the public internet). The node branch below
      // doesn't need this because npm `pg` defaults to no-TLS unless
      // `ssl` is set explicitly.
      if (
        !isHostedSupabase &&
        !/[?&]sslmode=/.test(connectionPoolerUrl)
      ) {
        connectionPoolerUrl +=
          (connectionPoolerUrl.includes("?") ? "&" : "?") +
          "sslmode=disable";
      }
      // @ts-ignore Compat
      return new Pool(connectionPoolerUrl, connections);
    }
    case "node": {
      const url = process.env.SUPABASE_DB_URL!;
      const connectionPoolerUrl = url.includes("supabase.co")
        ? url.replace("5432", "6543")
        : url;
      return new Pool({
        connectionString: connectionPoolerUrl,
        max: connections,
      });
    }

    default:
      throw new Error(
        "getPostgresConnectionPool is not supported in non-server environments"
      );
  }
}

interface PgDriverConstructor {
  new (config: PostgresDialectConfig): Driver;
}

export function getPostgresClient<D = KyselyDatabase>(
  pool: Pool,
  driver: PgDriverConstructor
): Kysely<D> {
  const runtime = getRuntime();

  switch (runtime) {
    case "node":
    case "deno": {
      return new Kysely<D>({
        dialect: {
          createAdapter() {
            return new PostgresAdapter();
          },
          createDriver() {
            return new driver({ pool });
          },
          createIntrospector(db: Kysely<unknown>) {
            return new PostgresIntrospector(db);
          },
          createQueryCompiler() {
            return new PostgresQueryCompiler();
          },
        },
      });
    }

    default:
      throw new Error(
        "getPostgresClient is not supported in non-server environments"
      );
  }
}

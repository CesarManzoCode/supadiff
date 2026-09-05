import { HostedSchemaReadinessError } from "./errors.js";

/**
 * The result of one Data-API visibility probe against a single `public` relation, classified
 * into exactly the three states `awaitSchemaReadiness` needs to decide what to do next:
 *
 * - `"ready"` — the relation resolved through PostgREST; move on.
 * - `"not-ready"` — the specific "schema cache has not caught up yet" condition (PGRST205 /
 *   equivalent "missing relation" response) — the only state that is retried.
 * - `"error"` — anything else (auth failure, malformed schema, genuine server error). Surfaces
 *   immediately; never silently retried until the timeout swallows it.
 */
export type SchemaReadinessProbeResult =
  | { status: "ready" }
  | { status: "not-ready" }
  | { status: "error"; error: unknown };

export type SchemaReadinessProbe = (table: string) => Promise<SchemaReadinessProbeResult>;

export interface SchemaReadinessOptions {
  /** The `public` base tables a just-applied schema must be visible through before returning. */
  tables: readonly string[];
  probe: SchemaReadinessProbe;
  /** Bounded attempt cap per table — this is a small poll, never an unbounded retry. */
  maxAttempts: number;
  /** Delay between attempts for the same table, applied only after a `"not-ready"` result. */
  delayMs: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the Data API for each `table` until it is actually visible through PostgREST, so a
 * hosted `schema.apply` never returns success while the schema cache is still mid-reload
 * (issue #6). Only the specific schema-cache-not-ready condition is retried; any other probe
 * outcome — an authorization failure, a malformed schema, an unrelated server error — is
 * thrown immediately. Bounded by `maxAttempts` per table: if the cache never converges, this
 * throws a `HostedSchemaReadinessError` rather than waiting forever.
 */
export async function awaitSchemaReadiness(opts: SchemaReadinessOptions): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  for (const table of opts.tables) {
    for (let attempt = 1; ; attempt++) {
      const result = await opts.probe(table);
      if (result.status === "ready") break;
      if (result.status === "error") throw result.error;
      if (attempt >= opts.maxAttempts) {
        throw new HostedSchemaReadinessError(table, attempt);
      }
      await sleep(opts.delayMs);
    }
  }
}

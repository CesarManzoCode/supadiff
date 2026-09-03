import type { TargetCapability } from "@supadiff/spec";
import type { SupaliteTargetKind } from "./types.js";

function cap(
  id: string,
  level: TargetCapability["level"],
  evidence: string,
  constraints: Record<string, unknown> = {},
): TargetCapability {
  return {
    id,
    version: "1.0.0",
    level,
    constraints: constraints as never,
    evidence: [{ kind: "note", value: evidence }],
    observed: false,
  };
}

const RESOURCE_OPS = [
  "schema.apply",
  "migration.apply",
  "data.seed",
  "data.select",
  "data.insert",
  "data.update",
  "data.upsert",
  "data.delete",
  "http.preflight",
] as const;

const AUTH_OPS_EXACT = [
  "auth.password.signup",
  "auth.password.signin",
  "auth.session.read",
  "auth.user.update",
  "auth.session.refresh",
  "auth.session.revoke",
] as const;

const STORAGE_OPS_EXPERIMENTAL = [
  "storage.bucket.create",
  "storage.object.write",
  "storage.object.read",
  "storage.signed-url.create",
] as const;

const SHARED_MISC = ["cli.invoke", "schema.introspect", "cli.projectTree.read"] as const;

/**
 * Declared (static) capabilities per Supalite backend (§2.8, §4.4). Levels are drawn
 * from the Ground Truth's per-backend Data API/Auth/RLS accounting (GT §2.3-§2.6) and,
 * for `supalite-sqlite` specifically, from this sprint's own first-hand reproduction
 * against the real published `@supabase/lite@0.9.0` CLI (documented in
 * `docs/TARGETS.md`): the bare `driver = "sqlite"` mode's declarative schema/RLS
 * pipeline (`db diff`, `lite dev`) rejects Postgres-dialect DDL including
 * `CREATE POLICY`/`ENABLE ROW LEVEL SECURITY` ("near SCHEMA: syntax error"), and its
 * Auth system-schema bootstrap does not run through `init`/`start`/`dev`/`db reset`/
 * `db reset --hard` — `auth.signUp` returns `500` with "no such table: auth.users" in
 * every CLI-driven path this sprint exercised. `supalite-sqlite-postgres` (the
 * default backend `lite init` scaffolds) does not share this gap: its translator
 * bootstraps the same internal schema and accepts the same PG-dialect DDL, verified
 * end-to-end (signup, RLS-authorized insert, RLS-denied anon read) in this sprint.
 */
export function declareSupaliteCapabilities(kind: SupaliteTargetKind): TargetCapability[] {
  const list: TargetCapability[] = [];

  for (const id of RESOURCE_OPS) {
    list.push(cap(id, "exact", "GT §2.3, §2.7; reproduced this sprint on all four backends."));
  }

  if (kind === "supalite-sqlite") {
    // Data API works with hand-authored SQLite-native DDL (`supabase/sqlite-migrations`);
    // declarative Postgres-dialect schema application is the gap this sprint reproduced.
    list.push(
      cap(
        "schema.apply.declarative-pg-dialect",
        "unsupported",
        'Reproduced this sprint: `db diff -f`/`lite dev` on driver="sqlite" reject Postgres-dialect ' +
          'declarative schema.sql ("Declarative schema diffs require the sqlite-postgres driver" / ' +
          '"near \\"SCHEMA\\": syntax error"). Imperative SQLite-native migrations under ' +
          "supabase/sqlite-migrations/ do apply (data.* ops above stay exact).",
      ),
    );
    for (const id of AUTH_OPS_EXACT) {
      list.push(
        cap(
          id,
          "unsupported",
          'Reproduced this sprint: auth.signUp against driver="sqlite" returns HTTP 500 ' +
            '("no such table: auth.users") after `init`, `start`, `dev`, `db reset`, and ' +
            "`db reset --hard` — the Auth system-schema bootstrap did not run through any CLI " +
            "path this sprint exercised against this exact published version.",
        ),
      );
    }
    list.push(
      cap(
        "rls.native",
        "unsupported",
        "SQLite has no native RLS; GT §2.5 (PostgreSQL/PGlite only).",
      ),
      cap(
        "rls.emulated.with-check",
        "unsupported",
        "Depends on the declarative CREATE POLICY pipeline, unsupported on this backend per above.",
      ),
    );
    for (const id of STORAGE_OPS_EXPERIMENTAL) {
      list.push(
        cap(
          id,
          "unsupported",
          "Not exercised this sprint on this backend; Storage bootstrap likely shares the same " +
            "system-schema gap as Auth. Recorded unsupported rather than assumed working.",
        ),
      );
    }
    list.push(
      cap(
        "storage.signed-url.redeem",
        "unsupported",
        "Not exercised this sprint on this backend (Storage bootstrap gap above); also see the " +
          "signedUrl/signedURL key-name divergence reproduced on the other three backends.",
      ),
    );
  } else {
    for (const id of AUTH_OPS_EXACT) {
      list.push(cap(id, "exact", "GT §2.4; reproduced this sprint (signup, signin, session)."));
    }
    if (kind === "supalite-sqlite-postgres") {
      list.push(
        cap(
          "rls.native",
          "unsupported",
          "SQLite storage; RLS is emulated via AST rewrite, not native PostgreSQL RLS (GT §2.5).",
        ),
        cap(
          "rls.emulated.with-check",
          "approximation",
          "GT §2.5: SQLite extracts policies from DDL and enforces via AST rewrite + app-level " +
            "WITH CHECK; documented gaps include subqueries in INSERT WITH CHECK, upsert checked " +
            "primarily as insert, FORCE ROW LEVEL SECURITY ignored, RETURNING without a second " +
            "SELECT-policy check. Reproduced this sprint: SELECT/INSERT authorization works end-to-end.",
        ),
      );
    } else {
      // pglite, postgres: native PostgreSQL RLS inside a transaction (GT §2.5).
      list.push(
        cap("rls.native", "exact", "GT §2.5; reproduced this sprint (owner-scoped SELECT/INSERT)."),
        cap(
          "rls.emulated.with-check",
          "unsupported",
          "Not applicable — this backend uses native PostgreSQL RLS, not the SQLite AST-rewrite path.",
        ),
      );
    }
    for (const id of STORAGE_OPS_EXPERIMENTAL) {
      list.push(
        cap(
          id,
          "experimental",
          "GT §2.6: Storage is feature-gated (EXPERIMENTAL_STORAGE) in 0.9.0; stable lacks " +
            "per-object RLS/access-control parity. Requires experimentalFeatures:['storage'].",
        ),
      );
    }
    list.push(
      cap(
        "storage.signed-url.redeem",
        "unsupported",
        "Reproduced this sprint against the real published @supabase/lite@0.9.0: the server's " +
          'POST /storage/v1/object/sign/:bucket/*path response uses JSON key "signedUrl" ' +
          '(lowercase "rl"), but the real Supabase Storage REST API contract — and the official ' +
          "@supabase/storage-js@2.97.0 client bundled in supabase-js, which this sprint verified " +
          'reads response.signedURL (capital "URL") to build StorageClient#createSignedUrl()\'s ' +
          "returned URL — expects the capital-URL key. The mismatch leaves the client-constructed " +
          "URL as `${baseUrl}/storage/v1undefined`; redeeming it returns Supalite's admin-dashboard " +
          "SPA HTML with HTTP 200, not the uploaded object's bytes, and the server's own redemption " +
          "endpoint DOES serve the correct bytes when given the (correctly key-cased) path directly " +
          "— isolating the bug to this one response field name, not to signing or redemption " +
          "generally. See docs/DIVERGENCES.md.",
      ),
    );
  }

  for (const id of SHARED_MISC) {
    list.push(cap(id, "exact", "Driver-mechanical capability, not backend-dependent."));
  }

  list.push(
    cap(
      "execution.controlled-concurrency",
      "unsupported",
      "No `control.barrier` scenario exercised by this driver in this sprint.",
    ),
  );

  return list;
}

import type { TargetCapability } from "@supadiff/spec";

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

const DATA_OPS = [
  "schema.apply",
  "migration.apply",
  "data.seed",
  "data.select",
  "data.insert",
  "data.update",
  "data.delete",
  "data.upsert",
  "http.preflight",
] as const;

const AUTH_OPS = [
  "auth.password.signup",
  "auth.password.signin",
  "auth.session.read",
  "auth.session.refresh",
  "auth.session.revoke",
  "auth.user.update",
] as const;

const STORAGE_OPS = [
  "storage.bucket.create",
  "storage.object.write",
  "storage.object.read",
  "storage.signed-url.create",
  "storage.signed-url.redeem",
] as const;

const SHARED_MISC = ["cli.invoke", "schema.introspect", "cli.projectTree.read"] as const;

/**
 * Declared capabilities for a real hosted Supabase project (§2.8; L13). A hosted project
 * runs the *same* production services as `supabase-local` — PostgREST, GoTrue,
 * `storage-api` over real PostgreSQL — reached through the same pinned
 * `@supabase/supabase-js@2.97.0` client and the shared REST dispatch, so Data / Auth /
 * native RLS / Storage are all `exact`. `probeCapabilities()` downgrades every entry to
 * `unsupported` if the live project health check fails — it never upgrades one.
 *
 * `schema.apply` here runs through the Management API's `database/query` endpoint rather
 * than a direct superuser socket, but the surface it produces (tables in `public`, RLS
 * policies, grants) is identical, so it stays `exact`.
 */
export function declareSupabaseHostedCapabilities(): TargetCapability[] {
  const list: TargetCapability[] = [];
  for (const id of DATA_OPS) {
    list.push(
      cap(id, "exact", "Real hosted PostgREST over real hosted PostgreSQL (Supabase platform)."),
    );
  }
  for (const id of AUTH_OPS) {
    list.push(cap(id, "exact", "Real hosted GoTrue (Supabase platform)."));
  }
  list.push(
    cap(
      "rls.native",
      "exact",
      "Native PostgreSQL row-level security enforced by the hosted PostgREST service.",
    ),
    cap(
      "rls.emulated.with-check",
      "unsupported",
      "Not applicable — a hosted project uses native PostgreSQL RLS, not an AST-rewrite emulation.",
    ),
  );
  for (const id of STORAGE_OPS) {
    list.push(
      cap(
        id,
        "exact",
        "Real hosted supabase/storage-api. createSignedUrl() through the official " +
          "@supabase/storage-js client redeems the uploaded bytes end to end (the platform " +
          "emits the capital-`signedURL` key the client expects).",
      ),
    );
  }
  for (const id of SHARED_MISC) {
    list.push(cap(id, "exact", "Driver-mechanical capability, not service-dependent."));
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

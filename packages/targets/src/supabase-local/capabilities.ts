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
 * Declared capabilities for a `supabase-local` stack (§2.8; L7). Unlike the Supalite
 * family — an embedded re-implementation with documented gaps — `supabase-local` runs the
 * *actual* production service images (PostgREST, GoTrue, `storage-api`) against real
 * PostgreSQL, so Data / Auth / native RLS / Storage are all `exact`. `probeCapabilities()`
 * still downgrades every entry to `unsupported` if the live Kong health check fails —
 * it never upgrades one.
 */
export function declareSupabaseLocalCapabilities(): TargetCapability[] {
  const list: TargetCapability[] = [];
  for (const id of DATA_OPS) {
    list.push(cap(id, "exact", "Real PostgREST v16.1 over real PostgreSQL; observed this sprint."));
  }
  for (const id of AUTH_OPS) {
    list.push(
      cap(id, "exact", "Real GoTrue v2.196.0; signup/signin/session/getUser observed this sprint."),
    );
  }
  list.push(
    cap(
      "rls.native",
      "exact",
      "Native PostgreSQL row-level security enforced by real PostgREST; owner-scoped " +
        "SELECT visible to owner and denied to anon, observed this sprint.",
    ),
    cap(
      "rls.emulated.with-check",
      "unsupported",
      "Not applicable — this target uses native PostgreSQL RLS, not an AST-rewrite emulation.",
    ),
  );
  for (const id of STORAGE_OPS) {
    list.push(
      cap(
        id,
        "exact",
        "Real supabase/storage-api v1.70.3. Observed this sprint: createSignedUrl() through the " +
          "official @supabase/storage-js@2.97.0 client redeems the real uploaded bytes end to end " +
          "(the server emits the capital-`signedURL` key the client expects — the exact opposite " +
          "of Supalite 0.9.0; see docs/DIVERGENCES.md).",
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

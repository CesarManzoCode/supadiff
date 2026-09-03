import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonObject, StableId } from "@supadiff/spec";
import type {
  ActorBinding,
  OperationRequest,
  RawOperationResult,
  SecretVault,
} from "@supadiff/engine/spi";
import { readResourceBytes } from "./resources.js";

/**
 * The Data/Auth/Storage REST dispatch shared by every driver that talks to a
 * Supabase-compatible HTTP surface through the official `@supabase/supabase-js` client.
 *
 * Both the Supalite family (L6/L11) and `supabase-local` (L7) expose the exact same
 * `/auth/v1`, `/rest/v1`, `/storage/v1` contract and are driven by the same pinned
 * `@supabase/supabase-js@2.97.0` client, so the per-operation translation belongs in one
 * place — the drivers differ only in *provisioning* (a `lite start` subprocess vs. a
 * `supabase` CLI Docker stack), identity, capabilities, and schema application, never in
 * how an `auth.signUp` or `data.select` step maps onto a client call. Keeping this single
 * makes the L7 peer comparison a genuine apples-to-apples measurement: any observable
 * difference is the target's, not the driver's.
 */

export interface DataFilter {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is";
  value: unknown;
}
export interface DataOrder {
  field: string;
  ascending?: boolean;
}

interface FilterableQueryBuilder<T extends FilterableQueryBuilder<T>> {
  eq(field: string, value: unknown): T;
  neq(field: string, value: unknown): T;
  gt(field: string, value: unknown): T;
  gte(field: string, value: unknown): T;
  lt(field: string, value: unknown): T;
  lte(field: string, value: unknown): T;
  in(field: string, value: unknown[]): T;
  is(field: string, value: null | boolean): T;
  order(field: string, opts: { ascending: boolean }): T;
}

export function applyFilters<T extends FilterableQueryBuilder<T>>(
  qb: T,
  filters: DataFilter[] | undefined,
): T {
  for (const f of filters ?? []) {
    switch (f.op) {
      case "eq":
        qb = qb.eq(f.field, f.value);
        break;
      case "neq":
        qb = qb.neq(f.field, f.value);
        break;
      case "gt":
        qb = qb.gt(f.field, f.value);
        break;
      case "gte":
        qb = qb.gte(f.field, f.value);
        break;
      case "lt":
        qb = qb.lt(f.field, f.value);
        break;
      case "lte":
        qb = qb.lte(f.field, f.value);
        break;
      case "in":
        qb = qb.in(f.field, f.value as unknown[]);
        break;
      case "is":
        qb = qb.is(f.field, f.value as null | boolean);
        break;
    }
  }
  return qb;
}

export function applyOrder<T extends FilterableQueryBuilder<T>>(
  qb: T,
  order: DataOrder[] | undefined,
): T {
  for (const o of order ?? []) qb = qb.order(o.field, { ascending: o.ascending ?? true });
  return qb;
}

export function dataResultToRaw(res: {
  data: unknown;
  error: { message: string; code?: string } | null;
  status: number;
}): RawOperationResult {
  return {
    category: res.error ? "application-error" : "success",
    status: res.status,
    responseBody: {
      status: res.status,
      rows: res.error ? null : Array.isArray(res.data) ? res.data : res.data ? [res.data] : [],
      ...(res.error ? { error: { message: res.error.message, code: res.error.code ?? null } } : {}),
    },
    durationMs: 0,
  };
}

export function authResultToRaw(res: {
  data: { user: unknown; session: unknown } | null;
  error: { message: string; status?: number } | null;
}): RawOperationResult {
  const status = res.error ? (res.error.status ?? 400) : 200;
  const user = res.data?.user as { id?: string; email?: string } | null | undefined;
  const session = res.data?.session as
    | { access_token?: string; refresh_token?: string }
    | null
    | undefined;
  return {
    category: res.error ? "application-error" : "success",
    status,
    responseBody: {
      status,
      user: user ? { id: user.id ?? null, email: user.email ?? null } : null,
      ...(session
        ? { session: { access_token: session.access_token, refresh_token: session.refresh_token } }
        : {}),
      ...(res.error ? { error: { message: res.error.message } } : {}),
    },
    durationMs: 0,
  };
}

export interface RestDispatchContext {
  /** Client whose auth context matches the step's actor binding (anon / authenticated / service_role). */
  clientForActor(actor: ActorBinding | undefined): SupabaseClient;
  /** Unconditionally service-role client, for `data.seed` and ownership metadata readback. */
  serviceClient(): SupabaseClient;
  vault: SecretVault;
  resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>;
}

/**
 * Dispatches one already-`$secretRef`-revealed operation. Returns `null` for operations
 * this shared layer does not own (`schema.apply`, `migration.apply`, `data.seed`) — the
 * driver handles those itself because they are provisioning-specific.
 */
export async function dispatchRestOperation(
  request: OperationRequest,
  revealed: JsonObject,
  ctx: RestDispatchContext,
): Promise<RawOperationResult | null> {
  const { id } = request.operation;
  if (id === "schema.apply" || id === "migration.apply" || id === "data.seed") return null;

  const client = ctx.clientForActor(request.actor);
  const vault = ctx.vault;

  switch (id) {
    case "auth.signUp": {
      const res = await client.auth.signUp({
        email: revealed["email"] as string,
        password: revealed["password"] as string,
        options: revealed["metadata"] ? { data: revealed["metadata"] as object } : undefined,
      });
      if (!res.error && res.data.session && request.actor) {
        request.actor.role = "authenticated";
        request.actor.state = "active";
        request.actor.subject = res.data.user?.id;
        request.actor.session = vault.put("session", res.data.session.access_token) as never;
        request.actor.refreshToken = vault.put(
          "refresh-token",
          res.data.session.refresh_token,
        ) as never;
      }
      return authResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, status: res.error.status } : null,
      });
    }
    case "auth.signInWithPassword": {
      const res = await client.auth.signInWithPassword({
        email: revealed["email"] as string,
        password: revealed["password"] as string,
      });
      if (!res.error && request.actor) {
        request.actor.role = "authenticated";
        request.actor.state = "active";
        request.actor.subject = res.data.user?.id;
        request.actor.session = vault.put("session", res.data.session.access_token) as never;
        request.actor.refreshToken = vault.put(
          "refresh-token",
          res.data.session.refresh_token,
        ) as never;
      }
      return authResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, status: res.error.status } : null,
      });
    }
    case "auth.refreshSession": {
      const refreshToken = revealed["refreshToken"] as string;
      const res = await client.auth.refreshSession({ refresh_token: refreshToken });
      if (!res.error && request.actor && res.data.session) {
        request.actor.session = vault.put("session", res.data.session.access_token) as never;
        request.actor.refreshToken = vault.put(
          "refresh-token",
          res.data.session.refresh_token,
        ) as never;
      }
      return authResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, status: res.error.status } : null,
      });
    }
    case "auth.getUser": {
      const res = await client.auth.getUser();
      return authResultToRaw({
        data: res.data.user
          ? { user: res.data.user, session: null }
          : { user: null, session: null },
        error: res.error ? { message: res.error.message, status: res.error.status } : null,
      });
    }
    case "observe.authSession": {
      const res = await client.auth.getUser();
      const user = res.error ? undefined : res.data.user;
      return {
        category: "success",
        status: 200,
        responseBody: {
          active: !!user,
          subject: user?.id ?? null,
          role: user ? ((user.role as string | undefined) ?? "authenticated") : "anon",
        },
        durationMs: 0,
      };
    }
    case "auth.updateUser": {
      const res = await client.auth.updateUser(revealed as never);
      return authResultToRaw({
        data: { user: res.data?.user ?? null, session: null },
        error: res.error ? { message: res.error.message, status: res.error.status } : null,
      });
    }
    case "auth.signOut": {
      const res = await client.auth.signOut();
      if (!res.error && request.actor) request.actor.state = "revoked";
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 204,
        responseBody: { status: res.error ? 400 : 204 },
        durationMs: 0,
      };
    }
    case "data.select": {
      let qb = client.from(revealed["table"] as string).select("*", { count: "exact" });
      qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
      qb = applyOrder(qb, revealed["order"] as DataOrder[] | undefined);
      if (revealed["limit"] !== undefined) qb = qb.limit(revealed["limit"] as number);
      const res = await qb;
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "observe.dataReadback": {
      let qb = client.from(revealed["table"] as string).select("*");
      qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
      qb = applyOrder(qb, revealed["order"] as DataOrder[] | undefined);
      const res = await qb;
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "data.insert": {
      const res = await client
        .from(revealed["table"] as string)
        .insert(revealed["rows"] as JsonObject[])
        .select();
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "data.update": {
      let qb = client.from(revealed["table"] as string).update(revealed["patch"] as JsonObject);
      qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
      const res = await qb.select();
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "data.upsert": {
      const res = await client
        .from(revealed["table"] as string)
        .upsert(revealed["rows"] as JsonObject[], {
          onConflict: revealed["onConflict"] as string | undefined,
        })
        .select();
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "data.delete": {
      let qb = client.from(revealed["table"] as string).delete();
      qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
      const res = await qb.select();
      return dataResultToRaw({
        data: res.data,
        error: res.error ? { message: res.error.message, code: res.error.code } : null,
        status: res.status,
      });
    }
    case "storage.createBucket": {
      const res = await client.storage.createBucket(revealed["bucket"] as string, {
        public: (revealed["public"] as boolean | undefined) ?? false,
      });
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: { status: res.error ? 400 : 200, name: res.data?.name ?? null },
        durationMs: 0,
      };
    }
    case "storage.upload": {
      const resourceId = revealed["resourceId"] as StableId;
      const resource = ctx.resources.get(resourceId);
      if (!resource) {
        return {
          category: "harness-failure",
          harnessFailureReason: "driver-invariant",
          durationMs: 0,
        };
      }
      const bytes = await readResourceBytes(resource.source);
      const res = await client.storage
        .from(revealed["bucket"] as string)
        .upload(revealed["path"] as string, bytes, {
          upsert: true,
          contentType: "application/octet-stream",
        });
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: {
          status: res.error ? 400 : 200,
          path: res.data?.path ?? null,
          bytesDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          contentLength: bytes.length,
          owner: null,
        },
        durationMs: 0,
      };
    }
    case "storage.download": {
      const res = await client.storage
        .from(revealed["bucket"] as string)
        .download(revealed["path"] as string);
      if (res.error || !res.data) {
        return {
          category: "application-error",
          status: 404,
          responseBody: { status: 404, bytesDigest: null, contentLength: null },
          durationMs: 0,
        };
      }
      const buf = Buffer.from(await res.data.arrayBuffer());
      return {
        category: "success",
        status: 200,
        responseBody: {
          status: 200,
          bytesDigest: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
          contentLength: buf.length,
        },
        durationMs: 0,
      };
    }
    case "storage.list": {
      const res = await client.storage
        .from(revealed["bucket"] as string)
        .list((revealed["prefix"] as string | undefined) ?? "");
      const entries = (res.data ?? [])
        .map((e) => ({ name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: { status: res.error ? 400 : 200, entries },
        durationMs: 0,
      };
    }
    case "storage.remove": {
      const res = await client.storage
        .from(revealed["bucket"] as string)
        .remove(revealed["paths"] as string[]);
      const removed = (res.data ?? []).map((e) => e.name).sort();
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: { status: res.error ? 400 : 200, removed },
        durationMs: 0,
      };
    }
    case "storage.move": {
      const res = await client.storage
        .from(revealed["bucket"] as string)
        .move(revealed["from"] as string, revealed["to"] as string);
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: { status: res.error ? 400 : 200 },
        durationMs: 0,
      };
    }
    case "storage.copy": {
      const bucket = revealed["bucket"] as string;
      const res = await client.storage
        .from(bucket)
        .copy(revealed["from"] as string, revealed["to"] as string);
      let bytesDigest: string | null = null;
      if (!res.error) {
        const dl = await client.storage.from(bucket).download(revealed["to"] as string);
        if (dl.data) {
          const buf = Buffer.from(await dl.data.arrayBuffer());
          bytesDigest = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
        }
      }
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: { status: res.error ? 400 : 200, bytesDigest },
        durationMs: 0,
      };
    }
    case "storage.createSignedUrl": {
      const bucket = revealed["bucket"] as string;
      const objectPath = revealed["path"] as string;
      const expiresInSeconds = revealed["expiresInSeconds"] as number;
      const res = await client.storage.from(bucket).createSignedUrl(objectPath, expiresInSeconds);
      return {
        category: res.error ? "application-error" : "success",
        status: res.error ? 400 : 200,
        responseBody: {
          path: res.error ? null : objectPath,
          expiresAt: res.error
            ? null
            : new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
          // The official @supabase/storage-js client reads the server's `signedURL`
          // (capital) key to build this value. When a server instead emits `signedUrl`
          // (Supalite 0.9.0) the client leaves it undefined — this field then being
          // absent is itself the observable divergence L7 surfaces (docs/DIVERGENCES.md).
          ...(res.data?.signedUrl ? { signedUrl: res.data.signedUrl } : {}),
        },
        durationMs: 0,
      };
    }
    case "storage.redeemUrl": {
      const url = revealed["signedUrlHandle"] as string;
      try {
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          category: res.ok ? "success" : "application-error",
          status: res.status,
          responseBody: {
            status: res.status,
            bytesDigest: res.ok ? `sha256:${createHash("sha256").update(buf).digest("hex")}` : null,
            contentLength: res.ok ? buf.length : null,
          },
          durationMs: 0,
        };
      } catch {
        return { category: "harness-failure", harnessFailureReason: "disconnect", durationMs: 0 };
      }
    }
    case "observe.storageObject": {
      const bucket = revealed["bucket"] as string;
      const objectPath = revealed["path"] as string;
      const lastSlash = objectPath.lastIndexOf("/");
      const dir = lastSlash >= 0 ? objectPath.slice(0, lastSlash) : "";
      const base = lastSlash >= 0 ? objectPath.slice(lastSlash + 1) : objectPath;
      const listRes = await client.storage.from(bucket).list(dir, { search: base });
      const row = listRes.data?.find((e) => e.name === base || e.name === objectPath) as
        | { owner?: string | null; owner_id?: string | null }
        | undefined;
      const dl = await client.storage.from(bucket).download(objectPath);
      let bytesDigest: string | null = null;
      let contentLength: number | null = null;
      if (dl.data) {
        const buf = Buffer.from(await dl.data.arrayBuffer());
        bytesDigest = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
        contentLength = buf.length;
      }
      return {
        category: "success",
        status: 200,
        responseBody: { owner: row?.owner_id ?? row?.owner ?? null, bytesDigest, contentLength },
        durationMs: 0,
      };
    }
    case "assert.invariant": {
      return {
        category: "success",
        status: 200,
        responseBody: { satisfied: true, detail: null },
        durationMs: 0,
      };
    }
    default:
      return {
        category: "harness-failure",
        harnessFailureReason: "driver-invariant",
        durationMs: 0,
      };
  }
}

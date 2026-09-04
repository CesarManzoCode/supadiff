import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpManagementClient, ManagementApiError, RequestBudget } from "../../src/index.js";

/**
 * L13 Architecture-Contract management-plane fault coverage for `HttpManagementClient`.
 *
 * Deterministic, hermetic (global `fetch` is stubbed — no real hosted project, no
 * credentials, no network) and exhaustive over the distinct failure classes the contract
 * requires: HTTP 429 / rate-limit, HTTP 5xx, timeout / network failure, and a malformed or
 * otherwise unexpected Management API response. Every class must surface as a typed
 * `ManagementApiError`, with no hidden retry (the current client contract has none), no
 * secret material in the message, and no request spent beyond the one that failed.
 */

const TOKEN = "sbp_faketoken_never_real_000000000000";
const BASE_URL = "https://api.supabase.example/invalid";
const REF = "fakeprojref000000000";

function makeClient(budgetMax = 25): { client: HttpManagementClient; budget: RequestBudget } {
  const budget = new RequestBudget(budgetMax);
  const client = new HttpManagementClient({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    budget,
    timeoutMs: 5_000,
  });
  return { client, budget };
}

/** A `fetch` double returning a fixed HTTP response. */
function respondWith(status: number, body: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => Promise.resolve(body),
    } as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HttpManagementClient — management-plane faults (no network, no credentials)", () => {
  it("HTTP 429 rate-limit → typed ManagementApiError(status=429), no retry, one request spent", async () => {
    const fetchMock = respondWith(429, "rate limit exceeded");
    vi.stubGlobal("fetch", fetchMock);
    const { client, budget } = makeClient();

    const err = await client.runQuery(REF, "select 1").then(
      () => {
        throw new Error("expected a ManagementApiError");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).status).toBe(429);
    expect((err as ManagementApiError).message).not.toContain(TOKEN);
    // No hidden retry: exactly one fetch, exactly one budgeted request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
  });

  it("HTTP 5xx → typed ManagementApiError(status=503), no retry, no further side effect", async () => {
    const fetchMock = respondWith(503, "upstream unavailable");
    vi.stubGlobal("fetch", fetchMock);
    const { client, budget } = makeClient();

    const err = await client.getProject(REF).then(
      () => {
        throw new Error("expected a ManagementApiError");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
  });

  it("timeout / network failure → typed ManagementApiError(status=0, 'unreachable'), no secret leak", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, budget } = makeClient();

    const err = await client.runQuery(REF, "select 1").then(
      () => {
        throw new Error("expected a ManagementApiError");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).status).toBe(0);
    expect((err as ManagementApiError).message).toContain("unreachable");
    expect((err as ManagementApiError).message).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(1);
  });

  it("malformed response — 200 with a non-JSON body → typed ManagementApiError, no partial value returned", async () => {
    const fetchMock = respondWith(200, "<html>gateway</html>");
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    const err = await client.getProject(REF).then(
      () => {
        throw new Error("expected a ManagementApiError");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).message).toContain("not valid JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unexpected response shape — 200 JSON missing the required keys → typed ManagementApiError", async () => {
    // Well-formed JSON, but not the documented api-keys payload (no service_role key).
    const fetchMock = respondWith(200, JSON.stringify([{ name: "anon", api_key: "x" }]));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    const err = await client.getApiKeys(REF).then(
      () => {
        throw new Error("expected a ManagementApiError");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).message).toContain("anon and a service_role key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the per-run request budget still aborts a fault-heavy run rather than spending unboundedly", async () => {
    const fetchMock = respondWith(500, "boom");
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient(2);

    await expect(client.getProject(REF)).rejects.toBeInstanceOf(ManagementApiError);
    await expect(client.getProject(REF)).rejects.toBeInstanceOf(ManagementApiError);
    // Third request exceeds the cap: the budget aborts before the fetch is issued.
    await expect(client.getProject(REF)).rejects.toThrow(/per-run request cap/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

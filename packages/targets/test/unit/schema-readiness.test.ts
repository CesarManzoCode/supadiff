import { describe, expect, it, vi } from "vitest";
import {
  awaitSchemaReadiness,
  HostedSchemaReadinessError,
  type SchemaReadinessProbeResult,
} from "../../src/index.js";

/**
 * Issue #6: hosted `schema.apply` must not return success while PostgREST's schema-cache
 * reload is still in flight. `awaitSchemaReadiness` is the extracted, hermetic decision
 * logic — no real hosted project, no network — that the driver's Data-API probe plugs into.
 */

function noSleep(): Promise<void> {
  return Promise.resolve();
}

describe("awaitSchemaReadiness", () => {
  it("resolves immediately when the Data API already sees the relation", async () => {
    const probe = vi.fn(async (): Promise<SchemaReadinessProbeResult> => ({ status: "ready" }));
    await awaitSchemaReadiness({
      tables: ["todos"],
      probe,
      maxAttempts: 5,
      delayMs: 10,
      sleep: noSleep,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries the PGRST205 schema-cache-not-ready condition and then succeeds", async () => {
    let calls = 0;
    const probe = vi.fn(async (): Promise<SchemaReadinessProbeResult> => {
      calls += 1;
      return calls < 3 ? { status: "not-ready" } : { status: "ready" };
    });
    const sleep = vi.fn(noSleep);
    await awaitSchemaReadiness({
      tables: ["todos"],
      probe,
      maxAttempts: 5,
      delayMs: 10,
      sleep,
    });
    expect(probe).toHaveBeenCalledTimes(3);
    // A delay only ever separates two attempts on the same table, never follows success.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry an unrelated Data API error — it surfaces immediately", async () => {
    const authError = new Error("Data API probe failed: invalid API key");
    const probe = vi.fn(
      async (): Promise<SchemaReadinessProbeResult> => ({
        status: "error",
        error: authError,
      }),
    );
    const sleep = vi.fn(noSleep);
    await expect(
      awaitSchemaReadiness({ tables: ["todos"], probe, maxAttempts: 5, delayMs: 10, sleep }),
    ).rejects.toBe(authError);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed with a bounded HostedSchemaReadinessError when PGRST205 never resolves", async () => {
    const probe = vi.fn(async (): Promise<SchemaReadinessProbeResult> => ({ status: "not-ready" }));
    const sleep = vi.fn(noSleep);
    const err = await awaitSchemaReadiness({
      tables: ["todos"],
      probe,
      maxAttempts: 4,
      delayMs: 10,
      sleep,
    }).then(
      () => {
        throw new Error("expected a HostedSchemaReadinessError");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostedSchemaReadinessError);
    expect((err as HostedSchemaReadinessError).table).toBe("todos");
    expect((err as HostedSchemaReadinessError).attempts).toBe(4);
    // Bounded: exactly `maxAttempts` probes, never more.
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("checks each table independently, in order", async () => {
    const seen: string[] = [];
    const probe = vi.fn(async (table: string): Promise<SchemaReadinessProbeResult> => {
      seen.push(table);
      return { status: "ready" };
    });
    await awaitSchemaReadiness({
      tables: ["a", "b"],
      probe,
      maxAttempts: 5,
      delayMs: 10,
      sleep: noSleep,
    });
    expect(seen).toEqual(["a", "b"]);
  });
});

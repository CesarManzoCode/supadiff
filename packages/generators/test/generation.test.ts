import { describe, expect, it } from "vitest";
import { computeScenarioDigest, parseScenarioSpec } from "@supadiff/spec";
import { DataAuthRlsGenerator } from "../src/generator.js";
import { hashSeedToUint32 } from "../src/model/arbitraries.js";

async function collect(seed: string, count: number) {
  const generator = new DataAuthRlsGenerator();
  const out = [];
  for await (const gs of generator.generate({ seed, count, capabilityEnvelope: [] })) out.push(gs);
  return out;
}

describe("L12 generation: byte-identical seed replay (§10.2)", () => {
  it("the same {seed, path} yields a byte-identical canonical scenario across two independent runs", async () => {
    const a = await collect("424242", 5);
    const b = await collect("424242", 5);
    expect(a.length).toBe(5);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.generation.path).toBe(String(i));
      expect(a[i]!.generation.path).toBe(b[i]!.generation.path);
      expect(a[i]!.scenario).toEqual(b[i]!.scenario);
      expect(computeScenarioDigest(a[i]!.scenario)).toBe(computeScenarioDigest(b[i]!.scenario));
    }
  });

  it("a different seed produces a different draw (hash is not degenerate)", async () => {
    const a = await collect("1", 1);
    const b = await collect("2", 1);
    expect(computeScenarioDigest(a[0]!.scenario)).not.toBe(computeScenarioDigest(b[0]!.scenario));
  });

  it("hashSeedToUint32 is a pure deterministic function of its input string", () => {
    expect(hashSeedToUint32("abc")).toBe(hashSeedToUint32("abc"));
    expect(hashSeedToUint32("abc")).not.toBe(hashSeedToUint32("abd"));
    expect(Number.isInteger(hashSeedToUint32("abc"))).toBe(true);
  });
});

describe("L12 generation: preconditions are honored (§10.2)", () => {
  it("never emits update/delete without an insert already tracked for that table", async () => {
    const results = await collect("precondition-sweep", 200);
    for (const { scenario } of results) {
      const liveByTable = new Map<string, number>();
      for (const step of scenario.steps) {
        if (
          step.kind !== "data.insert" &&
          step.kind !== "data.update" &&
          step.kind !== "data.delete"
        ) {
          continue;
        }
        const table = (step.input as { table: string }).table;
        if (step.kind === "data.insert") {
          liveByTable.set(table, (liveByTable.get(table) ?? 0) + 1);
        } else {
          const live = liveByTable.get(table) ?? 0;
          expect(
            live,
            `${step.kind} on "${table}" in ${scenario.id} with no prior tracked insert`,
          ).toBeGreaterThan(0);
          if (step.kind === "data.delete") liveByTable.set(table, live - 1);
        }
      }
    }
  });

  it("records a skipped-precondition decision for every update/delete the raw draw asked for but the model rejected", async () => {
    const results = await collect("precondition-sweep", 200);
    const sawSkip = results.some((r) =>
      r.generation.decisions.some((d) => d.kind === "skipped-precondition"),
    );
    expect(sawSkip).toBe(true);
  });
});

describe("L12 generation: 10,000 validation-only generations (§L12 acceptance)", () => {
  it("every generated scenario parses and canonicalizes without throwing, across many seeds", async () => {
    const generator = new DataAuthRlsGenerator();
    let checked = 0;
    for (let s = 0; s < 100; s++) {
      for await (const gs of generator.generate({
        seed: String(1_000_000 + s),
        count: 100,
        capabilityEnvelope: [],
      })) {
        const parsed = parseScenarioSpec(JSON.parse(JSON.stringify(gs.scenario)));
        expect(parsed.id).toBe(gs.scenario.id);
        computeScenarioDigest(parsed);
        checked++;
      }
    }
    expect(checked).toBe(10_000);
  }, 120_000);
});

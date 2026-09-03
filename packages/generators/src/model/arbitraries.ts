/**
 * The one module in this package allowed to import `fast-check` (Architecture Contract
 * §10.1: SupaDiff owns the domain model, the pinned property-testing library supplies
 * "seeded pseudorandom choice; primitive strings, numbers, arrays, and recursive value
 * generation; reproducible generation paths; primitive value shrinking"). Every other
 * module in this package works only with the plain `GenerationPlan` values this file
 * produces, never with a `fast-check` `Arbitrary` — keeping the adapter boundary real,
 * not just documented.
 */
import * as fc from "fast-check";
import type { GenerationBudget } from "../types.js";
import type {
  ColumnPlan,
  ColumnType,
  DataOpKind,
  GenerationPlan,
  OpDraw,
  TablePlan,
} from "./types.js";

const TABLE_NAME_POOL = ["notes", "tasks", "items", "events", "records"] as const;
const COLUMN_NAME_POOL = [
  "title",
  "body",
  "priority",
  "done",
  "amount",
  "note",
  "category",
  "quantity",
] as const;
const COLUMN_TYPES: readonly ColumnType[] = ["text", "integer", "boolean", "timestamptz"];
const DATA_OP_KINDS: readonly DataOpKind[] = [
  "insert",
  "selectOwner",
  "selectAnon",
  "update",
  "delete",
];

export const RESOLVED_BUDGET_DEFAULTS: Required<GenerationBudget> = {
  maxTables: 2,
  maxColumnsPerTable: 4,
  maxOperations: 8,
};

function columnsArbitrary(maxColumns: number): fc.Arbitrary<ColumnPlan[]> {
  return fc
    .uniqueArray(fc.constantFrom(...COLUMN_NAME_POOL), { minLength: 2, maxLength: maxColumns })
    .chain((names) =>
      fc
        .array(fc.constantFrom(...COLUMN_TYPES), {
          minLength: names.length,
          maxLength: names.length,
        })
        .map((types): ColumnPlan[] => names.map((name, i) => ({ name, type: types[i]! }))),
    );
}

function tablesArbitrary(budget: Required<GenerationBudget>): fc.Arbitrary<TablePlan[]> {
  return fc
    .uniqueArray(fc.constantFrom(...TABLE_NAME_POOL), { minLength: 1, maxLength: budget.maxTables })
    .chain((names) =>
      fc
        .tuple(...names.map(() => columnsArbitrary(budget.maxColumnsPerTable)))
        .map((columnSets): TablePlan[] =>
          names.map((name, i) => ({ name, columns: columnSets[i]! })),
        ),
    );
}

function opsArbitrary(tableCount: number, maxOperations: number): fc.Arbitrary<OpDraw[]> {
  return fc.array(
    fc.record({
      kind: fc.constantFrom(...DATA_OP_KINDS),
      tableIndex: fc.integer({ min: 0, max: tableCount - 1 }),
      valueSeed: fc.nat({ max: 10_000 }),
    }),
    { minLength: 3, maxLength: Math.max(3, maxOperations) },
  );
}

function generationPlanArbitrary(budget: Required<GenerationBudget>): fc.Arbitrary<GenerationPlan> {
  return tablesArbitrary(budget).chain((tables) =>
    fc
      .record({
        ownerEmailLocal: fc.stringMatching(/^[a-z][a-z0-9]{3,9}$/),
        ops: opsArbitrary(tables.length, budget.maxOperations),
      })
      .map(({ ownerEmailLocal, ops }): GenerationPlan => ({ tables, ownerEmailLocal, ops })),
  );
}

/** Deterministic string -> unsigned 32-bit hash (FNV-1a), so any uint64-decimal `ScenarioSpec.seed` maps onto `fast-check`'s numeric `Parameters.seed`. */
export function hashSeedToUint32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Draws `count` `GenerationPlan`s deterministically from `seed`. Two calls with the
 * same `seed`, `count`, and `budget` under the same generator version always produce
 * byte-identical plans (§10.2) -- `fast-check`'s own seeded-sample determinism, which
 * this function is the only caller of.
 */
export function sampleGenerationPlans(
  seed: string,
  count: number,
  budget: Required<GenerationBudget>,
): GenerationPlan[] {
  return fc.sample(generationPlanArbitrary(budget), {
    seed: hashSeedToUint32(seed),
    numRuns: count,
  });
}

/**
 * Domain-specific model state (Architecture Contract §10.1, §10.2): coherent
 * Supabase-facing schemas, actor/credential lifecycles, RLS policy templates with
 * known actor/row relationships, and operation sequences whose refs and side effects
 * are valid. This module owns no randomness and never imports `fast-check` — it is
 * the "SupaDiff owns domain-specific generation" half of the §10.1 responsibility
 * split, consuming already-drawn raw values from `../arbitraries.js`.
 */

export type ColumnType = "text" | "integer" | "boolean" | "timestamptz";

export interface ColumnPlan {
  name: string;
  type: ColumnType;
}

/** A table as drawn by the arbitrary, before precondition/postcondition interpretation. */
export interface TablePlan {
  name: string;
  columns: ColumnPlan[];
}

export type DataOpKind = "insert" | "selectOwner" | "selectAnon" | "update" | "delete";

/** One raw operation draw: a requested kind, which table index it targets, and a
 *  seed for deterministic row-value derivation (used only by `insert`). */
export interface OpDraw {
  kind: DataOpKind;
  tableIndex: number;
  valueSeed: number;
}

/** The full raw draw for one `GeneratedScenario`, before interpretation. */
export interface GenerationPlan {
  tables: TablePlan[];
  ownerEmailLocal: string;
  ops: OpDraw[];
}

/** Per-table row-tracking state the interpreter advances as it walks `ops`. */
export interface TableRuntimeState {
  table: TablePlan;
  /** Number of not-yet-deleted rows this scenario has inserted for this table so far. */
  liveRowCount: number;
}

import type { JsonObject } from "@supadiff/spec";
import type { TablePlan } from "./types.js";

/**
 * Renders a generated table plan to Postgres-dialect DDL with an owner-scoped RLS
 * policy pair, the same shape this sprint's hand-authored L6/L11 canonical scenarios
 * use and that `supalite-sqlite-postgres`/`supalite-pglite`/`supalite-postgres` all
 * accept declaratively (`supalite-sqlite` lacks the declarative PG-dialect pipeline
 * entirely — see `packages/targets/src/supalite/capabilities.ts` — so generated
 * scenarios are not expected to resolve there).
 */
export function renderSchemaSql(tables: readonly TablePlan[]): string {
  const parts: string[] = [];
  for (const table of tables) {
    const columnLines = table.columns.map((c) => `  ${c.name} ${sqlType(c.type)}`).join(",\n");
    parts.push(
      [
        `create table public.${table.name} (`,
        `  id uuid primary key default gen_random_uuid(),`,
        `  owner_id uuid not null,`,
        columnLines ? `${columnLines},` : undefined,
        `  created_at timestamptz not null default now()`,
        `);`,
        ``,
        `alter table public.${table.name} enable row level security;`,
        ``,
        `create policy "owner can select own ${table.name}" on public.${table.name}`,
        `  for select using (auth.uid() = owner_id);`,
        ``,
        `create policy "owner can insert own ${table.name}" on public.${table.name}`,
        `  for insert with check (auth.uid() = owner_id);`,
        ``,
        `create policy "owner can update own ${table.name}" on public.${table.name}`,
        `  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);`,
        ``,
        `create policy "owner can delete own ${table.name}" on public.${table.name}`,
        `  for delete using (auth.uid() = owner_id);`,
        ``,
      ]
        .filter((l): l is string => l !== undefined)
        .join("\n"),
    );
  }
  return parts.join("\n");
}

function sqlType(type: TablePlan["columns"][number]["type"]): string {
  switch (type) {
    case "text":
      return "text";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "timestamptz":
      return "timestamptz";
  }
}

/** Deterministic, seed-derived column values for one generated row (structured seed data, §10.1). */
export function renderRowValues(table: TablePlan, valueSeed: number): JsonObject {
  const row: JsonObject = {};
  table.columns.forEach((c, i) => {
    const n = valueSeed + i;
    switch (c.type) {
      case "text":
        row[c.name] = `gen-${table.name}-${c.name}-${n}`;
        break;
      case "integer":
        row[c.name] = n;
        break;
      case "boolean":
        row[c.name] = n % 2 === 0;
        break;
      case "timestamptz":
        row[c.name] = new Date(Date.UTC(2026, 0, 1, 0, 0, n % 60)).toISOString();
        break;
    }
  });
  return row;
}

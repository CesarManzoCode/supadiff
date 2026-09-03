import { createHash } from "node:crypto";
import type {
  ActorSpec,
  CapabilityRequirement,
  ResourceDeclaration,
  ScenarioProvenance,
  ScenarioSpec,
  StableId,
  StepSpec,
} from "@supadiff/spec";
import type { GenerationDecision } from "../types.js";
import { renderRowValues, renderSchemaSql } from "./sql.js";
import type { GenerationPlan, TableRuntimeState } from "./types.js";

function sha256OfUtf8(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function inlineResource(id: StableId, mediaType: string, value: string): ResourceDeclaration {
  return {
    id,
    mediaType,
    sha256: sha256OfUtf8(value),
    length: Buffer.byteLength(value, "utf8"),
    source: { kind: "inline", value },
    sensitivity: "generated-fixture",
  };
}

export interface InterpretedScenario {
  resources: ResourceDeclaration[];
  actors: ActorSpec[];
  steps: StepSpec[];
  decisions: GenerationDecision[];
  requirements: CapabilityRequirement[];
}

/**
 * Walks a raw `GenerationPlan` and interprets it into valid scenario steps, honoring
 * each operation's precondition against a running per-table row model (§10.2: "An
 * operation is emitted only when its preconditions are satisfied"). This is pure
 * domain logic -- no randomness, no `fast-check` -- so the same plan always interprets
 * to the byte-identical step sequence.
 */
export function interpretPlan(plan: GenerationPlan): InterpretedScenario {
  const schemaSql = renderSchemaSql(plan.tables);
  const schemaResource = inlineResource("schema.generated", "application/sql", schemaSql);

  const owner: ActorSpec = {
    id: "actor.owner",
    kind: "user",
    credentialSource: { kind: "generated", recipe: { id: "fixture.password", version: "1" } },
    initialContext: "anonymous",
    sessionPolicy: "fresh-per-target",
  };

  const decisions: GenerationDecision[] = [];
  const steps: StepSpec[] = [
    {
      id: "step-schema",
      kind: "schema.apply",
      phase: "bootstrap",
      input: { resourceId: schemaResource.id, mode: "authoritative" },
    },
    {
      id: "step-signup",
      kind: "auth.signUp",
      phase: "bootstrap",
      actor: "actor.owner",
      dependsOn: ["step-schema"],
      input: {
        email: `${plan.ownerEmailLocal}@example.test`,
        password: { $secretRef: "fixture.password" },
      },
      capture: [
        {
          name: "owner-id",
          from: { kind: "json-pointer", pointer: "/user/id" },
          valueType: "identifier",
          sensitivity: "identifier",
          required: true,
        },
      ],
    },
  ];
  decisions.push({
    kind: "emitted",
    operation: "schema.apply",
    reason: "always emitted once per scenario",
  });
  decisions.push({
    kind: "emitted",
    operation: "auth.signUp",
    reason: "always emitted once per scenario",
  });

  const runtime: TableRuntimeState[] = plan.tables.map((table) => ({ table, liveRowCount: 0 }));
  const lastRowCapture = new Map<number, StableId>();
  const lastStepForTable = new Map<number, StableId>();

  plan.ops.forEach((op, i) => {
    const table = runtime[op.tableIndex]!;
    const stepId = `step-op-${i}`;
    const dependsOn = [lastStepForTable.get(op.tableIndex) ?? "step-signup"];

    if (op.kind === "insert") {
      const rowValues = renderRowValues(table.table, op.valueSeed);
      steps.push({
        id: stepId,
        kind: "data.insert",
        phase: "exercise",
        actor: "actor.owner",
        dependsOn,
        input: {
          table: table.table.name,
          rows: [{ ...rowValues, owner_id: { $ref: "capture:owner-id" } }],
          returning: true,
        },
        capture: [
          {
            name: `row-${table.table.name}-${i}`,
            from: { kind: "json-pointer", pointer: "/rows/0/id" },
            valueType: "identifier",
            sensitivity: "identifier",
            required: true,
          },
        ],
      });
      table.liveRowCount += 1;
      lastRowCapture.set(op.tableIndex, `row-${table.table.name}-${i}`);
      lastStepForTable.set(op.tableIndex, stepId);
      decisions.push({ kind: "emitted", operation: "data.insert", reason: "always valid", stepId });
      return;
    }

    if (op.kind === "selectAnon") {
      steps.push({
        id: stepId,
        kind: "data.select",
        phase: "exercise",
        dependsOn,
        input: { table: table.table.name, filters: [] },
      });
      lastStepForTable.set(op.tableIndex, stepId);
      decisions.push({
        kind: "emitted",
        operation: "data.select(anon)",
        reason: "always valid, including against an empty table",
        stepId,
      });
      return;
    }

    if (op.kind === "selectOwner") {
      steps.push({
        id: stepId,
        kind: "data.select",
        phase: "exercise",
        actor: "actor.owner",
        dependsOn,
        input: {
          table: table.table.name,
          filters: [{ field: "owner_id", op: "eq", value: { $ref: "capture:owner-id" } }],
        },
      });
      lastStepForTable.set(op.tableIndex, stepId);
      decisions.push({
        kind: "emitted",
        operation: "data.select(owner)",
        reason: "always valid, including against zero owned rows",
        stepId,
      });
      return;
    }

    // update / delete: precondition is a still-tracked live row to target.
    const rowCapture = lastRowCapture.get(op.tableIndex);
    if (!rowCapture) {
      decisions.push({
        kind: "skipped-precondition",
        operation: op.kind,
        reason: `no tracked live row for table "${table.table.name}" yet (insert must precede ${op.kind})`,
      });
      return;
    }

    if (op.kind === "update") {
      const patch = renderRowValues(table.table, op.valueSeed + 1000);
      steps.push({
        id: stepId,
        kind: "data.update",
        phase: "exercise",
        actor: "actor.owner",
        dependsOn,
        input: {
          table: table.table.name,
          filters: [{ field: "id", op: "eq", value: { $ref: `capture:${rowCapture}` } }],
          patch,
        },
      });
      lastStepForTable.set(op.tableIndex, stepId);
      decisions.push({
        kind: "emitted",
        operation: "data.update",
        reason: `targets the row tracked by capture "${rowCapture}"`,
        stepId,
      });
      return;
    }

    // delete
    steps.push({
      id: stepId,
      kind: "data.delete",
      phase: "exercise",
      actor: "actor.owner",
      dependsOn,
      input: {
        table: table.table.name,
        filters: [{ field: "id", op: "eq", value: { $ref: `capture:${rowCapture}` } }],
      },
    });
    table.liveRowCount -= 1;
    // The deleted row is no longer trackable; a later update/delete on this table must
    // wait for a fresh insert (a deliberately conservative precondition -- this
    // interpreter never assumes a row it did not itself just create still exists).
    lastRowCapture.delete(op.tableIndex);
    lastStepForTable.set(op.tableIndex, stepId);
    decisions.push({
      kind: "emitted",
      operation: "data.delete",
      reason: `targets the row tracked by capture "${rowCapture}"`,
      stepId,
    });
  });

  return {
    resources: [schemaResource],
    actors: [owner],
    steps,
    decisions,
    requirements: [
      { capability: "data.select", range: "^1.0.0", accept: ["exact"] },
      { capability: "data.insert", range: "^1.0.0", accept: ["exact"] },
      { capability: "data.update", range: "^1.0.0", accept: ["exact"] },
      { capability: "data.delete", range: "^1.0.0", accept: ["exact"] },
      { capability: "auth.password.signup", range: "^1.0.0", accept: ["exact"] },
    ],
  };
}

export function buildScenario(
  id: StableId,
  seed: string,
  interpreted: InterpretedScenario,
  provenance: ScenarioProvenance,
): ScenarioSpec {
  return {
    format: "supadiff.scenario",
    formatVersion: "1.0",
    id,
    revision: "1",
    title: `Generated Data+Auth+RLS scenario (${id})`,
    description:
      "Generated by @supadiff/generators's Data+Auth+RLS domain model (Architecture Contract §10): " +
      "an owner-scoped, RLS-enabled schema plus a precondition-checked sequence of insert/select/" +
      "update/delete operations.",
    tags: ["l12", "generated"],
    seed,
    client: { library: "supabase-js", version: "2.97.0" },
    requirements: interpreted.requirements,
    resources: interpreted.resources,
    actors: interpreted.actors,
    steps: interpreted.steps,
    cleanup: [],
    comparison: { policyId: "policy.generated-data-auth-rls", policyVersion: "1" },
    expectedOutcomes: [],
    limits: {
      maxSteps: 64,
      maxWallTimeMs: 60_000,
      maxArtifactBytes: 10_000_000,
      maxRequestsPerTarget: 64,
      maxHostedCostUsd: 0,
      maxParallelOperations: 1,
    },
    provenance,
  };
}

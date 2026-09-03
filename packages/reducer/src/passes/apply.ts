import type { ScenarioSpec, StableId } from "@supadiff/spec";

function walkForCaptureRefs(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) walkForCaptureRefs(v, found);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj["$ref"] === "string" && obj["$ref"].startsWith("capture:")) {
    found.add(obj["$ref"].slice("capture:".length));
    return;
  }
  for (const v of Object.values(obj)) walkForCaptureRefs(v, found);
}

function resourceIdsIn(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) resourceIdsIn(v, found);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj["resourceId"] === "string") found.add(obj["resourceId"]);
  for (const v of Object.values(obj)) resourceIdsIn(v, found);
}

/**
 * Applies a step-removal candidate, then prunes actors/resources/observers/cleanup items
 * that become unreferenced as a consequence — never the reverse (removing an actor never
 * forces a step to be removed; a step referencing a missing actor would be invalid, so the
 * candidate generator must never remove an actor a kept step still uses).
 */
export function applyStepRemoval(
  scenario: ScenarioSpec,
  removedStepIds: ReadonlySet<StableId>,
  reductionOrdinal: number,
): ScenarioSpec {
  const keptSteps = scenario.steps.filter((s) => !removedStepIds.has(s.id));

  const producedCaptures = new Set<string>();
  for (const step of keptSteps) for (const c of step.capture ?? []) producedCaptures.add(c.name);

  const referencedActors = new Set<StableId>();
  const referencedResources = new Set<string>();
  for (const step of keptSteps) {
    if (step.actor) referencedActors.add(step.actor);
    resourceIdsIn(step.input, referencedResources);
  }

  const keptStepsWithValidObservers = keptSteps.map((step) => {
    if (!step.observe || step.observe.length === 0) return step;
    const observe = step.observe.filter((o) => {
      const refs = new Set<string>();
      walkForCaptureRefs(o.input, refs);
      return [...refs].every((r) => producedCaptures.has(r));
    });
    return observe.length === step.observe.length ? step : { ...step, observe };
  });

  const cleanup = scenario.cleanup.filter((c) => {
    const refs = new Set<string>();
    walkForCaptureRefs(c.input, refs);
    return [...refs].every((r) => producedCaptures.has(r));
  });

  return {
    ...scenario,
    revision: `${scenario.revision}-reduced${reductionOrdinal}`,
    steps: keptStepsWithValidObservers,
    actors: scenario.actors.filter((a) => referencedActors.has(a.id)),
    resources: scenario.resources.filter((r) => referencedResources.has(r.id)),
    cleanup,
    provenance: { ...scenario.provenance, origin: "reduced" },
  };
}

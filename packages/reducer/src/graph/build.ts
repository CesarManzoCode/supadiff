import type { ScenarioSpec, StableId } from "@supadiff/spec";
import type { GraphEdge, GraphNode, ReductionGraph } from "./types.js";

function addEdge(graph: ReductionGraph, edge: GraphEdge): void {
  if (!graph.dependsOn.has(edge.from)) graph.dependsOn.set(edge.from, new Set());
  graph.dependsOn.get(edge.from)!.add(edge.to);
  if (!graph.dependedOnBy.has(edge.to)) graph.dependedOnBy.set(edge.to, new Set());
  graph.dependedOnBy.get(edge.to)!.add(edge.from);
}

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
 * Builds the typed dependency graph a reduction pass reasons over (§11.1). This build's
 * scope covers step/actor/resource/observer/cleanup granularity — see
 * `docs/LIMITATIONS.md` for what §11.1's full node taxonomy (schema objects at
 * table/column grain, seed rows, individual policy clauses) is not yet implemented.
 */
export function buildReductionGraph(scenario: ScenarioSpec): ReductionGraph {
  const graph: ReductionGraph = {
    nodes: new Map(),
    dependsOn: new Map(),
    dependedOnBy: new Map(),
  };

  const addNode = (n: GraphNode): void => {
    graph.nodes.set(n.id, n);
  };

  for (const actor of scenario.actors) addNode({ id: actor.id, kind: "actor" });
  for (const resource of scenario.resources) addNode({ id: resource.id, kind: "resource" });

  const captureProducer = new Map<string, StableId>();
  for (const step of scenario.steps) {
    for (const capture of step.capture ?? []) captureProducer.set(capture.name, step.id);
  }

  for (const step of scenario.steps) {
    addNode({ id: step.id, kind: "step" });
    if (step.actor) addEdge(graph, { from: step.id, to: step.actor, label: "authenticates" });
    for (const dep of step.dependsOn ?? []) {
      addEdge(graph, { from: step.id, to: dep, label: "requires" });
    }
    const refs = new Set<string>();
    walkForCaptureRefs(step.input, refs);
    for (const name of refs) {
      const producer = captureProducer.get(name);
      if (producer) addEdge(graph, { from: step.id, to: producer, label: "references" });
    }
    const resourceIds = new Set<string>();
    resourceIdsIn(step.input, resourceIds);
    for (const id of resourceIds) {
      if (graph.nodes.has(id)) addEdge(graph, { from: step.id, to: id, label: "references" });
    }
    for (const observer of step.observe ?? []) {
      const obsId = `${step.id}::${observer.id}` as StableId;
      addNode({ id: obsId, kind: "observer" });
      addEdge(graph, { from: obsId, to: step.id, label: "observes" });
      const obsRefs = new Set<string>();
      walkForCaptureRefs(observer.input, obsRefs);
      for (const name of obsRefs) {
        const producer = captureProducer.get(name);
        if (producer) addEdge(graph, { from: obsId, to: producer, label: "references" });
      }
    }
  }

  for (const cleanup of scenario.cleanup) {
    addNode({ id: cleanup.id, kind: "cleanup" });
    const refs = new Set<string>();
    walkForCaptureRefs(cleanup.input, refs);
    for (const name of refs) {
      const producer = captureProducer.get(name);
      if (producer) addEdge(graph, { from: cleanup.id, to: producer, label: "references" });
    }
  }

  return graph;
}

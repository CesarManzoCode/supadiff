import type { StableId } from "@supadiff/spec";

/**
 * Dependency-graph node kinds this build's reducer actually reasons about (§11.1).
 * `resource` nodes are kept coarse (whole schema/migration resource, not
 * table/column granularity) — see docs/LIMITATIONS.md for the exact scope this
 * sprint implements versus the full §11.1 node taxonomy.
 */
export type GraphNodeKind = "step" | "actor" | "resource" | "capture" | "observer" | "cleanup";

export interface GraphNode {
  id: StableId;
  kind: GraphNodeKind;
}

export type GraphEdgeLabel =
  | "creates"
  | "requires"
  | "references"
  | "authenticates"
  | "owns"
  | "observes";

export interface GraphEdge {
  from: StableId;
  to: StableId;
  label: GraphEdgeLabel;
}

export interface ReductionGraph {
  nodes: Map<StableId, GraphNode>;
  /** Adjacency: node id -> the set of node ids it depends on (edges point dependency-ward). */
  dependsOn: Map<StableId, Set<StableId>>;
  /** Reverse adjacency: node id -> the set of node ids that depend on it. */
  dependedOnBy: Map<StableId, Set<StableId>>;
}

/** Every node reachable from `roots` by following `dependsOn` edges, `roots` included. */
export function dependencyClosure(graph: ReductionGraph, roots: Iterable<StableId>): Set<StableId> {
  const closure = new Set<StableId>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const dep of graph.dependsOn.get(id) ?? []) stack.push(dep);
  }
  return closure;
}

/** Every node that transitively depends on any node in `roots` (the reverse-dependency cone). */
export function reverseDependencyClosure(
  graph: ReductionGraph,
  roots: Iterable<StableId>,
): Set<StableId> {
  const closure = new Set<StableId>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const dep of graph.dependedOnBy.get(id) ?? []) stack.push(dep);
  }
  return closure;
}

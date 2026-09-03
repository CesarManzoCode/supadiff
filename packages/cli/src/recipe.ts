import type { TargetSpec } from "@supadiff/spec";

export interface SanitizedRecipeJson {
  targetSlot: string;
  kind: string;
  package?: TargetSpec["package"];
  runtime: TargetSpec["runtime"];
  backend?: TargetSpec["backend"];
  config: TargetSpec["config"];
}

/**
 * Reconstructs a driver-usable `TargetSpec` from a bundle's *sanitized* recipe
 * (`{targetSlot, kind, package, runtime, backend, config}` — §9.1's deliberately
 * narrower on-disk shape, never a full `TargetSpec`). Lifecycle/safety/credentialRefs
 * carry no live secrets to begin with, so replay/reduce always supply fresh local-safe
 * defaults for them rather than expecting the artifact to carry them.
 */
export function recipeToTargetSpec(recipe: SanitizedRecipeJson): TargetSpec {
  return {
    id: recipe.targetSlot,
    kind: recipe.kind as TargetSpec["kind"],
    package: recipe.package,
    runtime: recipe.runtime,
    backend: recipe.backend,
    config: recipe.config,
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 30000,
      teardownTimeoutMs: 10000,
      cleanup: "always",
      keepOnFailure: "deny",
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  };
}

export function candidateRecipes(files: Map<string, Buffer>): TargetSpec[] {
  const specs: TargetSpec[] = [];
  for (const [filePath, buf] of files) {
    if (!/^targets\/candidate.*\.recipe\.json$/.test(filePath)) continue;
    specs.push(recipeToTargetSpec(JSON.parse(buf.toString("utf8")) as SanitizedRecipeJson));
  }
  return specs;
}

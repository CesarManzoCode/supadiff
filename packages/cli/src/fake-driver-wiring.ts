import type { TargetSpec } from "@supadiff/spec";
import { FakeTargetDriver, type FakeScript } from "@supadiff/engine";

/**
 * Builds a `FakeTargetDriver` from a list of already-validated `fake`-kind target specs
 * whose `config.script` embeds the fixture script inline (§15.2 test infrastructure,
 * wired here only so the L5 CLI acceptance command has something real to execute).
 */
export function buildFakeDriverFromTargets(targets: TargetSpec[]): FakeTargetDriver {
  const registry: Record<string, FakeScript> = {};
  for (const target of targets) {
    const config = target.config as unknown as { scriptId: string; script?: FakeScript };
    if (!config.script) {
      throw new Error(`target "${target.id}": fake target config is missing an inline "script"`);
    }
    registry[config.scriptId] = config.script;
  }
  return new FakeTargetDriver(registry);
}

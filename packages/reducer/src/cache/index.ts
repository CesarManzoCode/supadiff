import { sha256OfCanonicalJson, type ScenarioSpec, type Sha256 } from "@supadiff/spec";
import type { AcceptanceOutcome, ReductionContext } from "../oracle/types.js";

/**
 * Oracle results are cached by candidate digest + target recipe digest + rule-policy
 * digest + toolchain identity (§11.2) — never candidate digest alone, since the same
 * candidate bytes could be tried under a different policy/toolchain across reducer runs.
 */
export interface OracleCache {
  get(key: Sha256): AcceptanceOutcome | undefined;
  set(key: Sha256, value: AcceptanceOutcome): void;
  readonly size: number;
}

export function createOracleCache(): OracleCache {
  const store = new Map<Sha256, AcceptanceOutcome>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    get size() {
      return store.size;
    },
  };
}

export function cacheKey(candidate: ScenarioSpec, ctx: ReductionContext): Sha256 {
  return sha256OfCanonicalJson({
    candidate,
    referenceSpec: ctx.referenceSpec,
    candidateSpec: ctx.candidateSpec,
    policy: ctx.policy,
    toolchainId: ctx.toolchainId,
  } as never);
}

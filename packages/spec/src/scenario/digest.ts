import type { Sha256 } from "../ids.js";
import type { JsonValue } from "../json-value.js";
import { sha256OfCanonicalJson } from "../canonical.js";
import type { ScenarioSpec } from "./types.js";

/** The scenarioDigest identifies exact bytes after canonicalization (§2.2). */
export function computeScenarioDigest(scenario: ScenarioSpec): Sha256 {
  return sha256OfCanonicalJson(scenario as unknown as JsonValue);
}

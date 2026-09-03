/**
 * @supadiff/generators — domain model and seeded scenario producers
 * (Architecture Contract §10, Implementation DAG L12).
 */
export * from "./types.js";
export * from "./generator.js";
export * from "./model/types.js";
export * from "./model/sql.js";
export {
  hashSeedToUint32,
  sampleGenerationPlans,
  RESOLVED_BUDGET_DEFAULTS,
} from "./model/arbitraries.js";
export { interpretPlan, buildScenario } from "./model/interpret.js";

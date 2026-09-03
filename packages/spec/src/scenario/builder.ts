/**
 * Declarative TypeScript builder (§3.1). Produces the exact same JSON AST as
 * hand-authored canonical JSON: every function here is a pure, synchronous
 * constructor of plain data. No callbacks, no network access, no target objects,
 * and nothing here is ever stored inside a `ScenarioSpec`.
 */
import type { ActorSpec, CaptureSpec, CleanupSpec, ScenarioSpec, StepSpec } from "./types.js";

export function scenario(spec: ScenarioSpec): ScenarioSpec {
  return spec;
}

export function step<S extends StepSpec>(spec: S): S {
  return spec;
}

export function actor(spec: ActorSpec): ActorSpec {
  return spec;
}

export function capture(spec: CaptureSpec): CaptureSpec {
  return spec;
}

export function cleanupStep(spec: CleanupSpec): CleanupSpec {
  return spec;
}

export function ref(captureName: string): { $ref: `capture:${string}` } {
  return { $ref: `capture:${captureName}` };
}

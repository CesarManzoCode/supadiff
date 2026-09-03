import path from "node:path";
import type {
  RawObservation,
  ScenarioSpec,
  SemanticObservation,
  TargetIdentity,
  TargetSpec,
} from "@supadiff/spec";
import { readBundleDirectory } from "./artifact-io.js";

export interface ReadRunArtifact {
  dir: string;
  files: Map<string, Buffer>;
  manifest: { format: string; artifactId: string; artifactKind: string };
  scenario: ScenarioSpec;
  targetRecipe: TargetSpec | Record<string, unknown>;
  identity: TargetIdentity | undefined;
  finalRawByStep: Map<string, RawObservation>;
  finalSemanticByStep: Map<string, SemanticObservation>;
}

function parseJson<T>(buf: Buffer): T {
  return JSON.parse(buf.toString("utf8")) as T;
}

/** Reads a `.supadiff` run-artifact directory back into structures usable by offline `compare` (§14.1). */
export async function readRunArtifact(dir: string): Promise<ReadRunArtifact> {
  const files = await readBundleDirectory(dir);
  const manifest = parseJson<{ format: string; artifactId: string; artifactKind: string }>(
    files.get("manifest.json")!,
  );
  const scenario = parseJson<ScenarioSpec>(files.get("scenario/scenario.json")!);
  const targetRecipe = files.has("targets/reference.recipe.json")
    ? parseJson<Record<string, unknown>>(files.get("targets/reference.recipe.json")!)
    : {};
  const identities = files.has("targets/observed-identities.json")
    ? parseJson<Record<string, TargetIdentity | null>>(
        files.get("targets/observed-identities.json")!,
      )
    : {};
  const identity = Object.values(identities)[0] ?? undefined;

  const finalRawByStep = new Map<string, RawObservation>();
  const finalSemanticByStep = new Map<string, SemanticObservation>();
  const bestAttemptRaw = new Map<string, number>();
  const bestAttemptSemantic = new Map<string, number>();

  for (const [filePath, buf] of files) {
    const base = path.basename(filePath, ".json");
    if (filePath.includes("/raw/")) {
      const [stepId, attemptStr] = base.split("__");
      const attempt = Number(attemptStr);
      if ((bestAttemptRaw.get(stepId!) ?? -1) <= attempt) {
        bestAttemptRaw.set(stepId!, attempt);
        finalRawByStep.set(stepId!, parseJson<RawObservation>(buf));
      }
    } else if (filePath.includes("/semantic/")) {
      const [stepId, attemptStr] = base.split("__");
      const attempt = Number(attemptStr);
      if ((bestAttemptSemantic.get(stepId!) ?? -1) <= attempt) {
        bestAttemptSemantic.set(stepId!, attempt);
        finalSemanticByStep.set(stepId!, parseJson<SemanticObservation>(buf));
      }
    }
  }

  return {
    dir,
    files,
    manifest,
    scenario,
    targetRecipe: targetRecipe as unknown as TargetSpec,
    identity: identity ?? undefined,
    finalRawByStep,
    finalSemanticByStep,
  };
}

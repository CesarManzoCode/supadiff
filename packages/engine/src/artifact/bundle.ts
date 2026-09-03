import type { Sha256 } from "@supadiff/spec";
import {
  canonicalizeJson,
  sha256OfBytes,
  sha256OfCanonicalJson,
  type JsonValue,
} from "@supadiff/spec";
import { scanValueForSecrets, type DetectorHit } from "../observation/detectors.js";
import type { BuildBundleInput } from "./types.js";

export interface BuiltBundle {
  /** path -> file bytes, exactly as they must appear in the deterministic ZIP. */
  files: Map<string, Buffer>;
  artifactId: Sha256;
  secretScanPassed: boolean;
  findings: DetectorHit[];
}

function canonicalBuffer(value: JsonValue): Buffer {
  return Buffer.from(canonicalizeJson(value), "utf8");
}

function ndjsonBuffer(objects: JsonValue[]): Buffer {
  return Buffer.from(
    objects.map((o) => canonicalizeJson(o)).join("\n") + (objects.length > 0 ? "\n" : ""),
    "utf8",
  );
}

/**
 * Assembles every payload file for a `.supadiff` run/comparison artifact (§9.1), computes
 * `artifactId`, and runs the mandatory pre-finalization secret scan (§L5, §6.4). Callers
 * MUST check `secretScanPassed` before writing a ZIP — an unexplained detector hit means
 * the artifact must not be created as "successful".
 */
export function buildBundle(input: BuildBundleInput): BuiltBundle {
  const files = new Map<string, Buffer>();

  files.set("scenario/scenario.json", canonicalBuffer(input.scenario as unknown as JsonValue));
  files.set("policy/comparison-policy.json", canonicalBuffer(input.policy as unknown as JsonValue));
  files.set(
    "policy/known-divergences.json",
    canonicalBuffer(input.knownDivergences as unknown as JsonValue),
  );

  const referenceTarget = input.targets.find((t) => t.role === "reference");
  const candidateTargets = input.targets.filter((t) => t.role === "candidate");

  if (referenceTarget) {
    files.set(
      "targets/reference.recipe.json",
      canonicalBuffer(sanitizedRecipe(referenceTarget) as unknown as JsonValue),
    );
  }
  for (const c of candidateTargets) {
    const suffix = candidateTargets.length > 1 ? `.${c.slot}` : "";
    files.set(
      `targets/candidate${suffix}.recipe.json`,
      canonicalBuffer(sanitizedRecipe(c) as unknown as JsonValue),
    );
  }

  const observedIdentities = Object.fromEntries(
    input.targets.map((t) => [t.slot, t.identity ?? null]),
  );
  files.set(
    "targets/observed-identities.json",
    canonicalBuffer(observedIdentities as unknown as JsonValue),
  );

  const capabilities = Object.fromEntries(input.targets.map((t) => [t.slot, t.capabilities]));
  files.set("targets/capabilities.json", canonicalBuffer(capabilities as unknown as JsonValue));

  for (const target of input.targets) {
    const dir = `runs/${target.role === "reference" ? "reference" : `candidate${candidateTargets.length > 1 ? `-${target.slot}` : ""}`}`;
    files.set(`${dir}/events.ndjson`, ndjsonBuffer(target.events as unknown as JsonValue[]));
    for (const [key, raw] of target.rawObservations) {
      // "__" is an unambiguous delimiter: the StableId grammar never produces it
      // (separators are single . _ - characters between alphanumeric groups), so
      // step id / attempt / observation id can always be split back out losslessly.
      const [stepId, attempt] = key.split(":");
      files.set(
        `${dir}/raw/${stepId}__${attempt}__${raw.observationId}.json`,
        canonicalBuffer(raw as unknown as JsonValue),
      );
    }
    for (const [key, semantic] of target.semanticObservations) {
      const [stepId, attempt] = key.split(":");
      files.set(
        `${dir}/semantic/${stepId}__${attempt}__${semantic.projector.id}.json`,
        canonicalBuffer(semantic as unknown as JsonValue),
      );
    }
  }

  files.set(
    "comparison/results.json",
    canonicalBuffer(input.comparisonResults as unknown as JsonValue),
  );
  files.set(
    "comparison/divergence-signature.json",
    canonicalBuffer(input.divergenceSignatures as unknown as JsonValue),
  );

  files.set("report/report.md", Buffer.from(renderReport(input), "utf8"));

  files.set("provenance/toolchain.json", canonicalBuffer(input.toolchain as unknown as JsonValue));
  files.set(
    "provenance/recovery-summary.json",
    canonicalBuffer(input.recoverySummary as unknown as JsonValue),
  );

  // --- Mandatory pre-finalization secret scan (§6.4, §L5): scan every payload assembled so far. ---
  const findings: DetectorHit[] = [];
  for (const [path, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      parsed = buf.toString("utf8");
    }
    findings.push(...scanValueForSecrets(parsed, path, input.configuredSecretLiterals));
  }
  const secretScanPassed = findings.length === 0;

  files.set(
    "provenance/secret-scan.json",
    canonicalBuffer({
      scannedAt: input.createdAt,
      filesScanned: files.size,
      findings: findings.map((f) => ({ location: f.location, detector: f.detector })),
      passed: secretScanPassed,
    } as unknown as JsonValue),
  );

  // --- artifactId: hash of the ordered (path, sha256) payload inventory, before manifest/checksums exist. ---
  const inventory = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, buf]) => [path, sha256OfBytes(buf)]);
  const artifactId = sha256OfCanonicalJson(inventory as unknown as JsonValue);

  const manifest = {
    format: "supadiff.artifact",
    formatVersion: "1.0",
    artifactId,
    artifactKind: input.targets.some((t) => t.role === "candidate") ? "comparison" : "run",
    content: inventory.map(([path, sha256]) => ({ path, sha256 })),
    secretScan: {
      scannedAt: input.createdAt,
      filesScanned: files.size,
      findings: findings.length,
      passed: secretScanPassed,
    },
  };
  files.set("manifest.json", canonicalBuffer(manifest as unknown as JsonValue));

  // --- checksums.sha256: every payload file plus the now-finalized manifest.json, excluding itself. ---
  const checksumLines = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, buf]) => `${sha256OfBytes(buf)}  ${path}`);
  files.set("checksums.sha256", Buffer.from(checksumLines.join("\n") + "\n", "utf8"));

  return { files, artifactId, secretScanPassed, findings };
}

function sanitizedRecipe(target: BuildBundleInput["targets"][number]) {
  return {
    targetSlot: target.slot,
    kind: target.targetSpec.kind,
    package: target.targetSpec.package,
    runtime: target.targetSpec.runtime,
    backend: target.targetSpec.backend,
    // `config` for the "fake" kind may embed test fixture data only; no live credentials ever appear here.
    config: target.targetSpec.config,
  };
}

function renderReport(input: BuildBundleInput): string {
  const lines: string[] = [];
  lines.push(`# SupaDiff comparison report`);
  lines.push("");
  lines.push(`Scenario: \`${input.scenario.id}\` revision \`${input.scenario.revision}\``);
  lines.push("");
  const counts = new Map<string, number>();
  for (const r of input.comparisonResults) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  lines.push("## Outcome summary");
  lines.push("");
  for (const [outcome, count] of [...counts.entries()].sort()) lines.push(`- ${outcome}: ${count}`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  for (const r of input.comparisonResults) {
    lines.push(`- \`${r.stepId}${r.observablePath}\`: **${r.outcome}** — ${r.explanation.summary}`);
  }
  lines.push("");
  lines.push(
    "_This report is derived convenience output; comparison/results.json is authoritative._",
  );
  return lines.join("\n") + "\n";
}

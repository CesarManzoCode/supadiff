import type { FieldCoverageReceipt, JsonPointer } from "@supadiff/spec";

export interface FieldAccounting {
  contractual: JsonPointer[];
  diagnostic: JsonPointer[];
  ignored: JsonPointer[];
}

/**
 * Computes field coverage over the top-level keys of a response body (§7.3, §L3 "unknown
 * field fail-closed"). A raw field not accounted for by a contractual, diagnostic, or
 * explicit-ignore pointer becomes `unassessed` — projectors MUST NOT silently discard it.
 */
export function computeCoverage(
  responseBody: unknown,
  accounting: FieldAccounting,
): FieldCoverageReceipt {
  const accountedTopLevelKeys = new Set(
    [...accounting.contractual, ...accounting.diagnostic, ...accounting.ignored].map(
      (p) => p.split("/")[1],
    ),
  );

  const unassessed: JsonPointer[] = [];
  if (responseBody !== null && typeof responseBody === "object" && !Array.isArray(responseBody)) {
    for (const key of Object.keys(responseBody as Record<string, unknown>)) {
      if (!accountedTopLevelKeys.has(key)) unassessed.push(`/${key}`);
    }
  }

  return {
    contractualFields: accounting.contractual,
    diagnosticFields: accounting.diagnostic,
    ignoredFields: accounting.ignored,
    unassessedFields: unassessed,
  };
}

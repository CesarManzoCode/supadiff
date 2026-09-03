import type { JsonPointer } from "./json-value.js";

/** A single structural or schema validation problem, attributable to a JSON Pointer. */
export interface ValidationIssue {
  path: JsonPointer;
  code: string;
  message: string;
}

/** Thrown by every `parse*`/`validate*` entrypoint on untrusted input (§1.2 invariant 9, L1). */
export class SpecValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const summary = issues.map((i) => `${i.path || "/"}: ${i.code}: ${i.message}`).join("; ");
    super(`Validation failed with ${issues.length} issue(s): ${summary}`);
    this.name = "SpecValidationError";
    this.issues = issues;
  }
}

export function issue(path: JsonPointer, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

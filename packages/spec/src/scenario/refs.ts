import type { ValueRef } from "./types.js";

export function isValueRef(value: unknown): value is ValueRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = (value as Record<string, unknown>)["$ref"];
  return typeof ref === "string" && ref.startsWith("capture:");
}

export function captureNameOf(ref: ValueRef): string {
  return ref.$ref.slice("capture:".length);
}

/** Identity and version primitives (Architecture Contract §2.1). */

export type FormatVersion = `${number}.${number}`;
export type StableId = string;
export type Sha256 = `sha256:${string}`;
export type IsoDateTime = string;
export type DurationMs = number;

export interface VersionedRef {
  id: StableId;
  version: string;
}

/** Persisted IDs MUST match this pattern (§2.1). Step IDs are unique within a scenario. */
export const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function isStableId(value: unknown): value is StableId {
  return typeof value === "string" && STABLE_ID_PATTERN.test(value);
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

const FORMAT_VERSION_PATTERN = /^\d+\.\d+$/;

export function isFormatVersion(value: unknown): value is FormatVersion {
  return typeof value === "string" && FORMAT_VERSION_PATTERN.test(value);
}

/** Parses "MAJOR.MINOR" and returns numeric parts, or null if malformed. */
export function parseFormatVersion(value: string): { major: number; minor: number } | null {
  if (!isFormatVersion(value)) return null;
  const [majorStr, minorStr] = value.split(".");
  return { major: Number(majorStr), minor: Number(minorStr) };
}

/** A closed uint64 decimal string, used for scenario seeds (§2.2). */
const UINT64_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 18446744073709551615n;

export function isUint64DecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !UINT64_DECIMAL_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

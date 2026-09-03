import { sha256OfBytes } from "@supadiff/spec";

export interface ChecksumVerification {
  ok: boolean;
  missing: string[];
  mismatched: string[];
}

/**
 * Verifies every line of `checksums.sha256` against the actual bytes of a loaded bundle
 * (§9.1, §L5 "checksum corruption" test). `checksums.sha256` and `manifest.json` are
 * self-referential per the contract (`checksums.sha256` excludes only itself) and are
 * not re-verified against their own listing here.
 */
export function verifyChecksums(files: Map<string, Buffer>): ChecksumVerification {
  const checksumFile = files.get("checksums.sha256");
  if (!checksumFile) return { ok: false, missing: ["checksums.sha256"], mismatched: [] };

  const missing: string[] = [];
  const mismatched: string[] = [];
  const lines = checksumFile
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);

  for (const line of lines) {
    const [expected, ...rest] = line.split("  ");
    const filePath = rest.join("  ");
    const actualBytes = files.get(filePath);
    if (!actualBytes) {
      missing.push(filePath);
      continue;
    }
    if (sha256OfBytes(actualBytes) !== expected) mismatched.push(filePath);
  }

  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

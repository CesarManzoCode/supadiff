/**
 * Secondary structural secret detector (§6.4). Defense in depth only — typed redaction
 * (by operation schema / known response shape) runs first. A detector hit not already
 * explained by typed redaction blocks artifact finalization (fail closed).
 */
export interface DetectorHit {
  location: string;
  detector: string;
}

const JWT_SHAPE = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
const SB_PUBLISHABLE_KEY = /\bsb_publishable_[A-Za-z0-9_-]{10,}\b/;
const SB_SECRET_KEY = /\bsb_secret_[A-Za-z0-9_-]{10,}\b/;
const AUTHORIZATION_BEARER = /\bBearer\s+[A-Za-z0-9._-]{10,}\b/i;
const SIGNED_QUERY_PARAM = /[?&](token|signature|sig|x-amz-signature)=[^&\s]{8,}/i;
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----/;

const DETECTORS: Array<{ name: string; pattern: RegExp }> = [
  { name: "jwt-shape", pattern: JWT_SHAPE },
  { name: "sb-publishable-key", pattern: SB_PUBLISHABLE_KEY },
  { name: "sb-secret-key", pattern: SB_SECRET_KEY },
  { name: "authorization-bearer", pattern: AUTHORIZATION_BEARER },
  { name: "signed-query-param", pattern: SIGNED_QUERY_PARAM },
  { name: "pem-block", pattern: PEM_BLOCK },
];

const PURE_HEX = /^[0-9a-f]{16,}$/;
const CONTENT_HASH_REF = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_HANDLE = /^(sec|cap|res)-[0-9a-f]{8,}$/;
// Deterministic diagnostic run identifiers (`run-<scenario-id>-<revision>`, §2.10
// `RawObservation.runId`) are constructed from the scenario's own public id/revision,
// never from secret material — excluded like the other structured non-secret ids below.
const RUN_ID_SHAPE = /^run-[a-z][a-z0-9._-]*-[^-]+$/;

/**
 * High-entropy heuristic: long runs of mixed-case alphanumeric/symbols with no
 * dictionary shape. Content-hash digests, artifact content refs, and opaque
 * non-secret handles are excluded: they are deliberately high-entropy identifiers
 * that this system persists everywhere by design (checksums, `sourceRawDigest`,
 * capture/secret handles), never secret bytes.
 */
function looksHighEntropy(s: string): boolean {
  if (s.length < 24) return false;
  if (
    PURE_HEX.test(s) ||
    CONTENT_HASH_REF.test(s) ||
    OPAQUE_HANDLE.test(s) ||
    RUN_ID_SHAPE.test(s)
  ) {
    return false;
  }
  const unique = new Set(s).size;
  return unique >= 12 && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && !/\s/.test(s);
}

export function scanStringForSecrets(
  value: string,
  location: string,
  configuredLiterals: string[],
): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const d of DETECTORS) {
    if (d.pattern.test(value)) hits.push({ location, detector: d.name });
  }
  for (const literal of configuredLiterals) {
    if (literal.length > 0 && value.includes(literal))
      hits.push({ location, detector: "configured-secret-literal" });
  }
  // High-entropy heuristic only fires on values that look like whole tokens, not prose bodies.
  if (!/\s/.test(value) && looksHighEntropy(value))
    hits.push({ location, detector: "high-entropy-token" });
  return hits;
}

export function scanValueForSecrets(
  value: unknown,
  path: string,
  configuredLiterals: string[],
): DetectorHit[] {
  if (typeof value === "string") return scanStringForSecrets(value, path, configuredLiterals);
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => scanValueForSecrets(v, `${path}/${i}`, configuredLiterals));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // A `{$secret, handle}` receipt marker is the redaction system's own opaque
    // vault handle, not a secret value — scanning it would make the detector flag
    // successful redaction as a leak. Everything else is scanned as usual.
    const isRedactionMarker =
      typeof obj["$secret"] === "string" && typeof obj["handle"] === "string";
    return Object.entries(obj)
      .filter(([k]) => !(isRedactionMarker && k === "handle"))
      .flatMap(([k, v]) => scanValueForSecrets(v, `${path}/${k}`, configuredLiterals));
  }
  return [];
}

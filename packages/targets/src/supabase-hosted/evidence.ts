/**
 * A secret-safe evidence log for a hosted run (§6.4, § secret-safe evidence/artifacts). It
 * records *what the driver did* to the hosted project — provisioned, applied schema,
 * cleaned up — as structured notes with a monotonic sequence, never a credential, an API
 * key, an access token or a signed URL. `redact()` runs every recorded string through the
 * run's known secret literals as a defence in depth before the log is surfaced.
 */
export interface HostedEvidenceEntry {
  seq: number;
  event: string;
  detail: Record<string, unknown>;
}

export interface HostedEvidence {
  readonly runNamespace: string;
  note(event: string, detail: Record<string, unknown>): void;
  entries(): readonly HostedEvidenceEntry[];
  redact(secretLiterals: readonly string[]): void;
  toJSON(): { runNamespace: string; entries: HostedEvidenceEntry[] };
}

function deepRedact(value: unknown, literals: readonly string[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const lit of literals) {
      if (lit.length >= 8 && out.includes(lit)) out = out.split(lit).join("«redacted»");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, literals));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = deepRedact(v, literals);
    return o;
  }
  return value;
}

export function newHostedEvidence(runNamespace: string): HostedEvidence {
  const list: HostedEvidenceEntry[] = [];
  let seq = 0;
  return {
    runNamespace,
    note(event, detail) {
      list.push({ seq: seq++, event, detail: { ...detail } });
    },
    entries() {
      return list;
    },
    redact(secretLiterals) {
      for (const e of list) {
        e.detail = deepRedact(e.detail, secretLiterals) as Record<string, unknown>;
      }
    },
    toJSON() {
      return { runNamespace, entries: [...list] };
    },
  };
}

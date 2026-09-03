import type { DurationMs, IsoDateTime, Sha256, StableId } from "../ids.js";
import type { JsonPointer, JsonValue } from "../json-value.js";
import type { ContentRef } from "../artifact/types.js";

export type SecretHandle = `sec-${string}`;
export type CapturedValueHandle = `cap-${string}`;

export interface RedactedActorContext {
  actorId?: StableId;
  role: "anon" | "authenticated" | "service_role";
}

export interface RedactedTransportRecord {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody?: JsonValue;
  status?: number;
  responseHeaders: Record<string, string>;
  responseBody?: JsonValue;
}

export type RawOutcomeCategory = "success" | "application-error" | "harness-failure";

export interface RawOutcome {
  category: RawOutcomeCategory;
  detail?: JsonValue;
}

export type RedactionSecretClass =
  | "jwt-access-token"
  | "api-key"
  | "refresh-token"
  | "otp"
  | "signed-url"
  | "password"
  | "client-secret"
  | "db-password"
  | "hosted-project-identifier";

export interface RedactionEntry {
  fieldPath: JsonPointer;
  secretClass: RedactionSecretClass;
  handle: SecretHandle;
}

export interface RedactionReceipt {
  entries: RedactionEntry[];
  structuralDetectorHits: number;
}

export interface RawObservation {
  format: "supadiff.raw-observation";
  observer: { id: StableId; version: string };
  observationId: StableId;
  origin: "primary" | "immediate-observer" | "explicit-observer";
  runId: StableId;
  targetSlot: StableId;
  stepId: StableId;
  attempt: number;
  operation: { id: StableId; version: string };
  actor: RedactedActorContext;
  startedAt: IsoDateTime;
  durationMs: DurationMs;
  transport: RedactedTransportRecord;
  outcome: RawOutcome;
  attachments: ContentRef[];
  redaction: RedactionReceipt;
}

export type SemanticValue = JsonValue;

export interface IgnoredFieldReceipt {
  selector: JsonPointer;
  reason: string;
  rule: { id: StableId; version: string };
  evidence: string[];
}

export interface RelationshipFact {
  predicate: StableId;
  subject: string;
  object: string;
}

export interface StateFact {
  label: string;
  value: JsonValue;
}

export interface FieldCoverageReceipt {
  contractualFields: JsonPointer[];
  diagnosticFields: JsonPointer[];
  ignoredFields: JsonPointer[];
  unassessedFields: JsonPointer[];
}

export interface SemanticObservation {
  format: "supadiff.semantic-observation";
  projector: { id: StableId; version: string };
  sourceRawDigest: Sha256;
  service: "schema" | "auth" | "data" | "rls" | "storage" | "cli" | "upgrade";
  operation: { id: StableId; version: string };
  contractFields: Record<JsonPointer, SemanticValue>;
  ignoredFields: IgnoredFieldReceipt[];
  relationships: RelationshipFact[];
  stateFacts: StateFact[];
  coverage: FieldCoverageReceipt;
}

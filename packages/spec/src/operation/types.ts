import type { StableId } from "../ids.js";
import type { JsonPointer } from "../json-value.js";

export type OperationService =
  | "schema"
  | "auth"
  | "data"
  | "rls"
  | "storage"
  | "cli"
  | "upgrade"
  | "control";

/** Category used to select raw-evidence handling per §6.2. */
export type RawOutputCategory =
  | "data-http"
  | "auth-http"
  | "storage-http"
  | "schema-apply"
  | "cli-invocation"
  | "observer"
  | "assertion"
  | "control";

export interface OperationIdempotency {
  idempotent: boolean;
  /** Present only when `idempotent` is true and a stable key field makes retries legal (§3.5, §5.6). */
  idempotencyKeyField?: JsonPointer;
}

/** Static catalog entry for one versioned operation (§2.4, §6.3). Owned by `@supadiff/spec`. */
export interface OperationDefinition {
  id: StableId;
  version: string;
  service: OperationService;
  /** JSON Schema (draft 2020-12) validating `StepSpec.input` for this operation. */
  inputSchema: object;
  /** JSON Pointers within `input` that carry secret-bearing values, tagged before dispatch (§4.5, §6.4). */
  secretBearingInputFields: JsonPointer[];
  outputRawCategory: RawOutputCategory;
  /** Semantic projector this operation's raw observation is routed through (§6.3). Matches "<id>@<version>". */
  projectorId: StableId;
  idempotency: OperationIdempotency;
  /** Atomic capability IDs required to execute this operation at all (§2.8). */
  capabilitiesRequired: StableId[];
}

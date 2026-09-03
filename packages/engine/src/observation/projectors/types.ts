import type { RawObservation, SemanticObservation } from "@supadiff/spec";

/**
 * A semantic projector is a pure function from a redacted raw observation to typed
 * semantic facts (§6.3). It MUST NOT query the target, access another target's result,
 * or use anything but `raw` and static operation metadata.
 */
export type Projector = (raw: RawObservation) => SemanticObservation;

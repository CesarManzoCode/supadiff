/** Exit code contract (§14.4). */
export const EXIT_OK = 0;
export const EXIT_BEHAVIORAL_POLICY_VIOLATION = 10;
export const EXIT_INCONCLUSIVE = 20;
export const EXIT_INVALID = 30;
export const EXIT_SAFETY_REFUSAL = 40;
export const EXIT_INTERNAL_ERROR = 50;

export type FailOnClass = "known" | "new" | "inconclusive" | "cleanup" | "unsupported";

export const DEFAULT_FAIL_ON: FailOnClass[] = ["new", "inconclusive", "cleanup"];

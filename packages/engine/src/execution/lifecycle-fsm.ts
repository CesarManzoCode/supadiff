import type { TargetLifecycleState } from "@supadiff/spec";

/** Allowed edges for the per-session provisioning lifecycle (§4.2). */
const ALLOWED_TRANSITIONS: Record<TargetLifecycleState, TargetLifecycleState[]> = {
  declared: ["preflighted"],
  preflighted: ["allocating"],
  allocating: ["provisioned", "recovering"],
  provisioned: ["identified", "recovering"],
  identified: ["capability-probed", "recovering"],
  "capability-probed": ["ready", "recovering"],
  ready: ["executing", "recovering"],
  executing: ["quiescing", "recovering"],
  quiescing: ["tearing-down", "recovering"],
  "tearing-down": ["closed", "leaked", "recovering"],
  closed: [],
  recovering: ["closed", "leaked"],
  leaked: [],
};

export class InvalidLifecycleTransitionError extends Error {
  constructor(from: TargetLifecycleState, to: TargetLifecycleState) {
    super(`illegal target lifecycle transition: "${from}" -> "${to}" (§4.2)`);
    this.name = "InvalidLifecycleTransitionError";
  }
}

export interface LifecycleTransitionRecord {
  sequence: number;
  from: TargetLifecycleState;
  to: TargetLifecycleState;
  at: string;
  reason: string;
}

/** Per-target-slot lifecycle journal enforcing §4.2's allowed edges. */
export class TargetLifecycleFsm {
  #state: TargetLifecycleState = "declared";
  #transitions: LifecycleTransitionRecord[] = [];
  #clock: () => string;

  constructor(clock: () => string) {
    this.#clock = clock;
  }

  get state(): TargetLifecycleState {
    return this.#state;
  }

  get transitions(): readonly LifecycleTransitionRecord[] {
    return this.#transitions;
  }

  transition(to: TargetLifecycleState, reason: string): void {
    const allowed = ALLOWED_TRANSITIONS[this.#state];
    if (!allowed.includes(to)) {
      throw new InvalidLifecycleTransitionError(this.#state, to);
    }
    this.#transitions.push({
      sequence: this.#transitions.length,
      from: this.#state,
      to,
      at: this.#clock(),
      reason,
    });
    this.#state = to;
  }
}

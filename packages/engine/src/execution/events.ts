import type { IsoDateTime, StableId } from "@supadiff/spec";
import type { TargetLifecycleState } from "@supadiff/spec";

export type StepExecutionStatus =
  | "executed"
  | "skipped-requirement"
  | "blocked-dependency"
  | "unsupported-at-runtime"
  | "timed-out"
  | "cancelled"
  | "target-lost"
  | "harness-error";

export type RunEvent =
  | { kind: "run-started"; seq: number; at: IsoDateTime; runId: StableId; targetSlot: StableId }
  | {
      kind: "target-lifecycle-transition";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      from: TargetLifecycleState;
      to: TargetLifecycleState;
      reason: string;
    }
  | { kind: "actor-opened"; seq: number; at: IsoDateTime; targetSlot: StableId; actorId: StableId }
  | {
      kind: "step-started";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      stepId: StableId;
      attempt: number;
    }
  | {
      kind: "step-finished";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      stepId: StableId;
      attempt: number;
      status: StepExecutionStatus;
    }
  | {
      kind: "observer-finished";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      stepId: StableId;
      observationId: StableId;
    }
  | {
      kind: "cleanup-started";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      cleanupId: StableId;
    }
  | {
      kind: "cleanup-finished";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      cleanupId: StableId;
      ok: boolean;
    }
  | {
      kind: "teardown-finished";
      seq: number;
      at: IsoDateTime;
      targetSlot: StableId;
      status: string;
    }
  | {
      kind: "run-finished";
      seq: number;
      at: IsoDateTime;
      runId: StableId;
      targetSlot: StableId;
      state: string;
    };

/** Distributes `Omit` over each member of the `RunEvent` union so per-variant fields survive. */
export type NewRunEvent = {
  [K in RunEvent["kind"]]: Omit<Extract<RunEvent, { kind: K }>, "seq" | "at">;
}[RunEvent["kind"]];

export class EventLog {
  #events: RunEvent[] = [];
  #seq = 0;
  #clock: () => IsoDateTime;

  constructor(clock: () => IsoDateTime) {
    this.#clock = clock;
  }

  push(event: NewRunEvent): RunEvent {
    const full = { ...event, seq: this.#seq++, at: this.#clock() } as RunEvent;
    this.#events.push(full);
    return full;
  }

  all(): readonly RunEvent[] {
    return this.#events;
  }
}

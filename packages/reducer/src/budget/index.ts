export interface ReductionBudget {
  maxWallTimeMs: number;
  maxCandidateExecutions: number;
  maxUnchangedPasses: number;
}

export const DEFAULT_BUDGET: ReductionBudget = {
  maxWallTimeMs: 5 * 60 * 1000,
  maxCandidateExecutions: 200,
  maxUnchangedPasses: 3,
};

export class BudgetTracker {
  #startedAt = Date.now();
  #candidateExecutions = 0;
  #unchangedPasses = 0;
  #budget: ReductionBudget;

  constructor(budget: ReductionBudget = DEFAULT_BUDGET) {
    this.#budget = budget;
  }

  get candidateExecutions(): number {
    return this.#candidateExecutions;
  }

  recordCandidateExecution(): void {
    this.#candidateExecutions++;
  }

  recordPassOutcome(changed: boolean): void {
    this.#unchangedPasses = changed ? 0 : this.#unchangedPasses + 1;
  }

  exhausted(): boolean {
    if (Date.now() - this.#startedAt >= this.#budget.maxWallTimeMs) return true;
    if (this.#candidateExecutions >= this.#budget.maxCandidateExecutions) return true;
    return false;
  }

  fixedPoint(): boolean {
    return this.#unchangedPasses >= this.#budget.maxUnchangedPasses;
  }
}

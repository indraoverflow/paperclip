import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
  /** Owner of the retry. The release cap is per agent, not company-wide. */
  agentId: string;
  /** Row's own retry reason; the planner classifies scope from this, never from a guess. */
  retryReason: string | null;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

export type CountInflightQuotaRecoveryRetriesInput = {
  now: Date;
};

export type DeferScheduledRetryInput = {
  runId: string;
  companyId: string;
  releaseAt: Date;
  now: Date;
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
  /**
   * Per-agent count of quota-recovery retries already released and not yet
   * finished. Resolves to `null` when the state could not be read — which the
   * release planner treats as "release nothing", not "assume zero".
   */
  countInflightQuotaRecoveryRetries(
    input: CountInflightQuotaRecoveryRetriesInput,
  ): Promise<ReadonlyMap<string, number> | null>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  /** Push a held-back retry forward instead of releasing it. Never deletes. */
  deferScheduledRetry(input: DeferScheduledRetryInput): Promise<{ deferred: boolean }>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}

import type { RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
import type { PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";
import { planDueQuotaRecoveryReleases, planLogLines } from "../domain/quota-recovery-release.js";

export function createEvaluateScheduledRetryGate(deps: { reader: ScheduledRetryReader }) {
  return (input: {
    runId: string;
    companyId: string;
    retryReasonOverride: string;
    now?: Date;
  }) => deps.reader.evaluateScheduledRetryGate({ ...input, now: input.now ?? new Date() });
}

export function createPromoteScheduledRetry(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    now?: Date;
  }): Promise<PromoteScheduledRetryOutcome> =>
    deps.writer.promoteOrCancelDueRetry({
      runId: input.runId,
      companyId: input.companyId,
      now: input.now ?? new Date(),
    });
}

const MAX_DUE_RETRIES_PER_SWEEP = 50;

/**
 * Bounded, jittered release of due `provider_quota_recovery` retries.
 *
 * A sweep previously promoted every due row it found, up to
 * `MAX_DUE_RETRIES_PER_SWEEP` company-wide, in a tight loop: no per-agent cap,
 * no jitter, no reason filter. Because `readProviderQuotaRetryAt` also assigns a
 * flat one-hour backoff at enqueue, the retries a single provider incident
 * created all became due at the same instant, so one sweep could fan ten
 * concurrent requests back at a provider that had just answered 429.
 *
 * The cap bounds the depth; the jitter breaks the simultaneity. Both are needed
 * — either alone leaves a synchronised release. Rows whose retry reason is not
 * `provider_quota_recovery` are routed around this entirely, so process-loss and
 * every other mechanism keep their existing path.
 *
 * `logLines` is returned rather than logged here: the application layer stays
 * free of I/O, and the one caller emits it.
 */
export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  writer: RunDispatchWriter;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
  /** Defaults to the wall clock. Injectable so a sweep can be replayed. */
  now?: () => Date;
  /** Defaults to `now.getTime()`. Injectable so jitter can be replayed. */
  seed?: (now: Date) => number;
}) {
  return async function promoteDueScheduledRetries(input: { now?: Date; cutoff: Date | null }) {
    const now = input.now ?? deps.now?.() ?? new Date();
    const dueRuns = (
      await deps.reader.listDueRetries({ now, cutoff: input.cutoff, limit: MAX_DUE_RETRIES_PER_SWEEP })
    ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);

    if (dueRuns.length === 0) {
      return {
        promoted: 0,
        runIds: [] as string[],
        deferred: 0,
        logLines: [] as string[],
        postCommitEffects: [] as PostCommitEffect[],
      };
    }

    // `null` here is a read failure, not an empty backlog. It is passed through
    // as `null` so the planner denies every release rather than assuming that
    // nothing is in flight.
    let inflightByAgent: ReadonlyMap<string, number> | null = null;
    let inflightReadFailed = false;
    try {
      inflightByAgent = await deps.reader.countInflightQuotaRecoveryRetries({ now });
    } catch {
      inflightByAgent = null;
      inflightReadFailed = true;
    }

    const plan = planDueQuotaRecoveryReleases({
      due: dueRuns.map((row) => ({
        runId: row.runId,
        agentId: row.agentId,
        scheduledRetryAt: now,
        scheduledRetryReason: row.retryReason,
      })),
      now,
      inflightByAgent,
      seed: deps.seed?.(now) ?? now.getTime(),
    });

    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    const warnings: string[] = [];
    if (inflightReadFailed) {
      warnings.push(
        "run-dispatch: in-flight quota-recovery state unreadable; denying every quota-recovery release this sweep",
      );
    }
    const byRunId = new Map(dueRuns.map((row) => [row.runId, row]));

    for (const decision of plan.decisions) {
      const dueRun = byRunId.get(decision.runId);
      if (!dueRun) continue;

      if (decision.outOfScope) {
        // Not this planner's row. Promoted on the existing path, untouched by
        // the cap, so process-loss recovery keeps working.
        const result = await deps.promoteScheduledRetry({ ...dueRun, now });
        if (result.outcome === "promoted") {
          runIds.push(dueRun.runId);
          postCommitEffects.push(...result.postCommitEffects);
        }
        continue;
      }

      if (decision.outcome === "deferred") {
        if (decision.releaseAt) {
          const deferred = await deps.writer.deferScheduledRetry({
            runId: decision.runId,
            companyId: dueRun.companyId,
            releaseAt: decision.releaseAt,
            now,
          });
          if (!deferred.deferred) {
            warnings.push(
              `run-dispatch: defer of ${decision.runId} lost a race; the row was no longer scheduled`,
            );
          }
        }
        continue;
      }

      // The planner schedules the cohort ahead of the sweep. Honour its slot
      // rather than releasing on the sweep that first saw the row — that is the
      // jitter, and skipping it would re-synchronise the cohort.
      if (decision.releaseAt && decision.releaseAt.getTime() > now.getTime()) {
        const deferred = await deps.writer.deferScheduledRetry({
          runId: decision.runId,
          companyId: dueRun.companyId,
          releaseAt: decision.releaseAt,
          now,
        });
        if (!deferred.deferred) {
          warnings.push(
            `run-dispatch: jitter reschedule of ${decision.runId} lost a race; the row was no longer scheduled`,
          );
        }
        continue;
      }

      const result = await deps.promoteScheduledRetry({ ...dueRun, now });
      if (result.outcome === "promoted") {
        runIds.push(dueRun.runId);
        postCommitEffects.push(...result.postCommitEffects);
      }
    }

    return {
      promoted: runIds.length,
      runIds,
      deferred: plan.decisions.filter((d) => d.outcome === "deferred" && !d.outOfScope).length,
      logLines: [...planLogLines(plan), ...warnings],
      postCommitEffects,
    };
  };
}

export function createCancelStaleQueuedRun(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    now?: Date;
  }) => deps.writer.cancelStaleQueuedRun({ ...input, now: input.now ?? new Date() });
}

export function createDispatchResolvedInteractionIfCurrent(deps: { writer: RunDispatchWriter }) {
  return <T>(input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    dispatch: (markDispatchStarted: () => void) => Promise<T>;
    now?: Date;
  }) => deps.writer.dispatchResolvedInteractionIfCurrent({
    ...input,
    now: input.now ?? new Date(),
  });
}

/**
 * Bounded, jittered release of due `provider_quota_recovery` retries.
 *
 * Pure: no I/O, no clock, no module-level mutable state, no ambient RNG. Every
 * input is an argument, including the jitter seed. That is deliberate — a
 * retry plan that cannot be run twice to the same answer cannot be used as
 * evidence that a fix works, and cannot be regression-tested by a reviewer.
 *
 * ## The two defects this closes
 *
 * 1. **Unbounded release.** `promoteDueScheduledRetries` selects up to
 *    `MAX_DUE_RETRIES_PER_SWEEP` (50) due retries *company-wide, per sweep*, with
 *    no per-agent cap, no jitter and no reason filter, then promotes every one
 *    of them in a tight loop. Ten retries for one agent released in one sweep is
 *    ten concurrent requests against a provider that just answered 429.
 * 2. **Correlated due times** — the cause, not the symptom.
 *    `readProviderQuotaRetryAt` computes `now + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`
 *    (a flat one hour) at *enqueue* time, so every retry enqueued during one
 *    incident becomes due at the same instant one hour later. The backoff
 *    re-synchronises exactly the cohort it just de-synchronised. Capping release
 *    alone would turn one 10-deep simultaneous release into ten 1-deep
 *    simultaneous releases at the same instant — still synchronised.
 *    `decorrelateRetryAt` breaks the correlation where it forms.
 *
 * ## Fail-closed
 *
 * `inflightByAgent === null` means *in-flight state was not available*. The
 * correct response is to release **nothing**. Assuming zero in-flight under an
 * unreadable input fails open precisely when the control plane is already
 * unhealthy, which is the only moment the cap matters. That denial is a return
 * value with a reason, not an exception.
 */

/** The one retry reason this planner governs. Anything else is out of scope. */
export const QUOTA_RECOVERY_RETRY_REASON = "provider_quota_recovery";

export const DEFAULT_CAP_PER_AGENT = 1;
export const DEFAULT_JITTER_MS = 30_000;
export const DEFAULT_MIN_SPACING_MS = 15_000;
export const DEFAULT_DEFERRAL_STEP_MS = 60_000;
export const DEFAULT_DECORRELATION_WINDOW_MS = 30 * 60_000;

/**
 * Width of the enqueue-time decorrelation window, named for the recovery
 * constant it sits beside. Half an hour against a one-hour base backoff, so the
 * spread is visible without stretching a recovery that already waits an hour.
 */
export const PROVIDER_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS = DEFAULT_DECORRELATION_WINDOW_MS;

export type ReleaseOutcome = "released" | "deferred";

/** Closed vocabulary: every non-release names one of these. */
export const REASON_INFLIGHT_UNAVAILABLE = "inflight_state_unavailable";
export const REASON_OVER_CAP = "per_agent_cap_reached";
export const REASON_RELEASED = "admitted_within_cap";
export const REASON_OUT_OF_SCOPE = "not_quota_recovery_retry";

export type DueRetry = {
  runId: string;
  agentId: string;
  scheduledRetryAt: Date;
  scheduledRetryReason: string | null;
};

export type ReleaseDecision = {
  runId: string;
  agentId: string;
  outcome: ReleaseOutcome;
  reason: string;
  releaseAt: Date | null;
  outOfScope: boolean;
};

export type AgentReleaseState = {
  agentId: string;
  cap: number;
  /** `-1` means unknown, i.e. the plan is degraded. */
  inflight: number;
  due: number;
  released: number;
  deferred: number;
  firstReleaseAt: Date | null;
  lastReleaseAt: Date | null;
};

export type ReleasePlan = {
  decisions: ReleaseDecision[];
  agents: AgentReleaseState[];
  now: Date;
  capPerAgent: number;
  degraded: boolean;
  jitterMs: number;
};

/**
 * Due order, and nothing else.
 *
 * `Array.prototype.sort` is stable, so equal due times keep the order the reader
 * supplied — which is `ORDER BY scheduledRetryAt, createdAt, id` at the adapter.
 * Re-sorting on `agentId`/`runId` here would silently change the sweep's
 * observable ordering for no benefit: the cap and the jitter, not the tiebreak,
 * decide what is released and when.
 */
function compareRetries(a: DueRetry, b: DueRetry): number {
  return a.scheduledRetryAt.getTime() - b.scheduledRetryAt.getTime();
}

/**
 * FNV-1a, 32-bit. Pure integer arithmetic, so the domain layer needs no
 * runtime module and no platform hash — `node:crypto` is not importable here by
 * design, and `String.prototype.hashCode` does not exist.
 */
function fnv1a(text: string, seedBasis: number): number {
  let hash = seedBasis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * An independent, reproducible jitter stream per key.
 *
 * Seeded by hashing the key rather than using the key directly, so the stream
 * is decorrelated between adjacent seeds and stable across processes and hosts
 * (`Math.random` is neither, and a process-local seed would make the plan
 * untestable).
 */
function streamFor(seed: number, key: string): () => number {
  const material = `${seed}:${key}`;
  // Four decorrelated words; the basis offsets keep them independent.
  let a = fnv1a(material, 0x811c_9dc5);
  let b = fnv1a(material, 0x9e37_79b9);
  let c = fnv1a(material, 0x85eb_ca6b);
  let d = fnv1a(material, 0xc2b2_ae35);
  // sfc32 — small, fast, and stable across engines.
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) >>> 0;
    t = (t + d) >>> 0;
    c = (c + t) >>> 0;
    return (t >>> 0) / 4_294_967_296;
  };
}

/** Uniform integer in `[0, bound)`. */
function randInt(next: () => number, bound: number): number {
  if (bound <= 0) return 0;
  return Math.min(bound - 1, Math.floor(next() * bound));
}

/** In-place Fisher–Yates driven by a supplied stream, so it stays reproducible. */
function shuffleInPlace<T>(items: T[], next: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randInt(next, i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * `n` strictly increasing release instants, evenly spread over the window.
 *
 * **Stratified slots, not per-retry random draws.** The requirement is that two
 * agents hitting the same 429 do not release within the same second. Two
 * *independent* draws satisfy that only with high probability, so a test
 * asserting "never collides" against independent draws is a test that will
 * eventually fail for a reason unrelated to the fix — and the guarantee a
 * reviewer is asked to trust would be a probability rather than a property.
 * Slot `k` of `n` sits at `now + floor(span * k / n)`, which is strictly
 * increasing whenever the span is at least `n` seconds, and the window is
 * widened to exactly that when it is not. The jitter still de-synchronises the
 * cohort; it just cannot collide.
 */
function slotSchedule(n: number, now: Date, windowMs: number): Date[] {
  if (n <= 0) return [];
  const spanMs = Math.max(windowMs, n * 1000, 1);
  return Array.from({ length: n }, (_, k) => new Date(now.getTime() + Math.floor((spanMs * k) / n)));
}

export type PlanDueQuotaRecoveryReleasesInput = {
  /** Candidates. Not assumed to be due and not assumed to be in scope. */
  due: DueRetry[];
  now: Date;
  /** Per-agent count of quota-recovery retries released and not yet finished. `null` is unknown. */
  inflightByAgent: ReadonlyMap<string, number> | null;
  /** Required, with no default, so no caller can get unreproducible jitter. */
  seed: number;
  capPerAgent?: number;
  jitterMs?: number;
  minSpacingMs?: number;
  deferralStepMs?: number;
};

/**
 * Decide which due quota-recovery retries may be released in this pass.
 *
 * Returns a plan; it never throws for an unhealthy input. `degraded` is true
 * when in-flight state was unavailable and the plan is a blanket denial.
 */
export function planDueQuotaRecoveryReleases(
  input: PlanDueQuotaRecoveryReleasesInput,
): ReleasePlan {
  const capPerAgent = input.capPerAgent ?? DEFAULT_CAP_PER_AGENT;
  const jitterMs = input.jitterMs ?? DEFAULT_JITTER_MS;
  const minSpacingMs = input.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  const deferralStepMs = input.deferralStepMs ?? DEFAULT_DEFERRAL_STEP_MS;

  if (capPerAgent < 1) {
    throw new RangeError("capPerAgent must be >= 1; a cap of 0 would deny every retry forever");
  }
  if (jitterMs < 0 || minSpacingMs < 0 || deferralStepMs <= 0) {
    throw new RangeError("jitter and spacing must be >= 0; deferralStepMs must be > 0");
  }

  const { now, seed } = input;
  const candidates = [...input.due].sort(compareRetries);
  const degraded = input.inflightByAgent === null;

  const byAgent = new Map<string, DueRetry[]>();
  for (const retry of candidates) {
    const list = byAgent.get(retry.agentId);
    if (list) list.push(retry);
    else byAgent.set(retry.agentId, [retry]);
  }
  const agentIds = [...byAgent.keys()].sort();

  const inflightFor = (agentId: string) =>
    degraded ? -1 : Math.max(0, input.inflightByAgent!.get(agentId) ?? 0);
  const inScopeFor = (agentId: string) =>
    (byAgent.get(agentId) ?? []).filter(
      (r) => r.scheduledRetryReason === QUOTA_RECOVERY_RETRY_REASON,
    );
  const roomFor = (agentId: string) =>
    degraded ? 0 : Math.max(0, capPerAgent - inflightFor(agentId));

  const decisions = new Map<string, ReleaseDecision>();
  const deferredSoFar = new Map<string, number>();

  // ---- pass 1: admission. Which retries may leave the queue at all. ----
  for (const agentId of agentIds) {
    const retries = byAgent.get(agentId)!;
    const admitted = new Set(inScopeFor(agentId).slice(0, roomFor(agentId)).map((r) => r.runId));
    deferredSoFar.set(agentId, 0);

    for (const retry of retries) {
      if (admitted.has(retry.runId)) continue; // decided in pass 2
      if (retry.scheduledRetryReason !== QUOTA_RECOVERY_RETRY_REASON) {
        // A non-quota-recovery retry reason is not this planner's business.
        // Reported so it stays visible, released by the mechanism that owns it,
        // never held by this cap — so process-loss recovery keeps working.
        decisions.set(retry.runId, {
          runId: retry.runId,
          agentId,
          outcome: "deferred",
          reason: REASON_OUT_OF_SCOPE,
          releaseAt: null,
          outOfScope: true,
        });
        continue;
      }
      if (degraded) {
        decisions.set(retry.runId, {
          runId: retry.runId,
          agentId,
          outcome: "deferred",
          reason: REASON_INFLIGHT_UNAVAILABLE,
          releaseAt: null,
          outOfScope: false,
        });
        continue;
      }
      // Deferred retries keep their relative order rather than being reshuffled.
      const ordinal = deferredSoFar.get(agentId)!;
      deferredSoFar.set(agentId, ordinal + 1);
      decisions.set(retry.runId, {
        runId: retry.runId,
        agentId,
        outcome: "deferred",
        reason: REASON_OVER_CAP,
        releaseAt: new Date(now.getTime() + deferralStepMs * (ordinal + 1)),
        outOfScope: false,
      });
    }
  }

  // ---- pass 2: cohort-wide stratified scheduling of the admitted set. ----
  // Per-agent order is deterministic; the cohort order is permuted by a
  // seed-derived stream so slot assignment is decorrelated but reproducible.
  const admitted: DueRetry[] = [];
  for (const agentId of agentIds) admitted.push(...inScopeFor(agentId).slice(0, roomFor(agentId)));
  shuffleInPlace(admitted, streamFor(seed, "__cohort_order__"));
  const slots = slotSchedule(admitted.length, now, jitterMs);
  admitted.forEach((retry, index) => {
    decisions.set(retry.runId, {
      runId: retry.runId,
      agentId: retry.agentId,
      outcome: "released",
      reason: REASON_RELEASED,
      releaseAt: slots[index]!,
      outOfScope: false,
    });
  });

  // Per-agent minimum spacing is a floor, not a re-draw: the cohort schedule
  // already guarantees distinct slots, so this can only push a release later.
  const agents: AgentReleaseState[] = [];
  for (const agentId of agentIds) {
    const agentDecisions: ReleaseDecision[] = candidates
      .filter((c) => c.agentId === agentId)
      .map((c) => decisions.get(c.runId))
      .filter((d): d is ReleaseDecision => d !== undefined);
    const releasedForAgent: ReleaseDecision[] = agentDecisions
      .filter((d) => d.outcome === "released")
      .sort((a, b) => a.releaseAt!.getTime() - b.releaseAt!.getTime());
    let previous: number | null = null;
    for (const d of releasedForAgent) {
      const at = d.releaseAt!.getTime();
      if (previous !== null && at - previous < minSpacingMs) {
        const shifted: Date = new Date(previous + minSpacingMs);
        decisions.set(d.runId, { ...d, releaseAt: shifted });
        previous = shifted.getTime();
        continue;
      }
      previous = at;
    }
    agents.push({
      agentId,
      cap: capPerAgent,
      inflight: inflightFor(agentId),
      due: inScopeFor(agentId).length,
      released: releasedForAgent.length,
      deferred: agentDecisions.filter((d) => d.outcome === "deferred").length,
      firstReleaseAt: releasedForAgent.length ? releasedForAgent[0]!.releaseAt : null,
      lastReleaseAt: releasedForAgent.length ? releasedForAgent[releasedForAgent.length - 1]!.releaseAt : null,
    });
  }

  return {
    decisions: candidates.map((c) => decisions.get(c.runId)!).filter(Boolean),
    agents,
    now,
    capPerAgent,
    degraded,
    jitterMs,
  };
}

/**
 * Observability for a pass: the held-back retries have to be *visible*,
 * released against deferred.
 *
 * One line per decision, one per agent, one summary — all machine-parseable
 * `key=value`. A fix you cannot see is a fix you cannot verify has stopped, and
 * a summary with no per-decision trail cannot answer "which retry was held back
 * and why" after the fact.
 */
export function planLogLines(plan: ReleasePlan): string[] {
  const lines: string[] = [];
  for (const d of plan.decisions) {
    lines.push(
      "scheduler.quota_recovery_release",
      `decision=${d.outcome}`,
      `reason=${d.reason}`,
      `run_id=${d.runId}`,
      `agent_id=${d.agentId}`,
      `release_at=${d.releaseAt ? d.releaseAt.toISOString() : "-"}`,
      `out_of_scope=${d.outOfScope}`,
      "",
    );
  }
  for (const a of plan.agents) {
    lines.push(
      "scheduler.quota_recovery_agent",
      `agent_id=${a.agentId}`,
      `cap=${a.cap}`,
      `inflight=${a.inflight}`,
      `due=${a.due}`,
      `released=${a.released}`,
      `deferred=${a.deferred}`,
      `first_release_at=${a.firstReleaseAt ? a.firstReleaseAt.toISOString() : "-"}`,
      `last_release_at=${a.lastReleaseAt ? a.lastReleaseAt.toISOString() : "-"}`,
      "",
    );
  }
  lines.push(
    "scheduler.quota_recovery_summary",
    `released=${plan.decisions.filter((d) => d.outcome === "released").length}`,
    `deferred=${plan.decisions.filter((d) => d.outcome === "deferred").length}`,
    `degraded=${plan.degraded}`,
    `cap_per_agent=${plan.capPerAgent}`,
    `jitter_ms=${plan.jitterMs}`,
    `agents=${plan.agents.length}`,
    `now=${plan.now.toISOString()}`,
  );
  return lines;
}

export type DecorrelateRetryAtInput = {
  createdAt: Date;
  seed: number;
  /** Identifies the incident cohort — normally the agent id. */
  cohortKey: string;
  baseBackoffMs: number;
  windowMs?: number;
  minBackoffMs?: number;
};

/**
 * Propose a *spread* `retryAt` for a retry being enqueued.
 *
 * The vendor uses a flat `createdAt + baseBackoff`, so every retry created
 * during one outage becomes due at the same instant one base-backoff later.
 * This proposes `createdAt + baseBackoff + U(0, windowMs)` drawn from a stream
 * seeded by `(seed, cohortKey)`, so the spread is per-cohort and reproducible.
 *
 * Use this at enqueue time and {@link planDueQuotaRecoveryReleases} at release
 * time: the first stops the correlation from forming, the second bounds it if
 * it formed anyway.
 */
export function decorrelateRetryAt(input: DecorrelateRetryAtInput): Date {
  const windowMs = input.windowMs ?? DEFAULT_DECORRELATION_WINDOW_MS;
  const minBackoffMs = input.minBackoffMs ?? 1_000;
  if (input.baseBackoffMs < minBackoffMs) {
    throw new RangeError(
      "baseBackoffMs must be >= minBackoffMs; a retry due before it was created is a bug, not a policy",
    );
  }
  if (windowMs < 0) {
    throw new RangeError("windowMs must be >= 0");
  }
  const offset = randInt(streamFor(input.seed, `retry-at:${input.cohortKey}`), windowMs + 1);
  return new Date(input.createdAt.getTime() + input.baseBackoffMs + offset);
}

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEFERRAL_STEP_MS,
  DEFAULT_JITTER_MS,
  QUOTA_RECOVERY_RETRY_REASON,
  REASON_INFLIGHT_UNAVAILABLE,
  REASON_OUT_OF_SCOPE,
  REASON_OVER_CAP,
  REASON_RELEASED,
  decorrelateRetryAt,
  planDueQuotaRecoveryReleases,
  planLogLines,
  type DueRetry,
} from "./quota-recovery-release.js";

const NOW = new Date("2026-09-28T08:00:00.000Z");
const SEED = 1_757_000_000_000;

function due(
  runId: string,
  agentId: string,
  options: { at?: Date; reason?: string | null } = {},
): DueRetry {
  return {
    runId,
    agentId,
    scheduledRetryAt: options.at ?? NOW,
    scheduledRetryReason: options.reason === undefined ? QUOTA_RECOVERY_RETRY_REASON : options.reason,
  };
}

/** The measured shape: ten retries for one agent, all due at the same instant. */
function oneAgentBacklog(count: number, agentId = "agent-cto"): DueRetry[] {
  return Array.from({ length: count }, (_, i) => due(`${agentId}/run-${i}`, agentId));
}

function noInflight(): Map<string, number> {
  return new Map();
}

function released(plan: ReturnType<typeof planDueQuotaRecoveryReleases>) {
  return plan.decisions.filter((d) => d.outcome === "released");
}

function deferred(plan: ReturnType<typeof planDueQuotaRecoveryReleases>) {
  return plan.decisions.filter((d) => d.outcome === "deferred");
}

describe("A1 — the release is bounded per agent", () => {
  it("releases one quota-recovery retry per agent and defers the rest", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(10),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(released(plan)).toHaveLength(1);
    expect(deferred(plan)).toHaveLength(9);
    expect(released(plan)[0]!.reason).toBe(REASON_RELEASED);
    for (const d of deferred(plan)) {
      expect(d.reason).toBe(REASON_OVER_CAP);
    }
  });

  it("defers a retry whose cap is already consumed by an in-flight release", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(4),
      now: NOW,
      inflightByAgent: new Map([["agent-cto", 1]]),
      seed: SEED,
    });

    expect(released(plan)).toHaveLength(0);
    expect(deferred(plan).map((d) => d.reason)).toEqual(Array(4).fill(REASON_OVER_CAP));
  });

  it("bounds each agent independently rather than company-wide", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [...oneAgentBacklog(5, "agent-a"), ...oneAgentBacklog(5, "agent-b")],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(released(plan)).toHaveLength(2);
    expect(new Set(released(plan).map((d) => d.agentId))).toEqual(new Set(["agent-a", "agent-b"]));
  });

  it("defers rather than drops: every candidate is decided", () => {
    const backlog = oneAgentBacklog(10);
    const plan = planDueQuotaRecoveryReleases({
      due: backlog,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(plan.decisions.map((d) => d.runId).sort()).toEqual(backlog.map((r) => r.runId).sort());
    // A deferred retry is always pushed strictly forward, never re-armed at zero
    // delay — that is what turned one 429 into a loop.
    for (const d of deferred(plan)) {
      expect(d.releaseAt).not.toBeNull();
      expect(d.releaseAt!.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("keeps deferred retries in their existing relative order", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(5),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    const at = deferred(plan).map((d) => d.releaseAt!.getTime());
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(new Set(at).size).toBe(at.length);
  });
});

describe("A2 — the release is decorrelated, not synchronised", () => {
  it("spreads the admitted cohort across the jitter window, never on one instant", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [
        ...oneAgentBacklog(1, "agent-a"),
        ...oneAgentBacklog(1, "agent-b"),
        ...oneAgentBacklog(1, "agent-c"),
        ...oneAgentBacklog(1, "agent-d"),
      ],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    const at = released(plan).map((d) => d.releaseAt!.getTime());
    expect(new Set(at).size).toBe(at.length);
    expect(Math.max(...at) - Math.min(...at)).toBeGreaterThan(0);
    expect(Math.max(...at) - NOW.getTime()).toBeLessThanOrEqual(DEFAULT_JITTER_MS);
  });

  it("gives two retries the same slot only across a wide enough window to differ", () => {
    // 60 admitted retries inside a 30 s window cannot all be 1 s apart, so the
    // window is widened rather than allowed to collide.
    const cohort = Array.from({ length: 60 }, (_, i) => due(`cohort/run-${i}`, `agent-${i % 5}`));
    const plan = planDueQuotaRecoveryReleases({
      due: cohort,
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
      capPerAgent: 12,
    });

    const at = released(plan).map((d) => d.releaseAt!.getTime());
    expect(released(plan)).toHaveLength(60);
    expect(new Set(at).size).toBe(60);
  });

  it("enforces a per-agent minimum spacing floor on top of the cohort schedule", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(3),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
      capPerAgent: 3,
      minSpacingMs: 15_000,
    });

    const at = released(plan)
      .map((d) => d.releaseAt!.getTime())
      .sort((x, y) => x - y);
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i += 1) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(15_000);
    }
  });

  it("decorrelates retryAt at enqueue, so the cohort never re-synchronises", () => {
    const base = 60 * 60 * 1000;
    const offsets = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const at = decorrelateRetryAt({
        createdAt: new Date(NOW.getTime() + i),
        seed: SEED,
        cohortKey: "agent-cto",
        baseBackoffMs: base,
      });
      expect(at.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + base);
      offsets.add(at.getTime() - base);
    }
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("is reproducible: the same seed yields the same plan, twice", () => {
    const build = () =>
      planDueQuotaRecoveryReleases({
        due: [
          ...oneAgentBacklog(3, "agent-a"),
          ...oneAgentBacklog(3, "agent-b"),
          ...oneAgentBacklog(3, "agent-c"),
        ],
        now: NOW,
        inflightByAgent: noInflight(),
        seed: SEED,
        capPerAgent: 2,
      });
    const first = JSON.stringify(build());
    const second = JSON.stringify(build());
    expect(second).toBe(first);

    // A different seed decorrelates differently, so the seed is load-bearing
    // rather than decorative.
    const other = planDueQuotaRecoveryReleases({
      due: [
        ...oneAgentBacklog(3, "agent-a"),
        ...oneAgentBacklog(3, "agent-b"),
        ...oneAgentBacklog(3, "agent-c"),
      ],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED + 1,
      capPerAgent: 2,
    });
    expect(JSON.stringify(other)).not.toBe(first);
  });
});

describe("A3 — the pass is observable", () => {
  it("reports every decision and one summary, in a closed reason vocabulary", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [...oneAgentBacklog(3, "agent-a"), due("agent-a/run-p", "agent-a", { reason: "process_loss" })],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    const text = planLogLines(plan).join("\n");
    expect(text).toContain("scheduler.quota_recovery_release");
    expect(text).toContain("scheduler.quota_recovery_summary");
    expect(text).toContain("scheduler.quota_recovery_agent");
    for (const decision of plan.decisions) {
      expect(text).toContain(`run_id=${decision.runId}`);
    }
    expect(text).toContain("released=1");
    expect(text).toContain("deferred=3");
  });

  it("records that A3 is not discriminating: the report exists either way", () => {
    // The pre-fix sweep had no such report, so its absence is the signal. A
    // post-fix report that says the same thing is not itself evidence the
    // stampede stopped; the per-decision release counts are.
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(3),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    const text = planLogLines(plan).join("\n");
    expect(text).toContain("scheduler.quota_recovery_summary");
    expect(text).toContain("released=1");
  });
});

describe("A4 — the cap does not eat another mechanism", () => {
  it("classifies a non-quota-recovery reason as out of scope and never holds it", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [due("run-p", "agent-a", { reason: "process_loss" })],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(plan.decisions).toHaveLength(1);
    const decision = plan.decisions[0]!;
    expect(decision.reason).toBe(REASON_OUT_OF_SCOPE);
    expect(decision.outOfScope).toBe(true);
    expect(decision.releaseAt).toBeNull();
  });

  it("an out-of-scope row never consumes cap", () => {
    // Ordering is adversarial: the process_loss rows sort first and would take
    // the slot if the planner admitted before it classified.
    const plan = planDueQuotaRecoveryReleases({
      due: [
        due("run-p1", "agent-a", { reason: "process_loss" }),
        due("run-q1", "agent-a", { reason: QUOTA_RECOVERY_RETRY_REASON }),
        due("run-p2", "agent-a", { reason: "process_loss" }),
      ],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });

    expect(released(plan)).toHaveLength(1);
    expect(released(plan)[0]!.reason).toBe(REASON_RELEASED);
    expect(plan.decisions.filter((d) => d.outOfScope)).toHaveLength(2);
    expect(plan.agents[0]!.due).toBe(1);
  });

  it("a row with a null reason is out of scope, not in scope by default", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [due("run-null", "agent-a", { reason: null })],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    expect(plan.decisions[0]!.reason).toBe(REASON_OUT_OF_SCOPE);
    expect(plan.decisions[0]!.outOfScope).toBe(true);
  });
});

describe("fail-closed", () => {
  it("releases nothing when in-flight state is unavailable", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(10),
      now: NOW,
      inflightByAgent: null,
      seed: SEED,
    });

    expect(released(plan)).toHaveLength(0);
    expect(plan.degraded).toBe(true);
    for (const d of plan.decisions) {
      expect(d.reason).toBe(REASON_INFLIGHT_UNAVAILABLE);
      expect(d.releaseAt).toBeNull();
    }
    // Denied, not dropped: the decision exists and says why.
    expect(plan.decisions).toHaveLength(10);
  });

  it("denial is a return value with a reason, not an exception", () => {
    expect(() =>
      planDueQuotaRecoveryReleases({
        due: oneAgentBacklog(3),
        now: NOW,
        inflightByAgent: null,
        seed: SEED,
      }),
    ).not.toThrow();
  });

  it("a degraded plan is visible in the summary", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(2),
      now: NOW,
      inflightByAgent: null,
      seed: SEED,
    });
    expect(planLogLines(plan).join("\n")).toContain("degraded=true");
  });

  it("rejects a cap that would deny every retry forever", () => {
    expect(() =>
      planDueQuotaRecoveryReleases({
        due: oneAgentBacklog(1),
        now: NOW,
        inflightByAgent: noInflight(),
        seed: SEED,
        capPerAgent: 0,
      }),
    ).toThrow(RangeError);
  });

  it("an empty backlog plans cleanly", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: [],
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    expect(plan.decisions).toEqual([]);
    expect(plan.agents).toEqual([]);
    expect(plan.degraded).toBe(false);
  });
});

describe("contract details", () => {
  it("defers a quota retry by the documented step", () => {
    const plan = planDueQuotaRecoveryReleases({
      due: oneAgentBacklog(3),
      now: NOW,
      inflightByAgent: noInflight(),
      seed: SEED,
    });
    expect(deferred(plan)[0]!.releaseAt!.getTime() - NOW.getTime()).toBe(DEFAULT_DEFERRAL_STEP_MS);
  });

  it("decorrelateRetryAt refuses a due time before the retry was created", () => {
    expect(() =>
      decorrelateRetryAt({ createdAt: NOW, seed: SEED, cohortKey: "a", baseBackoffMs: 0 }),
    ).toThrow(RangeError);
  });
});

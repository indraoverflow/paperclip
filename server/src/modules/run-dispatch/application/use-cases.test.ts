import { describe, expect, it, vi } from "vitest";
import {
  createCancelStaleQueuedRun,
  createDispatchResolvedInteractionIfCurrent,
  createEvaluateScheduledRetryGate,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./use-cases.js";
import type {
  DeferScheduledRetryInput,
  DueRetryRun,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";

function fakeReader(
  dueRuns: DueRetryRun[] = [],
  overrides: Partial<ScheduledRetryReader> = {},
): ScheduledRetryReader & { evaluateCalls: unknown[]; inflightCalls: unknown[] } {
  const evaluateCalls: unknown[] = [];
  const inflightCalls: unknown[] = [];
  return {
    evaluateCalls,
    inflightCalls,
    async evaluateScheduledRetryGate(input) {
      evaluateCalls.push(input);
      return { allowed: true };
    },
    async listDueRetries() {
      return dueRuns;
    },
    async countInflightQuotaRecoveryRetries(input) {
      inflightCalls.push(input);
      return new Map();
    },
    ...overrides,
  };
}

function fakeWriter(overrides: Partial<RunDispatchWriter> = {}): RunDispatchWriter & {
  promoteCalls: unknown[];
  cancelCalls: unknown[];
  dispatchCalls: unknown[];
  deferCalls: DeferScheduledRetryInput[];
} {
  const promoteCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  const deferCalls: DeferScheduledRetryInput[] = [];
  return {
    promoteCalls,
    cancelCalls,
    dispatchCalls,
    deferCalls,
    async deferScheduledRetry(input) {
      deferCalls.push(input);
      return { deferred: true };
    },
    async promoteOrCancelDueRetry(input) {
      promoteCalls.push(input);
      return { outcome: "promoted", postCommitEffects: [] };
    },
    async cancelStaleQueuedRun(input) {
      cancelCalls.push(input);
      return { outcome: "not_stale" };
    },
    async dispatchResolvedInteractionIfCurrent(input) {
      dispatchCalls.push(input);
      return { dispatched: true, resultPromise: input.dispatch(() => {}) };
    },
    ...overrides,
  };
}

describe("createEvaluateScheduledRetryGate", () => {
  it("maps identifiers and a default clock onto the semantic reader operation", async () => {
    const reader = fakeReader();
    const before = Date.now();
    const result = await createEvaluateScheduledRetryGate({ reader })({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });

    expect(result).toEqual({ allowed: true });
    expect(reader.evaluateCalls).toHaveLength(1);
    const call = reader.evaluateCalls[0] as { now: Date };
    expect(call).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });
    expect(call.now.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("createPromoteScheduledRetry", () => {
  it("passes only semantic identifiers and the clock to the atomic operation", async () => {
    const writer = fakeWriter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
      now,
    });

    expect(result).toEqual({ outcome: "promoted", postCommitEffects: [] });
    expect(writer.promoteCalls).toEqual([{ runId: "run-1", companyId: "company-1", now }]);
  });

  it("passes a gate-suppressed outcome through without a persistence row", async () => {
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({
        outcome: "gate_suppressed" as const,
        reason: "agent paused",
        errorCode: "agent_not_invokable" as const,
      })),
    });
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
    });
    expect(result).toEqual({
      outcome: "gate_suppressed",
      reason: "agent paused",
      errorCode: "agent_not_invokable",
    });
  });
});

describe("createPromoteDueScheduledRetries", () => {
  const NOW = new Date("2026-09-28T08:00:00.000Z");

  function quotaBacklog(count: number, agentId: string): DueRetryRun[] {
    return Array.from({ length: count }, (_, i) => ({
      runId: `${agentId}/run-${i}`,
      companyId: "company-1",
      agentId,
      retryReason: "provider_quota_recovery",
    }));
  }

  function sweep(reader: ScheduledRetryReader, writer: RunDispatchWriter, seed = 42) {
    return createPromoteDueScheduledRetries({
      reader,
      writer,
      promoteScheduledRetry: createPromoteScheduledRetry({ writer }),
      seed: () => seed,
    })({ now: NOW, cutoff: null });
  }

  it("keeps due order and caps a sweep at 50 candidate rows", async () => {
    const dueRuns = Array.from({ length: 75 }, (_, i) => ({
      runId: `run-${i}`,
      companyId: "company-1",
      agentId: `agent-${i % 25}`,
      retryReason: "process_loss",
    }));
    const reader = fakeReader(dueRuns);
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    // Out-of-scope rows are promoted on the existing path, so the row cap still
    // bounds the sweep; only quota-recovery rows are subject to the new cap.
    expect(result.promoted).toBe(50);
    expect(result.runIds).toEqual(dueRuns.slice(0, 50).map(({ runId }) => runId));
  });

  it("releases one quota-recovery retry per agent instead of all of them", async () => {
    const reader = fakeReader(quotaBacklog(10, "agent-cto"));
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    // A lone admitted retry is slot 0 of 1, so it is not artificially delayed;
    // the cap is what bounds this sweep, and the other nine are pushed forward.
    expect(result.promoted).toBe(1);
    expect(result.deferred).toBe(9);
    expect(writer.promoteCalls).toHaveLength(1);
    expect(writer.deferCalls).toHaveLength(9);
    for (const call of writer.deferCalls) {
      expect(call.releaseAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("spreads a multi-agent cohort instead of releasing it at once", async () => {
    const reader = fakeReader([
      ...quotaBacklog(1, "agent-a"),
      ...quotaBacklog(1, "agent-b"),
      ...quotaBacklog(1, "agent-c"),
      ...quotaBacklog(1, "agent-d"),
    ]);
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    // Slot 0 lands on `now` and is promoted; the rest are pushed forward into
    // distinct slots, which is the actual de-synchronisation.
    const releaseAts = writer.deferCalls.map((c) => c.releaseAt.getTime());
    expect(result.promoted).toBe(1);
    expect(writer.deferCalls).toHaveLength(3);
    expect(new Set(releaseAts).size).toBe(3);
    for (const at of releaseAts) expect(at).toBeGreaterThan(NOW.getTime());
  });

  it("defers, never drops: every due row is either released or rescheduled", async () => {
    const backlog = quotaBacklog(10, "agent-cto");
    const writer = fakeWriter();
    await sweep(fakeReader(backlog), writer);

    const touched = new Set([
      ...writer.deferCalls.map((c) => c.runId),
      ...writer.promoteCalls.map((c) => (c as { runId: string }).runId),
    ]);
    expect(touched.size).toBe(backlog.length);
  });

  it("promotes a non-quota-recovery reason on the existing path, unheld", async () => {
    const reader = fakeReader([
      ...quotaBacklog(3, "agent-a"),
      { runId: "process/run-1", companyId: "company-1", agentId: "agent-a", retryReason: "process_loss" },
    ]);
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    // The process-loss row is promoted, never held; the quota rows still obey
    // the cap. The dangerous failure is a cap that silently eats a process-loss
    // retry, so this asserts the inverse shape.
    expect(result.runIds).toContain("process/run-1");
    expect(writer.deferCalls.map((c) => c.runId)).not.toContain("process/run-1");
    expect(result.logLines.join("\n")).toContain("reason=not_quota_recovery_retry");
  });

  it("fails closed when in-flight state cannot be read", async () => {
    const reader = fakeReader(quotaBacklog(10, "agent-cto"), {
      async countInflightQuotaRecoveryRetries() {
        return null;
      },
    });
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    expect(result.promoted).toBe(0);
    expect(result.deferred).toBe(10);
    expect(writer.promoteCalls).toHaveLength(0);
    expect(result.logLines.join("\n")).toContain("degraded=true");
  });

  it("fails closed when the in-flight read throws", async () => {
    const reader = fakeReader(quotaBacklog(3, "agent-cto"), {
      async countInflightQuotaRecoveryRetries() {
        throw new Error("connection reset");
      },
    });
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    expect(result.promoted).toBe(0);
    expect(result.logLines.join("\n")).toContain("unreadable");
  });

  it("counts an already-in-flight quota release against the cap", async () => {
    const reader = fakeReader(quotaBacklog(3, "agent-cto"), {
      async countInflightQuotaRecoveryRetries() {
        return new Map([["agent-cto", 1]]);
      },
    });
    const writer = fakeWriter();
    const result = await sweep(reader, writer);

    expect(result.promoted).toBe(0);
    expect(result.deferred).toBe(3);
    expect(result.logLines.join("\n")).toContain("reason=per_agent_cap_reached");
  });

  it("emits one summary line plus a line per decision", async () => {
    const reader = fakeReader(quotaBacklog(4, "agent-cto"));
    const text = (await sweep(reader, fakeWriter())).logLines.join("\n");
    expect(text.match(/scheduler\.quota_recovery_release/g)).toHaveLength(4);
    expect(text.match(/scheduler\.quota_recovery_summary/g)).toHaveLength(1);
    expect(text).toContain("scheduler.quota_recovery_agent");
  });

  it("does not read in-flight state or plan when the sweep is empty", async () => {
    const reader = fakeReader([]);
    const result = await sweep(reader, fakeWriter());
    expect(result).toEqual({ promoted: 0, runIds: [], deferred: 0, logLines: [], postCommitEffects: [] });
    expect(reader.inflightCalls).toHaveLength(0);
  });

  it("is reproducible for a fixed seed", async () => {
    const first = await sweep(fakeReader(quotaBacklog(6, "agent-a")), fakeWriter(), 7);
    const second = await sweep(fakeReader(quotaBacklog(6, "agent-a")), fakeWriter(), 7);
    expect(second.logLines).toEqual(first.logLines);
  });
});

describe("createCancelStaleQueuedRun", () => {
  it("delegates the complete read-decide-cancel operation to the writer", async () => {
    const cancelStaleQueuedRun = vi.fn(async () => ({
      outcome: "cancelled" as const,
      reason: "issue reassigned",
      errorCode: "issue_assignee_changed" as const,
      postCommitEffects: [],
    }));
    const writer = fakeWriter({
      cancelStaleQueuedRun,
    });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createCancelStaleQueuedRun({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });

    expect(result.outcome).toBe("cancelled");
    expect(cancelStaleQueuedRun).toHaveBeenCalledWith({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });
  });
});

describe("createDispatchResolvedInteractionIfCurrent", () => {
  it("delegates the lock, validation, cancellation, and dispatch boundary", async () => {
    const writer = fakeWriter();
    const dispatch = vi.fn(async () => "started");
    const result = await createDispatchResolvedInteractionIfCurrent({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "running",
      dispatch,
    });

    expect(result.dispatched).toBe(true);
    expect(writer.dispatchCalls).toHaveLength(1);
  });
});

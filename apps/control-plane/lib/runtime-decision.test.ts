import { describe, expect, it } from "vitest";

import { normalizeRuntimeDecisionQuery, runtimeDecisionEventFromRow, runtimeDecisionSummaryFromRows } from "./store";

describe("runtime decision activity", () => {
  it("normalizes a persisted enforcement decision without exposing arbitrary metadata", () => {
    const event = runtimeDecisionEventFromRow({
      id: "runtime-1",
      at: "2026-07-28T12:00:00.000Z",
      metadata: JSON.stringify({
        decision_id: "decision-1",
        request_id: "request-1",
        trace_id: "trace-1",
        tool_name: "create_refund",
        allow: false,
        reason: "approval required",
        policy_version: "2026.07.28",
        latency_ms: 13.5,
        parameters: { secret: "must not be exposed" }
      })
    });

    expect(event).toEqual({
      id: "runtime-1",
      at: "2026-07-28T12:00:00.000Z",
      decisionId: "decision-1",
      requestId: "request-1",
      traceId: "trace-1",
      toolName: "create_refund",
      allowed: false,
      reason: "approval required",
      policyVersion: "2026.07.28",
      latencyMs: 13.5
    });
  });

  it("bounds and normalizes investigation filters", () => {
    expect(normalizeRuntimeDecisionQuery({
      limit: 500,
      outcome: "deny",
      toolName: "  create_refund  ",
      identifier: " decision-1 ",
      before: "2026-07-28T12:00:00Z",
      beforeId: " runtime-1 "
    })).toEqual({
      limit: 100,
      outcome: "deny",
      toolName: "create_refund",
      identifier: "decision-1",
      before: "2026-07-28T12:00:00.000Z",
      beforeId: "runtime-1"
    });
  });

  it("builds a stable enforcement summary from database aggregates", () => {
    expect(runtimeDecisionSummaryFromRows(
      { total: "20", allowed: 12, denied: "6" },
      [{ tool_name: "create_refund", count: "4" }, { tool_name: "delete_file", count: 2 }],
      24
    )).toEqual({
      windowHours: 24,
      total: 20,
      allowed: 12,
      denied: 6,
      recorded: 2,
      denialRate: 0.3,
      topDeniedTools: [
        { toolName: "create_refund", count: 4 },
        { toolName: "delete_file", count: 2 }
      ]
    });
  });
});

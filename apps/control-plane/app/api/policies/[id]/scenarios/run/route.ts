import { NextRequest, NextResponse } from "next/server";

import {
  adoptControlPlaneRequestContext,
  requireControlPlaneRole
} from "../../../../../../lib/auth";
import { defaultActor } from "../../../../../../lib/context";
import {
  executePolicyValidation,
  MAX_POLICY_TEST_SCENARIOS,
  type PolicyTestOutcome
} from "../../../../../../lib/policy-validation";
import {
  appendAuditEvent,
  getPolicy,
  listPolicyTestScenarios,
  recordPolicyTestScenarioResults
} from "../../../../../../lib/store";
import type { PolicyTestScenario } from "../../../../../../lib/types";

type ScenarioRunResult = {
  scenarioId: string;
  name: string;
  expectedOutcome: "allow" | "deny";
  observedOutcome: PolicyTestOutcome;
  passed: boolean;
  durationMs: number;
  status?: number;
  error?: string;
};

async function runScenarios(scenarios: PolicyTestScenario[]): Promise<ScenarioRunResult[]> {
  const results = new Array<ScenarioRunResult>(scenarios.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < scenarios.length) {
      const index = nextIndex++;
      const scenario = scenarios[index];
      const execution = await executePolicyValidation({
        interceptPath: scenario.interceptPath,
        payload: scenario.payload,
        expectedOutcome: scenario.expectedOutcome
      });
      results[index] = {
        scenarioId: scenario.id,
        name: scenario.name,
        expectedOutcome: scenario.expectedOutcome,
        observedOutcome: execution.observedOutcome,
        passed: execution.assertion?.passed === true,
        durationMs: execution.durationMs,
        status: execution.status,
        error: execution.error
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(5, scenarios.length) }, () => worker())
  );
  return results;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireControlPlaneRole(request, "viewer");
  if (unauthorized) return unauthorized;
  adoptControlPlaneRequestContext(request);

  const { id } = await params;
  if (!(await getPolicy(id))) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  let body: { scenarioIds?: unknown } = {};
  try {
    body = (await request.json()) as { scenarioIds?: unknown };
  } catch {
    // An empty body means run the complete suite.
  }
  if (
    body.scenarioIds !== undefined &&
    (!Array.isArray(body.scenarioIds) ||
      body.scenarioIds.some((value) => typeof value !== "string"))
  ) {
    return NextResponse.json({ error: "scenarioIds must be an array of strings" }, { status: 400 });
  }

  const allScenarios = await listPolicyTestScenarios(id);
  const requestedIDs = body.scenarioIds as string[] | undefined;
  const requestedSet = requestedIDs ? new Set(requestedIDs) : undefined;
  const scenarios = requestedSet
    ? allScenarios.filter((scenario) => requestedSet.has(scenario.id))
    : allScenarios;
  if (!scenarios.length) {
    return NextResponse.json({ error: "no scenarios selected" }, { status: 400 });
  }
  if (scenarios.length > MAX_POLICY_TEST_SCENARIOS) {
    return NextResponse.json({ error: "too many scenarios selected" }, { status: 400 });
  }
  if (requestedSet && scenarios.length !== requestedSet.size) {
    return NextResponse.json({ error: "one or more scenarios were not found" }, { status: 404 });
  }

  const started = Date.now();
  const results = await runScenarios(scenarios);
  await recordPolicyTestScenarioResults(
    id,
    results.map((result) => ({
      scenarioId: result.scenarioId,
      observedOutcome: result.observedOutcome,
      passed: result.passed,
      error: result.error
    }))
  );

  const passed = results.filter((result) => result.passed).length;
  const errors = results.filter((result) => result.observedOutcome === "error").length;
  await appendAuditEvent({
    action: "policy_regression_suite_run",
    actor: defaultActor(),
    policyId: id,
    metadata: {
      total: results.length,
      passed,
      failed: results.length - passed,
      errors
    }
  });

  return NextResponse.json({
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      errors,
      durationMs: Date.now() - started
    },
    results
  });
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ControlPlaneConnectionSettings } from "@/components/control-plane-connection-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneHeaders } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import { DEFAULT_OPENAI_INTERCEPT_JSON } from "@/lib/sample-intercept";
import type { PolicyTestAssertion, PolicyTestOutcome } from "@/lib/policy-validation";
import type { PolicyRecord, PolicyTestScenario } from "@/lib/types";

const INTERCEPT_OPTIONS: { value: string; label: string }[] = [
  { value: "/v1/intercept/openai", label: "OpenAI" },
  { value: "/v1/intercept/openai/stream", label: "OpenAI (stream)" },
  { value: "/v1/intercept/anthropic", label: "Anthropic" },
  { value: "/v1/intercept/framework/generic", label: "Framework (generic)" },
  { value: "/v1/intercept/framework/langchain", label: "LangChain" }
];

const selectClass = cn(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
);

type Props = {
  policy: PolicyRecord;
  initialScenarios: PolicyTestScenario[];
};

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

type SuiteSummary = {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
};

export function PolicyDetailClient({ policy, initialScenarios }: Props) {
  const router = useRouter();

  const [interceptPath, setInterceptPath] = useState("/v1/intercept/openai");
  const [payloadText, setPayloadText] = useState(DEFAULT_OPENAI_INTERCEPT_JSON);
  const [arbiterBaseUrl, setArbiterBaseUrl] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState<"" | "allow" | "deny">("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [observedOutcome, setObservedOutcome] = useState<PolicyTestOutcome | null>(null);
  const [testAssertion, setTestAssertion] = useState<PolicyTestAssertion | null>(null);
  const [testing, setTesting] = useState(false);
  const [scenarios, setScenarios] = useState(initialScenarios);
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioMessage, setScenarioMessage] = useState<string | null>(null);
  const [savingScenario, setSavingScenario] = useState(false);
  const [runningSuite, setRunningSuite] = useState(false);
  const [suiteSummary, setSuiteSummary] = useState<SuiteSummary | null>(null);
  const [suiteResults, setSuiteResults] = useState<Record<string, ScenarioRunResult>>({});

  async function handleTest() {
    setTestResult(null);
    setObservedOutcome(null);
    setTestAssertion(null);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setTestResult(JSON.stringify({ error: "Payload is not valid JSON." }, null, 2));
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(`/api/policies/${encodeURIComponent(policy.id)}/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...controlPlaneHeaders()
        },
        body: JSON.stringify({
          interceptPath,
          payload,
          ...(expectedOutcome ? { expectedOutcome } : {}),
          ...(arbiterBaseUrl.trim() ? { arbiterBaseUrl: arbiterBaseUrl.trim() } : {})
        })
      });
      const data = (await res.json()) as {
        observedOutcome?: PolicyTestOutcome;
        assertion?: PolicyTestAssertion;
      };
      setObservedOutcome(data.observedOutcome ?? null);
      setTestAssertion(data.assertion ?? null);
      setTestResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setTestResult(
        JSON.stringify({ error: err instanceof Error ? err.message : "request failed" }, null, 2)
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete policy "${policy.name}"? This cannot be undone.`)) {
      return;
    }
    const res = await fetch(`/api/policies/${encodeURIComponent(policy.id)}`, {
      method: "DELETE",
      headers: controlPlaneHeaders()
    });
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function handleSaveScenario() {
    setScenarioMessage(null);
    const name = scenarioName.trim();
    if (!name) {
      setScenarioMessage("Enter a scenario name.");
      return;
    }
    if (!expectedOutcome) {
      setScenarioMessage("Choose an expected allow or deny outcome before saving.");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setScenarioMessage("Request body is not valid JSON.");
      return;
    }

    setSavingScenario(true);
    try {
      const response = await fetch(
        `/api/policies/${encodeURIComponent(policy.id)}/scenarios`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...controlPlaneHeaders()
          },
          body: JSON.stringify({
            name,
            interceptPath,
            payload,
            expectedOutcome
          })
        }
      );
      const data = (await response.json()) as {
        scenario?: PolicyTestScenario;
        error?: string;
      };
      if (!response.ok || !data.scenario) {
        setScenarioMessage(data.error ?? "Scenario could not be saved.");
        return;
      }
      setScenarios((current) => [data.scenario!, ...current]);
      setScenarioName("");
      setScenarioMessage(`Saved “${data.scenario.name}”.`);
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "Scenario could not be saved.");
    } finally {
      setSavingScenario(false);
    }
  }

  function handleLoadScenario(scenario: PolicyTestScenario) {
    setInterceptPath(scenario.interceptPath);
    setExpectedOutcome(scenario.expectedOutcome);
    setPayloadText(JSON.stringify(scenario.payload, null, 2));
    setScenarioName(scenario.name);
    setScenarioMessage(`Loaded “${scenario.name}” into the validator.`);
  }

  async function handleDeleteScenario(scenario: PolicyTestScenario) {
    if (!window.confirm(`Delete regression scenario "${scenario.name}"?`)) return;
    setScenarioMessage(null);
    const response = await fetch(
      `/api/policies/${encodeURIComponent(policy.id)}/scenarios/${encodeURIComponent(scenario.id)}`,
      {
        method: "DELETE",
        headers: controlPlaneHeaders()
      }
    );
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setScenarioMessage(data.error ?? "Scenario could not be deleted.");
      return;
    }
    setScenarios((current) => current.filter((item) => item.id !== scenario.id));
    setScenarioMessage(`Deleted “${scenario.name}”.`);
  }

  async function handleRunSuite() {
    setScenarioMessage(null);
    setSuiteSummary(null);
    setRunningSuite(true);
    try {
      const response = await fetch(
        `/api/policies/${encodeURIComponent(policy.id)}/scenarios/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...controlPlaneHeaders()
          },
          body: JSON.stringify({})
        }
      );
      const data = (await response.json()) as {
        summary?: SuiteSummary;
        results?: ScenarioRunResult[];
        error?: string;
      };
      if (!response.ok || !data.summary || !data.results) {
        setScenarioMessage(data.error ?? "Regression suite could not be run.");
        return;
      }
      const byID = Object.fromEntries(data.results.map((result) => [result.scenarioId, result]));
      const runAt = new Date().toISOString();
      setSuiteResults(byID);
      setSuiteSummary(data.summary);
      setScenarios((current) =>
        current.map((scenario) => {
          const result = byID[scenario.id];
          return result
            ? {
                ...scenario,
                lastRunAt: runAt,
                lastObservedOutcome: result.observedOutcome,
                lastPassed: result.passed,
                lastError: result.error
              }
            : scenario;
        })
      );
    } catch (error) {
      setScenarioMessage(error instanceof Error ? error.message : "Regression suite failed.");
    } finally {
      setRunningSuite(false);
    }
  }

  const rulesPretty = JSON.stringify(policy.rules, null, 2);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <Button variant="link" className="h-auto w-fit p-0 text-primary" asChild>
        <Link href="/">← Dashboard</Link>
      </Button>

      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Rule details</CardTitle>
            <CardDescription className="mt-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{policy.id}</code>
              <span className="ml-3 text-muted-foreground">
                Created {policy.createdAt} · Updated {policy.updatedAt}
              </span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/policies/${encodeURIComponent(policy.id)}/edit`}>Edit policy</Link>
            </Button>
            <Button variant="destructive" type="button" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="grid gap-1">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{policy.name}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground">Package</span>
            <span className="font-mono text-xs">{policy.packageName}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground">Version</span>
            <span>{policy.version}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground">Rollout</span>
            <span>{policy.rolloutState}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground">Metadata (JSON)</span>
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {rulesPretty}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Validate policy behavior</CardTitle>
          <CardDescription>
            Sends a request to your running Arbiter interceptor (default{" "}
            <code className="rounded bg-muted px-1 text-xs">http://127.0.0.1:8080</code> unless{" "}
            <code className="rounded bg-muted px-1 text-xs">ARBITER_URL</code> is set, or use the override below).
            This validates the connected interceptor&apos;s current behavior. Publish or synchronize a
            candidate before treating the result as release evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="intercept">Intercept route</Label>
            <select
              id="intercept"
              className={cn(selectClass, "max-w-lg")}
              value={interceptPath}
              onChange={(e) => setInterceptPath(e.target.value)}
            >
              {INTERCEPT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label} ({o.value})
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="expectedOutcome">Expected outcome</Label>
            <select
              id="expectedOutcome"
              className={cn(selectClass, "max-w-lg")}
              value={expectedOutcome}
              onChange={(e) => setExpectedOutcome(e.target.value as "" | "allow" | "deny")}
            >
              <option value="">Observe only</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="arbiterUrl">Arbiter base URL (optional)</Label>
            <Input
              id="arbiterUrl"
              placeholder="http://127.0.0.1:8080"
              value={arbiterBaseUrl}
              onChange={(e) => setArbiterBaseUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payload">Request JSON body</Label>
            <Textarea
              id="payload"
              className="min-h-[220px] font-mono text-xs"
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              spellCheck={false}
            />
          </div>
          <Button type="button" variant="secondary" onClick={handleTest} disabled={testing}>
            {testing ? "Running…" : expectedOutcome ? "Run assertion" : "Run validation"}
          </Button>
          {observedOutcome && (
            <div
              className={cn(
                "rounded-md border p-3 text-sm",
                testAssertion?.passed === false
                  ? "border-destructive/40 bg-destructive/10"
                  : testAssertion?.passed
                    ? "border-emerald-500/30 bg-emerald-500/10"
                    : "bg-muted/30"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                {testAssertion && (
                  <Badge variant={testAssertion.passed ? "default" : "destructive"}>
                    {testAssertion.passed ? "Passed" : "Failed"}
                  </Badge>
                )}
                <span>
                  Observed: <strong>{observedOutcome}</strong>
                  {testAssertion && (
                    <>
                      {" "}
                      · Expected: <strong>{testAssertion.expected}</strong>
                    </>
                  )}
                </span>
              </div>
            </div>
          )}
          {testResult && (
            <pre className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-4 text-xs leading-relaxed">
              {testResult}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Regression suite</CardTitle>
          <CardDescription>
            Save expected policy decisions and rerun them as a bounded suite against the configured
            Arbiter interceptor. Last-run status is retained for rollout review.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Scenario name"
              placeholder="Scenario name, e.g. block production shell"
              value={scenarioName}
              onChange={(event) => setScenarioName(event.target.value)}
              maxLength={100}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleSaveScenario}
              disabled={savingScenario}
            >
              {savingScenario ? "Saving…" : "Save current case"}
            </Button>
            <Button
              type="button"
              onClick={handleRunSuite}
              disabled={runningSuite || scenarios.length === 0}
            >
              {runningSuite ? "Running suite…" : `Run suite (${scenarios.length})`}
            </Button>
          </div>

          {scenarioMessage && (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{scenarioMessage}</p>
          )}

          {suiteSummary && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm",
                suiteSummary.failed === 0
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-destructive/40 bg-destructive/10"
              )}
            >
              <Badge variant={suiteSummary.failed === 0 ? "default" : "destructive"}>
                {suiteSummary.failed === 0 ? "Suite passed" : "Suite failed"}
              </Badge>
              <span>
                {suiteSummary.passed}/{suiteSummary.total} passed
              </span>
              {suiteSummary.errors > 0 && <span>{suiteSummary.errors} operational errors</span>}
              <span className="text-muted-foreground">{suiteSummary.durationMs} ms total</span>
            </div>
          )}

          {scenarios.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No saved scenarios. Choose an expected outcome above, name the current case, and save
              it here.
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {scenarios.map((scenario) => {
                const latest = suiteResults[scenario.id];
                const passed = latest?.passed ?? scenario.lastPassed;
                const observed = latest?.observedOutcome ?? scenario.lastObservedOutcome;
                return (
                  <div
                    key={scenario.id}
                    className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{scenario.name}</span>
                        <Badge variant="secondary">Expect {scenario.expectedOutcome}</Badge>
                        {passed !== undefined && (
                          <Badge variant={passed ? "default" : "destructive"}>
                            {passed ? "Passed" : "Failed"}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {scenario.interceptPath}
                        {observed ? ` · observed ${observed}` : " · not run yet"}
                      </p>
                      {(latest?.error ?? scenario.lastError) && (
                        <p className="text-xs text-destructive">
                          {latest?.error ?? scenario.lastError}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleLoadScenario(scenario)}
                      >
                        Load
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteScenario(scenario)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ControlPlaneConnectionSettings
        title="Need authenticated actions?"
        description="If edits or deletes are denied, set API key, tenant, and role headers here."
      />
    </div>
  );
}

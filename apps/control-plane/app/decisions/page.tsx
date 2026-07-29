import Link from "next/link";

import { ControlPlaneConnectionSettings } from "@/components/control-plane-connection-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runWithControlPlaneRequestContext } from "@/lib/context";
import { formatTimestamp } from "@/lib/presentation";
import { establishControlPlanePageContext } from "@/lib/server-identity";
import { listRuntimeDecisionEvents } from "@/lib/store";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const selectClass = cn(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
);

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await establishControlPlanePageContext();
  if (!context) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Signed identity required</h1>
        <ControlPlaneConnectionSettings description="Save a signed identity token, then reload to investigate tenant decisions." />
      </div>
    );
  }

  const params = await searchParams;
  const rawOutcome = one(params.outcome);
  const outcome = rawOutcome === "allow" || rawOutcome === "deny" ? rawOutcome : undefined;
  const toolName = one(params.tool);
  const identifier = one(params.id);
  const before = one(params.before);
  const beforeId = one(params.before_id);
  const fetched = await runWithControlPlaneRequestContext(context, () => listRuntimeDecisionEvents({
    limit: PAGE_SIZE + 1,
    outcome,
    toolName,
    identifier,
    before,
    beforeId
  }));
  const hasOlder = fetched.length > PAGE_SIZE;
  const decisions = fetched.slice(0, PAGE_SIZE);
  const last = decisions.at(-1);
  const olderParams = new URLSearchParams();
  if (outcome) olderParams.set("outcome", outcome);
  if (toolName.trim()) olderParams.set("tool", toolName.trim());
  if (identifier.trim()) olderParams.set("id", identifier.trim());
  if (last) {
    olderParams.set("before", last.at);
    olderParams.set("before_id", last.id);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Decision explorer</h1>
        <p className="mt-2 text-sm text-muted-foreground">Investigate tenant-scoped enforcement outcomes without exposing tool parameters.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
          <CardDescription>Outcome, tool name, and IDs use exact matching for predictable indexed queries.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/decisions" method="get" className="grid gap-4 md:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="outcome">Outcome</Label>
              <select id="outcome" name="outcome" defaultValue={outcome ?? ""} className={selectClass}>
                <option value="">All outcomes</option>
                <option value="allow">Allowed</option>
                <option value="deny">Denied</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tool">Tool name</Label>
              <Input id="tool" name="tool" defaultValue={toolName} placeholder="create_refund" />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="id">Decision, request, or trace ID</Label>
              <Input id="id" name="id" defaultValue={identifier} placeholder="decision-..." />
            </div>
            <div className="flex flex-wrap gap-2 md:col-span-4">
              <Button type="submit">Apply filters</Button>
              <Button variant="outline" asChild><Link href="/decisions">Clear</Link></Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Runtime decisions</CardTitle>
          <CardDescription>{decisions.length} decision{decisions.length === 1 ? "" : "s"} on this page</CardDescription>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions match these filters.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Tool</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Decision</th><th className="px-3 py-2">When</th></tr>
                </thead>
                <tbody>
                  {decisions.map((decision) => (
                    <tr key={decision.id} className="border-t align-top">
                      <td className="px-3 py-3"><Badge variant={decision.allowed === false ? "destructive" : "secondary"}>{decision.allowed === false ? "Denied" : decision.allowed === true ? "Allowed" : "Recorded"}</Badge></td>
                      <td className="px-3 py-3 font-mono text-xs">{decision.toolName ?? "unknown"}</td>
                      <td className="max-w-sm px-3 py-3 text-muted-foreground">{decision.reason ?? "No reason recorded"}</td>
                      <td className="px-3 py-3 font-mono text-xs"><div>{decision.decisionId ?? "—"}</div>{decision.policyVersion && <div className="mt-1 text-muted-foreground">policy {decision.policyVersion}</div>}</td>
                      <td className="px-3 py-3 text-xs text-muted-foreground"><div>{formatTimestamp(decision.at)}</div>{decision.latencyMs !== undefined && <div className="mt-1">{Math.round(decision.latencyMs)} ms</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hasOlder && last && (
            <Button variant="outline" className="mt-4" asChild>
              <Link href={`/decisions?${olderParams.toString()}`}>Older decisions →</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

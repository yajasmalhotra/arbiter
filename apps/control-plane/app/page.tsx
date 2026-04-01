import Link from "next/link";

import { ControlPlaneConnectionSettings } from "@/components/control-plane-connection-settings";
import { PoliciesGrid } from "@/components/policies-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { listAuditEvents, listPolicies } from "@/lib/store";
import { auditActionLabel, formatTimestamp, rolloutLabel } from "@/lib/presentation";

export default async function HomePage() {
  const [policies, auditEvents] = await Promise.all([listPolicies(), listAuditEvents()]);
  const byState = policies.reduce<Record<string, number>>((acc, policy) => {
    acc[policy.rolloutState] = (acc[policy.rolloutState] || 0) + 1;
    return acc;
  }, {});
  const protectedCount = byState.enforced ?? 0;
  const inProgressCount = (byState.shadow ?? 0) + (byState.canary ?? 0);
  const needsAttentionCount = (byState.rolled_back ?? 0) + (byState.draft ?? 0);
  const orderedStates = ["draft", "shadow", "canary", "enforced", "rolled_back"];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage safety rules, releases, and access keys without needing API calls.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Live protections</CardDescription>
            <CardTitle>{protectedCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In testing</CardDescription>
            <CardTitle>{inProgressCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Need review</CardDescription>
            <CardTitle>{needsAttentionCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-lg">Start here</CardTitle>
          <CardDescription>Typical workflow for operations and governance teams</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border bg-background p-4">
            <p className="text-sm font-medium">1. Create or update a rule</p>
            <p className="mt-1 text-xs text-muted-foreground">Capture business intent as a policy record.</p>
            <Button variant="secondary" size="sm" className="mt-3" asChild>
              <Link href="/policies/new">Create rule</Link>
            </Button>
          </div>
          <div className="rounded-md border bg-background p-4">
            <p className="text-sm font-medium">2. Validate behavior</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Open a policy and run a live intercept test against Arbiter.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" asChild>
              <Link href={policies[0] ? `/policies/${encodeURIComponent(policies[0].id)}` : "/policies/new"}>
                {policies[0] ? "Test latest rule" : "Open policy"}
              </Link>
            </Button>
          </div>
          <div className="rounded-md border bg-background p-4">
            <p className="text-sm font-medium">3. Release safely</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Promote bundles, rollback quickly, and manage keys in one place.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" asChild>
              <Link href="/operations">Open operations</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <ControlPlaneConnectionSettings />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Policy status overview</CardTitle>
          <CardDescription>Current rollout stages across all policy records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Total policies: {policies.length}</p>
          <div className="flex flex-wrap gap-2">
            {orderedStates.map((state) => (
              <Badge key={state} variant="secondary">
                {rolloutLabel(state)}: {byState[state] ?? 0}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All rules</CardTitle>
          <CardDescription>Search, open, edit, or remove policy records</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <PoliciesGrid policies={policies} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            {auditEvents.slice(0, 10).map((event) => (
              <li key={event.id}>
                {formatTimestamp(event.at)} - {auditActionLabel(event.action)} ({event.actor})
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

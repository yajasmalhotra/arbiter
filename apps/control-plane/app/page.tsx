import { PoliciesGrid } from "@/components/policies-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { listAuditEvents, listPolicies } from "@/lib/store";

export default async function HomePage() {
  const [policies, auditEvents] = await Promise.all([listPolicies(), listAuditEvents()]);
  const byState = policies.reduce<Record<string, number>>((acc, policy) => {
    acc[policy.rolloutState] = (acc[policy.rolloutState] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open a row to edit and run a live test against Arbiter (server{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">ARBITER_URL</code> or{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">http://127.0.0.1:8080</code>).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Summary</CardTitle>
          <CardDescription>Rollout counts across registered policies</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Total policies: {policies.length}</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(byState).map(([state, count]) => (
              <Badge key={state} variant="secondary">
                {state}: {count}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All policies</CardTitle>
          <CardDescription>Sort, filter, and open a policy to edit or test</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <PoliciesGrid policies={policies} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent audit events</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            {auditEvents.slice(0, 10).map((event) => (
              <li key={event.id}>
                {event.at} — {event.action} ({event.actor})
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

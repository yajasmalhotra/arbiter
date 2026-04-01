import Link from "next/link";

import { CreatePolicyForm } from "@/components/create-policy-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Create Policy · Arbiter Control Plane"
};

export default function NewPolicyPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button variant="link" className="h-auto w-fit p-0 text-primary" asChild>
        <Link href="/">← Dashboard</Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Registers metadata in the control plane store. Runtime Rego for Arbiter still lives under{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">policy/</code> unless you add sync.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Policy record</CardTitle>
          <CardDescription>Identifiers, rollout state, and optional JSON rules metadata</CardDescription>
        </CardHeader>
        <CardContent>
          <CreatePolicyForm />
        </CardContent>
      </Card>
    </div>
  );
}

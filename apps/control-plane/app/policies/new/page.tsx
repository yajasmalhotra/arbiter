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
        <h1 className="text-2xl font-semibold tracking-tight">Create rule</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Add a new governance rule record for rollout and operational tracking.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rule details</CardTitle>
          <CardDescription>Name, rollout stage, and optional metadata</CardDescription>
        </CardHeader>
        <CardContent>
          <CreatePolicyForm />
        </CardContent>
      </Card>
    </div>
  );
}

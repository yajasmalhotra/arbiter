import Link from "next/link";
import { notFound } from "next/navigation";

import { PolicyRecordForm } from "@/components/policy-record-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPolicy } from "@/lib/store";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getPolicy(id);
  return {
    title: policy ? `Edit · ${policy.name}` : "Edit policy · Arbiter Control Plane"
  };
}

export default async function EditPolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getPolicy(id);
  if (!policy) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button variant="link" className="h-auto w-fit p-0 text-primary" asChild>
        <Link href={`/policies/${encodeURIComponent(policy.id)}`}>← Back to policy</Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Update metadata stored in the control plane. This screen is not linked from the sidebar—use the grid context
          menu or the policy detail page.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Policy fields</CardTitle>
          <CardDescription>Same layout as Create Policy</CardDescription>
        </CardHeader>
        <CardContent>
          <PolicyRecordForm mode="edit" initialPolicy={policy} />
        </CardContent>
      </Card>
    </div>
  );
}

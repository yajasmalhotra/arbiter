import { notFound } from "next/navigation";

import { PolicyDetailClient } from "@/components/policy-detail-client";
import { getPolicy, listPolicyTestScenarios } from "@/lib/store";
import { establishControlPlanePageContext } from "@/lib/server-identity";
import { runWithControlPlaneRequestContext } from "@/lib/context";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await establishControlPlanePageContext();
  if (!context) {
    notFound();
  }
  const { id } = await params;
  const [policy, scenarios] = await runWithControlPlaneRequestContext(context, () =>
    Promise.all([getPolicy(id), listPolicyTestScenarios(id)])
  );
  if (!policy) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{policy.name}</h1>
      <PolicyDetailClient policy={policy} initialScenarios={scenarios} />
    </div>
  );
}

export const metadata = { title: "Policy · Arbiter Control Plane" };

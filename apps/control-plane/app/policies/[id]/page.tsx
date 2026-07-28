import { notFound } from "next/navigation";

import { PolicyDetailClient } from "@/components/policy-detail-client";
import { getPolicy } from "@/lib/store";
import { establishControlPlanePageContext } from "@/lib/server-identity";
import { runWithControlPlaneRequestContext } from "@/lib/context";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await establishControlPlanePageContext();
  if (!context) {
    notFound();
  }
  const { id } = await params;
  const policy = await runWithControlPlaneRequestContext(context, () => getPolicy(id));
  if (!policy) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{policy.name}</h1>
      <PolicyDetailClient policy={policy} />
    </div>
  );
}

export const metadata = { title: "Policy · Arbiter Control Plane" };

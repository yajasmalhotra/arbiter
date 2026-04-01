import { notFound } from "next/navigation";

import { PolicyDetailClient } from "@/components/policy-detail-client";
import { getPolicy } from "@/lib/store";

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getPolicy(id);
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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const policy = await getPolicy(id);
  return {
    title: policy ? `${policy.name} · Arbiter Control Plane` : "Policy · Arbiter Control Plane"
  };
}

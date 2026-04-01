import Link from "next/link";

import { ControlPlaneConnectionSettings } from "@/components/control-plane-connection-settings";
import { OperationsWorkbench } from "@/components/operations-workbench";
import { Button } from "@/components/ui/button";
import {
  getActiveBundle,
  listApprovalRequests,
  listBundleActivations,
  listBundles,
  listServiceTokens,
  listSigningKeys
} from "@/lib/store";

export const metadata = {
  title: "Operations · Arbiter Control Plane"
};

export default async function OperationsPage() {
  const [activeBundle, bundles, activations, serviceTokens, signingKeys, approvalRequests] = await Promise.all([
    getActiveBundle(),
    listBundles(),
    listBundleActivations(),
    listServiceTokens(),
    listSigningKeys(),
    listApprovalRequests()
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Button variant="link" className="h-auto w-fit p-0 text-primary" asChild>
        <Link href="/">← Dashboard</Link>
      </Button>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Release policy bundles, manage integration tokens, and rotate signing keys from one screen.
        </p>
      </div>

      <ControlPlaneConnectionSettings
        title="Secure deployment headers"
        description="Set optional API key, tenant, and role headers for protected environments."
      />

      <OperationsWorkbench
        activeBundle={activeBundle}
        bundles={bundles}
        activations={activations}
        serviceTokens={serviceTokens}
        signingKeys={signingKeys}
        approvalRequests={approvalRequests}
      />
    </div>
  );
}

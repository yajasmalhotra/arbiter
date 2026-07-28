import Link from "next/link";

import { ControlPlaneConnectionSettings } from "@/components/control-plane-connection-settings";
import { OperationsWorkbench } from "@/components/operations-workbench";
import { Button } from "@/components/ui/button";
import {
  getActiveBundle,
  listApprovalRequests,
  listBundleActivations,
  listBundles,
  listCapabilityGrants,
  listServiceTokens,
  listSigningKeys
} from "@/lib/store";
import { establishControlPlanePageContext } from "@/lib/server-identity";
import { runWithControlPlaneRequestContext } from "@/lib/context";

export const metadata = {
  title: "Operations · Arbiter Control Plane"
};

// Operations data is tenant-scoped when enterprise signed identity is enabled.
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const context = await establishControlPlanePageContext();
  if (!context) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Signed identity required</h1>
        <ControlPlaneConnectionSettings description="Save a short-lived signed identity token, then reload to load tenant operations data." />
      </div>
    );
  }
  const [activeBundle, bundles, activations, serviceTokens, signingKeys, capabilityGrants, approvalRequests] = await runWithControlPlaneRequestContext(context, () => Promise.all([
    getActiveBundle(),
    listBundles(),
    listBundleActivations(),
    listServiceTokens(),
    listSigningKeys(),
    listCapabilityGrants(),
    listApprovalRequests()
  ]));

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
        description="Set the signed identity token for tenant-scoped access, or legacy headers for development deployments."
      />

      <OperationsWorkbench
        activeBundle={activeBundle}
        bundles={bundles}
        activations={activations}
        serviceTokens={serviceTokens}
        signingKeys={signingKeys}
        capabilityGrants={capabilityGrants}
        approvalRequests={approvalRequests}
      />
    </div>
  );
}

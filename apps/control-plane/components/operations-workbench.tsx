"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneHeaders, loadControlPlaneClientConfig } from "@/lib/control-plane-client";
import { summarizeBundleChanges } from "@/lib/bundle-diff";
import { bundleStatusLabel, formatTimestamp, rolloutLabel, shortID } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import type { ApprovalRequest, BundleActivation, BundleArtifact, CapabilityGrant, RolloutState, ServiceToken, SigningKey } from "@/lib/types";

const selectClass = cn(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
);

type Role = "viewer" | "editor" | "approver" | "admin";

const ROLE_WEIGHT: Record<Role, number> = {
  viewer: 10,
  editor: 20,
  approver: 30,
  admin: 40
};

type Props = {
  bundles: BundleArtifact[];
  activations: BundleActivation[];
  activeBundle?: BundleArtifact;
  serviceTokens: ServiceToken[];
  signingKeys: SigningKey[];
  capabilityGrants: CapabilityGrant[];
  approvalRequests: ApprovalRequest[];
};

type StatusMessage = {
  kind: "success" | "error";
  text: string;
};

function normalizeRole(raw: string): Role | undefined {
  const role = raw.trim().toLowerCase();
  if (role === "viewer" || role === "editor" || role === "approver" || role === "admin") {
    return role;
  }
  return undefined;
}

function hasMinimumRole(role: Role | undefined, minimum: Role): boolean {
  if (!role) {
    return true;
  }
  return ROLE_WEIGHT[role] >= ROLE_WEIGHT[minimum];
}

export function OperationsWorkbench(props: Props) {
  const router = useRouter();
  const [serviceTokens, setServiceTokens] = useState(props.serviceTokens);
  const [signingKeys, setSigningKeys] = useState(props.signingKeys);
  const [capabilityGrants, setCapabilityGrants] = useState(props.capabilityGrants);
  const [approvalRequests, setApprovalRequests] = useState(props.approvalRequests);
  const [bundles, setBundles] = useState(props.bundles);
  const [reviewNotesById, setReviewNotesById] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [currentRole, setCurrentRole] = useState<Role | undefined>();

  const [publishRolloutState, setPublishRolloutState] = useState<RolloutState>("shadow");
  const [promoteBundleId, setPromoteBundleId] = useState(props.bundles[0]?.id ?? "");
  const [promoteChannel, setPromoteChannel] = useState<"dev" | "staging" | "prod">("prod");
  const [promoteNotes, setPromoteNotes] = useState("");

  const [rollbackChannel, setRollbackChannel] = useState<"dev" | "staging" | "prod">("prod");
  const [rollbackNotes, setRollbackNotes] = useState("");

  const [serviceTokenName, setServiceTokenName] = useState("");
  const [serviceTokenScopes, setServiceTokenScopes] = useState("bundle:read");
  const [issuedServiceToken, setIssuedServiceToken] = useState("");

  const [keyName, setKeyName] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keyScope, setKeyScope] = useState("read");
  const [keyAlgorithm, setKeyAlgorithm] = useState<"HS256" | "RS256">("RS256");
  const [activateKeyNow, setActivateKeyNow] = useState(true);

  const [capabilityName, setCapabilityName] = useState("");
  const [capabilitySubject, setCapabilitySubject] = useState("");
  const [capabilityWorkloadId, setCapabilityWorkloadId] = useState("");
  const [capabilityServers, setCapabilityServers] = useState("");
  const [capabilityTools, setCapabilityTools] = useState("");
  const [capabilityMaxAmount, setCapabilityMaxAmount] = useState("");
  const [capabilityMayDelegate, setCapabilityMayDelegate] = useState(false);
  const [capabilityExpiresAt, setCapabilityExpiresAt] = useState("");
  const [issuedCapability, setIssuedCapability] = useState("");

  const [pending, setPending] = useState<string | null>(null);

  const canEdit = hasMinimumRole(currentRole, "editor");
  const canApprove = hasMinimumRole(currentRole, "approver");
  const pendingApprovals = approvalRequests.filter((request) => request.state === "pending");
  const selectedBundle = bundles.find((bundle) => bundle.id === promoteBundleId);
  const releasePreview = summarizeBundleChanges(props.activeBundle, selectedBundle);

  useEffect(() => {
    const load = () => {
      const config = loadControlPlaneClientConfig();
      setCurrentRole(normalizeRole(config.role));
    };
    load();
    window.addEventListener("storage", load);
    window.addEventListener("arbiter-control-plane-client-config-updated", load);
    return () => {
      window.removeEventListener("storage", load);
      window.removeEventListener("arbiter-control-plane-client-config-updated", load);
    };
  }, []);

  function requestHeaders(json = true): Record<string, string> {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...controlPlaneHeaders()
    };
  }

  async function parseBody(res: Response): Promise<Record<string, unknown>> {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function upsertApprovalRequest(request: ApprovalRequest) {
    setApprovalRequests((current) => [request, ...current.filter((item) => item.id !== request.id)]);
  }

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canEdit) {
      setStatus({ kind: "error", text: "Publishing bundles requires editor role or higher." });
      return;
    }
    setPending("publish");
    try {
      const res = await fetch("/api/bundles", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          rolloutState: publishRolloutState,
          data: props.activeBundle?.snapshot.data ?? {}
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Publish failed (${res.status})`) });
        return;
      }
      const bundle = (body.bundle ?? null) as BundleArtifact | null;
      if (!bundle) {
        setStatus({ kind: "error", text: "Publish succeeded without returning a bundle." });
        return;
      }
      setBundles((current) => [bundle, ...current.filter((item) => item.id !== bundle.id)]);
      setPromoteBundleId(bundle.id);
      setStatus({ kind: "success", text: publishRolloutState === "shadow" ? "Shadow bundle published. Promote it to development or staging to observe would-deny decisions." : "Bundle published." });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function handlePromote(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canEdit) {
      setStatus({ kind: "error", text: "Promotion requests require editor role or higher." });
      return;
    }
    if (!promoteBundleId.trim()) {
      setStatus({ kind: "error", text: "Select a bundle to promote." });
      return;
    }
    setPending("promote");
    try {
      const res = await fetch(`/api/bundles/${encodeURIComponent(promoteBundleId)}/promote`, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          channel: promoteChannel,
          notes: promoteNotes.trim() || undefined
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Promote failed (${res.status})`) });
        return;
      }

      if (res.status === 202 && body.approvalRequest) {
        upsertApprovalRequest(body.approvalRequest as ApprovalRequest);
        setStatus({ kind: "success", text: "Production promotion submitted for approval." });
      } else {
        setStatus({ kind: "success", text: "Bundle promotion completed." });
        router.refresh();
      }
      setPromoteNotes("");
    } finally {
      setPending(null);
    }
  }

  async function handleRollback(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canEdit) {
      setStatus({ kind: "error", text: "Rollback requests require editor role or higher." });
      return;
    }
    setPending("rollback");
    try {
      const res = await fetch(`/api/bundles/channels/${rollbackChannel}/rollback`, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          notes: rollbackNotes.trim() || undefined
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Rollback failed (${res.status})`) });
        return;
      }

      if (res.status === 202 && body.approvalRequest) {
        upsertApprovalRequest(body.approvalRequest as ApprovalRequest);
        setStatus({ kind: "success", text: "Production rollback submitted for approval." });
      } else {
        setStatus({ kind: "success", text: `Rollback completed for ${rollbackChannel}.` });
        router.refresh();
      }
      setRollbackNotes("");
    } finally {
      setPending(null);
    }
  }

  async function handleApproveRequest(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Approving requests requires approver role or higher." });
      return;
    }
    setPending(`approve:${id}`);
    try {
      const notes = reviewNotesById[id]?.trim() || undefined;
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ notes })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Approve failed (${res.status})`) });
        return;
      }
      const approvalRequest = (body.approvalRequest ?? null) as ApprovalRequest | null;
      if (approvalRequest) {
        upsertApprovalRequest(approvalRequest);
      }
      setStatus({ kind: "success", text: "Approval request approved and action executed." });
      setReviewNotesById((current) => ({ ...current, [id]: "" }));
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function handleRejectRequest(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Rejecting requests requires approver role or higher." });
      return;
    }
    setPending(`reject:${id}`);
    try {
      const notes = reviewNotesById[id]?.trim() || undefined;
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ notes })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Reject failed (${res.status})`) });
        return;
      }
      const approvalRequest = (body.approvalRequest ?? null) as ApprovalRequest | null;
      if (approvalRequest) {
        upsertApprovalRequest(approvalRequest);
      }
      setStatus({ kind: "success", text: "Approval request rejected." });
      setReviewNotesById((current) => ({ ...current, [id]: "" }));
    } finally {
      setPending(null);
    }
  }

  async function handleCreateServiceToken(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Token management requires approver role or higher." });
      return;
    }
    if (!serviceTokenName.trim()) {
      setStatus({ kind: "error", text: "Token name is required." });
      return;
    }
    setPending("create-token");
    try {
      const scopes = serviceTokenScopes
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
      const res = await fetch("/api/service-tokens", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          name: serviceTokenName.trim(),
          scopes
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Token creation failed (${res.status})`) });
        return;
      }

      const token = String(body.token ?? "");
      const record = (body.record ?? null) as ServiceToken | null;
      setIssuedServiceToken(token);
      if (record) {
        setServiceTokens((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      }
      setServiceTokenName("");
      setStatus({ kind: "success", text: "Integration token created. Copy it now." });
    } finally {
      setPending(null);
    }
  }

  async function handleRevokeServiceToken(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Token management requires approver role or higher." });
      return;
    }
    setPending(`revoke-token:${id}`);
    try {
      const res = await fetch(`/api/service-tokens/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        headers: requestHeaders(false)
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Token revoke failed (${res.status})`) });
        return;
      }
      const record = (body.serviceToken ?? null) as ServiceToken | null;
      if (record) {
        setServiceTokens((current) => current.map((item) => (item.id === record.id ? record : item)));
      }
      setStatus({ kind: "success", text: "Integration token revoked." });
    } finally {
      setPending(null);
    }
  }

  async function handleCreateSigningKey(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Signing key management requires approver role or higher." });
      return;
    }
    if (!keyName.trim() || !keySecret.trim()) {
      setStatus({ kind: "error", text: "Signing key name and secret are required." });
      return;
    }
    setPending("create-key");
    try {
      const res = await fetch("/api/signing-keys", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          name: keyName.trim(),
          secret: keySecret.trim(),
          keyId: keyId.trim() || undefined,
          scope: keyScope.trim() || undefined,
          algorithm: keyAlgorithm,
          activate: activateKeyNow
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Signing key creation failed (${res.status})`) });
        return;
      }
      const created = (body.signingKey ?? null) as SigningKey | null;
      if (created) {
        setSigningKeys((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      }
      setKeyName("");
      setKeySecret("");
      setKeyId("");
      setKeyAlgorithm("RS256");
      setStatus({ kind: "success", text: "Signing key created." });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function handleActivateSigningKey(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Signing key management requires approver role or higher." });
      return;
    }
    setPending(`activate-key:${id}`);
    try {
      const res = await fetch(`/api/signing-keys/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        headers: requestHeaders(false)
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Key activation failed (${res.status})`) });
        return;
      }
      const activated = (body.signingKey ?? null) as SigningKey | null;
      if (activated) {
        setSigningKeys((current) =>
          current.map((item) => {
            if (item.id === activated.id) return activated;
            return { ...item, isActive: false };
          })
        );
      }
      setStatus({ kind: "success", text: "Signing key activated." });
    } finally {
      setPending(null);
    }
  }

  async function handleRevokeSigningKey(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Signing key management requires approver role or higher." });
      return;
    }
    setPending(`revoke-key:${id}`);
    try {
      const res = await fetch(`/api/signing-keys/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        headers: requestHeaders(false)
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Key revoke failed (${res.status})`) });
        return;
      }
      const revoked = (body.signingKey ?? null) as SigningKey | null;
      if (revoked) {
        setSigningKeys((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      }
      setStatus({ kind: "success", text: "Signing key revoked." });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function handleCreateCapabilityGrant(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Capability management requires approver role or higher." });
      return;
    }
    const serverIds = capabilityServers.split(",").map((value) => value.trim()).filter(Boolean);
    const toolNames = capabilityTools.split(",").map((value) => value.trim()).filter(Boolean);
    const maxAmountCents = capabilityMaxAmount.trim() === "" ? undefined : Number(capabilityMaxAmount);
    if (!capabilityName.trim() || !capabilitySubject.trim() || !serverIds.length || !toolNames.length || !capabilityExpiresAt) {
      setStatus({ kind: "error", text: "Name, subject, servers, tools, and expiry are required." });
      return;
    }
    if (maxAmountCents !== undefined && (!Number.isSafeInteger(maxAmountCents) || maxAmountCents < 0)) {
      setStatus({ kind: "error", text: "Maximum amount must be a non-negative whole number of cents." });
      return;
    }
    setPending("create-capability");
    try {
      const res = await fetch("/api/capability-grants", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          name: capabilityName.trim(),
          subject: capabilitySubject.trim(),
          workloadId: capabilityWorkloadId.trim() || undefined,
          serverIds,
          toolNames,
          maxAmountCents,
          mayDelegate: capabilityMayDelegate,
          expiresAt: new Date(capabilityExpiresAt).toISOString()
        })
      });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Capability creation failed (${res.status})`) });
        return;
      }
      const record = (body.record ?? null) as CapabilityGrant | null;
      setIssuedCapability(String(body.token ?? ""));
      if (record) setCapabilityGrants((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      setCapabilityName("");
      setCapabilitySubject("");
      setCapabilityWorkloadId("");
      setCapabilityServers("");
      setCapabilityTools("");
      setCapabilityMaxAmount("");
      setCapabilityMayDelegate(false);
      setCapabilityExpiresAt("");
      setStatus({ kind: "success", text: "Capability grant created. Copy it now." });
    } finally {
      setPending(null);
    }
  }

  async function handleRevokeCapabilityGrant(id: string) {
    setStatus(null);
    if (!canApprove) {
      setStatus({ kind: "error", text: "Capability management requires approver role or higher." });
      return;
    }
    setPending(`revoke-capability:${id}`);
    try {
      const res = await fetch(`/api/capability-grants/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: requestHeaders(false) });
      const body = await parseBody(res);
      if (!res.ok) {
        setStatus({ kind: "error", text: String(body.error ?? `Capability revoke failed (${res.status})`) });
        return;
      }
      const record = (body.capabilityGrant ?? null) as CapabilityGrant | null;
      if (record) setCapabilityGrants((current) => current.map((item) => (item.id === record.id ? record : item)));
      setStatus({ kind: "success", text: "Capability grant revoked and runtime synchronization requested." });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-sm",
            status.kind === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          )}
        >
          {status.text}
        </div>
      )}

      {currentRole && (
        <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          Current connection role: <span className="font-medium text-foreground">{currentRole}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Release controls</CardTitle>
          <CardDescription>Publish candidates, observe them safely, promote deliberately, and rollback quickly.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="grid gap-4">
            <div className="rounded-md border bg-muted/20 p-4 text-sm">
              <p className="font-medium">Current production bundle</p>
              {props.activeBundle ? (
                <p className="mt-1 text-muted-foreground">
                  {shortID(props.activeBundle.id, 14)} · {bundleStatusLabel(props.activeBundle.status)} ·{" "}
                  {rolloutLabel(props.activeBundle.rolloutState)}
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">No active bundle yet.</p>
              )}
            </div>

            <form className="grid gap-3 rounded-md border p-4" onSubmit={(e) => void handlePublish(e)}>
              <p className="text-sm font-medium">Publish candidate</p>
              <p className="text-xs text-muted-foreground">Snapshot current policies and preserve the active bundle&apos;s data revision inputs.</p>
              <div className="grid gap-2">
                <Label htmlFor="publish-rollout">Initial mode</Label>
                <select id="publish-rollout" className={selectClass} value={publishRolloutState} onChange={(e) => setPublishRolloutState(e.target.value as RolloutState)}>
                  <option value="shadow">Monitoring only (recommended)</option>
                  <option value="canary">Canary label (enforced)</option>
                  <option value="enforced">Enforced</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
              {publishRolloutState === "shadow" && <p className="text-xs text-muted-foreground">Shadow mode allows execution while recording the policy verdict as Would deny.</p>}
              {!canEdit && <p className="text-xs text-destructive">Requires editor role or higher.</p>}
              <Button type="submit" disabled={pending === "publish" || !canEdit}>{pending === "publish" ? "Publishing..." : "Publish candidate"}</Button>
            </form>

            <form className="grid gap-3 rounded-md border p-4" onSubmit={(e) => void handlePromote(e)}>
              <p className="text-sm font-medium">Promote bundle</p>
              <div className="grid gap-2">
                <Label htmlFor="promote-bundle">Bundle</Label>
                <select
                  id="promote-bundle"
                  className={selectClass}
                  value={promoteBundleId}
                  onChange={(e) => setPromoteBundleId(e.target.value)}
                >
                  <option value="">Select bundle</option>
                  {bundles.map((bundle) => (
                    <option key={bundle.id} value={bundle.id}>
                      {shortID(bundle.id, 14)} · {bundleStatusLabel(bundle.status)} · {formatTimestamp(bundle.createdAt)}
                    </option>
                  ))}
                </select>
              </div>
              {releasePreview && (
                <div className="rounded-md border bg-muted/20 p-3 text-xs">
                  <p className="font-medium text-foreground">{releasePreview.baselineAvailable ? "Change preview vs current production" : "First production release preview"}</p>
                  <div className="mt-2 grid gap-1 text-muted-foreground">
                    <p>Policies: +{releasePreview.policies.added.length} added · ~{releasePreview.policies.changed.length} changed · −{releasePreview.policies.removed.length} removed</p>
                    <p>Data keys: +{releasePreview.data.added.length} added · ~{releasePreview.data.changed.length} changed · −{releasePreview.data.removed.length} removed</p>
                    {[...releasePreview.policies.changed, ...releasePreview.policies.added, ...releasePreview.policies.removed].slice(0, 5).length > 0 && (
                      <p>Policy names: {[...releasePreview.policies.changed, ...releasePreview.policies.added, ...releasePreview.policies.removed].slice(0, 5).join(", ")}</p>
                    )}
                  </div>
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="promote-channel">Channel</Label>
                <select
                  id="promote-channel"
                  className={selectClass}
                  value={promoteChannel}
                  onChange={(e) => setPromoteChannel(e.target.value as "dev" | "staging" | "prod")}
                >
                  <option value="dev">Development</option>
                  <option value="staging">Staging</option>
                  <option value="prod">Production (approval required)</option>
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="promote-notes">Change note (optional)</Label>
                <Input
                  id="promote-notes"
                  value={promoteNotes}
                  onChange={(e) => setPromoteNotes(e.target.value)}
                  placeholder="Why this promotion is safe"
                />
              </div>
              {promoteChannel === "prod" && (
                <p className="text-xs text-muted-foreground">
                  Production changes create a pending approval request before rollout.
                </p>
              )}
              {!canEdit && <p className="text-xs text-destructive">Requires editor role or higher.</p>}
              <Button type="submit" disabled={pending === "promote" || !canEdit}>
                {pending === "promote"
                  ? "Submitting..."
                  : promoteChannel === "prod"
                    ? "Request production promotion"
                    : "Promote bundle"}
              </Button>
            </form>

            <form className="grid gap-3 rounded-md border p-4" onSubmit={(e) => void handleRollback(e)}>
              <p className="text-sm font-medium">Rollback channel</p>
              <div className="grid gap-2">
                <Label htmlFor="rollback-channel">Channel</Label>
                <select
                  id="rollback-channel"
                  className={selectClass}
                  value={rollbackChannel}
                  onChange={(e) => setRollbackChannel(e.target.value as "dev" | "staging" | "prod")}
                >
                  <option value="dev">Development</option>
                  <option value="staging">Staging</option>
                  <option value="prod">Production (approval required)</option>
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rollback-notes">Rollback reason</Label>
                <Input
                  id="rollback-notes"
                  value={rollbackNotes}
                  onChange={(e) => setRollbackNotes(e.target.value)}
                  placeholder="What issue triggered rollback"
                />
              </div>
              {!canEdit && <p className="text-xs text-destructive">Requires editor role or higher.</p>}
              <Button type="submit" variant="destructive" disabled={pending === "rollback" || !canEdit}>
                {pending === "rollback"
                  ? "Submitting..."
                  : rollbackChannel === "prod"
                    ? "Request production rollback"
                    : "Rollback channel"}
              </Button>
            </form>
          </div>

          <div className="grid gap-2">
            <p className="text-sm font-medium">Recent promotions and rollbacks</p>
            <div className="max-h-[480px] overflow-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Bundle</th>
                    <th className="px-3 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {props.activations.slice(0, 20).map((activation) => (
                    <tr key={activation.id} className="border-t">
                      <td className="px-3 py-2">{activation.channel}</td>
                      <td className="px-3 py-2">
                        <Badge variant={activation.state === "active" ? "secondary" : "destructive"}>
                          {activation.state}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{shortID(activation.bundleId, 14)}</td>
                      <td className="px-3 py-2">{formatTimestamp(activation.activatedAt)}</td>
                    </tr>
                  ))}
                  {props.activations.length === 0 && (
                    <tr>
                      <td className="px-3 py-4 text-muted-foreground" colSpan={4}>
                        No activation history yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Approvals queue</CardTitle>
          <CardDescription>Approvers review and finalize pending production rollout requests.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!canApprove && (
            <p className="text-sm text-muted-foreground">
              Pending requests are visible, but approving or rejecting requires approver role or higher.
            </p>
          )}
          <div className="max-h-[360px] overflow-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Bundle</th>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">Review</th>
                </tr>
              </thead>
              <tbody>
                {pendingApprovals.map((request) => (
                  <tr key={request.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <Badge variant={request.state === "pending" ? "secondary" : "outline"}>{request.state}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-muted-foreground">{request.channel}</div>
                      <div>{request.action === "promote_bundle" ? "Promote bundle" : "Rollback channel"}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{shortID(request.bundleId, 14)}</td>
                    <td className="px-3 py-2">
                      <div>{request.requestedBy}</div>
                      <div className="text-xs text-muted-foreground">{formatTimestamp(request.createdAt)}</div>
                    </td>
                    <td className="space-y-2 px-3 py-2">
                      <Input
                        value={reviewNotesById[request.id] ?? ""}
                        onChange={(e) =>
                          setReviewNotesById((current) => ({ ...current, [request.id]: e.target.value }))
                        }
                        placeholder="Review note (optional)"
                        disabled={!canApprove}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={!canApprove || pending === `approve:${request.id}`}
                          onClick={() => void handleApproveRequest(request.id)}
                        >
                          {pending === `approve:${request.id}` ? "Approving..." : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canApprove || pending === `reject:${request.id}`}
                          onClick={() => void handleRejectRequest(request.id)}
                        >
                          {pending === `reject:${request.id}` ? "Rejecting..." : "Reject"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {pendingApprovals.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                      No pending approval requests.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Integration access tokens</CardTitle>
          <CardDescription>Create and revoke tokens used by bundle consumers such as OPA.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!canApprove && <p className="text-sm text-muted-foreground">Requires approver role or higher.</p>}
          <form
            className="grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_1fr_auto] md:items-end"
            onSubmit={(e) => void handleCreateServiceToken(e)}
          >
            <div className="grid gap-2">
              <Label htmlFor="token-name">Token name</Label>
              <Input
                id="token-name"
                value={serviceTokenName}
                onChange={(e) => setServiceTokenName(e.target.value)}
                placeholder="opa-prod-reader"
                disabled={!canApprove}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token-scopes">Scopes (comma separated)</Label>
              <Input
                id="token-scopes"
                value={serviceTokenScopes}
                onChange={(e) => setServiceTokenScopes(e.target.value)}
                placeholder="bundle:read"
                disabled={!canApprove}
              />
            </div>
            <Button type="submit" disabled={pending === "create-token" || !canApprove}>
              {pending === "create-token" ? "Creating..." : "Create token"}
            </Button>
          </form>

          {issuedServiceToken && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">Token value (shown once)</p>
              <Textarea className="mt-2 min-h-[72px] font-mono text-xs" readOnly value={issuedServiceToken} />
            </div>
          )}

          <div className="max-h-[320px] overflow-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Scopes</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {serviceTokens.map((token) => (
                  <tr key={token.id} className="border-t">
                    <td className="px-3 py-2">{token.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{token.scopes.join(", ") || "-"}</td>
                    <td className="px-3 py-2">{formatTimestamp(token.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={token.revokedAt ? "destructive" : "secondary"}>
                        {token.revokedAt ? "Revoked" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canApprove || Boolean(token.revokedAt) || pending === `revoke-token:${token.id}`}
                        onClick={() => void handleRevokeServiceToken(token.id)}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
                {serviceTokens.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                      No service tokens yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Capability grants</CardTitle>
          <CardDescription>Issue least-privilege MCP authority and revoke it when a workload no longer needs access.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="grid gap-3 rounded-md border p-4 md:grid-cols-2" onSubmit={(e) => void handleCreateCapabilityGrant(e)}>
            <div className="grid gap-2"><Label htmlFor="capability-name">Grant name</Label><Input id="capability-name" value={capabilityName} onChange={(e) => setCapabilityName(e.target.value)} disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-subject">Workload subject</Label><Input id="capability-subject" value={capabilitySubject} onChange={(e) => setCapabilitySubject(e.target.value)} placeholder="agent:payments" disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-workload-id">Workload identity (optional)</Label><Input id="capability-workload-id" value={capabilityWorkloadId} onChange={(e) => setCapabilityWorkloadId(e.target.value)} placeholder="spiffe://prod/payments" disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-servers">MCP server IDs</Label><Input id="capability-servers" value={capabilityServers} onChange={(e) => setCapabilityServers(e.target.value)} placeholder="stripe-mcp" disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-tools">Tool names</Label><Input id="capability-tools" value={capabilityTools} onChange={(e) => setCapabilityTools(e.target.value)} placeholder="create_stripe_refund" disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-max-amount">Maximum amount (cents, optional)</Label><Input id="capability-max-amount" type="number" min="0" step="1" value={capabilityMaxAmount} onChange={(e) => setCapabilityMaxAmount(e.target.value)} disabled={!canApprove} /></div>
            <div className="grid gap-2"><Label htmlFor="capability-expiry">Expiry</Label><Input id="capability-expiry" type="datetime-local" value={capabilityExpiresAt} onChange={(e) => setCapabilityExpiresAt(e.target.value)} disabled={!canApprove} /></div>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={capabilityMayDelegate} onChange={(e) => setCapabilityMayDelegate(e.target.checked)} disabled={!canApprove} />Allow delegation</label>
            <div className="flex items-end"><Button type="submit" disabled={!canApprove || pending === "create-capability"}>{pending === "create-capability" ? "Creating..." : "Create capability"}</Button></div>
          </form>
          {issuedCapability && <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><p className="font-medium">Capability credential (shown once)</p><Textarea className="mt-2 min-h-[72px] font-mono text-xs" readOnly value={issuedCapability} /></div>}
          <div className="max-h-[320px] overflow-auto rounded-md border"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Scope</th><th className="px-3 py-2">Expiry</th><th className="px-3 py-2">Action</th></tr></thead><tbody>{capabilityGrants.map((grant) => <tr key={grant.id} className="border-t"><td className="px-3 py-2">{grant.name}</td><td className="px-3 py-2 font-mono text-xs">{grant.subject}{grant.workloadId && <><br /><span className="text-muted-foreground">{grant.workloadId}</span></>}</td><td className="px-3 py-2 text-xs">{grant.serverIds.join(", ")} · {grant.toolNames.join(", ")}{grant.maxAmountCents !== undefined && <> · ≤{grant.maxAmountCents}¢</>}{grant.mayDelegate && <> · delegable</>}</td><td className="px-3 py-2">{formatTimestamp(grant.expiresAt)}</td><td className="px-3 py-2"><Button size="sm" variant="ghost" disabled={!canApprove || Boolean(grant.revokedAt) || pending === `revoke-capability:${grant.id}`} onClick={() => void handleRevokeCapabilityGrant(grant.id)}>{grant.revokedAt ? "Revoked" : "Revoke"}</Button></td></tr>)}{capabilityGrants.length === 0 && <tr><td className="px-3 py-4 text-muted-foreground" colSpan={5}>No capability grants yet.</td></tr>}</tbody></table></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bundle signing keys</CardTitle>
          <CardDescription>Create, activate, and revoke keys used for signed bundle distribution.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!canApprove && <p className="text-sm text-muted-foreground">Requires approver role or higher.</p>}
          <form className="grid gap-3 rounded-md border p-4 md:grid-cols-2" onSubmit={(e) => void handleCreateSigningKey(e)}>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                disabled={!canApprove}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-id">Key ID (optional)</Label>
              <Input id="key-id" value={keyId} onChange={(e) => setKeyId(e.target.value)} disabled={!canApprove} />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="key-secret">{keyAlgorithm === "RS256" ? "RSA private key (PEM)" : "Shared signing secret"}</Label>
              {keyAlgorithm === "RS256" ? (
                <Textarea
                  id="key-secret"
                  className="min-h-28 font-mono text-xs"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  placeholder="Paste RSA private key PEM"
                  disabled={!canApprove}
                />
              ) : (
                <Input
                  id="key-secret"
                  type="password"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  placeholder="Paste shared signing secret"
                  disabled={!canApprove}
                />
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-algorithm">Algorithm</Label>
              <select
                id="key-algorithm"
                className={selectClass}
                value={keyAlgorithm}
                onChange={(e) => setKeyAlgorithm(e.target.value === "HS256" ? "HS256" : "RS256")}
                disabled={!canApprove}
              >
                <option value="RS256">RS256 (recommended)</option>
                <option value="HS256">HS256 (legacy/shared secret)</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-scope">Scope</Label>
              <Input
                id="key-scope"
                value={keyScope}
                onChange={(e) => setKeyScope(e.target.value)}
                disabled={!canApprove}
              />
            </div>
            <div className="flex items-center gap-2 self-end">
              <input
                id="key-activate"
                type="checkbox"
                checked={activateKeyNow}
                onChange={(e) => setActivateKeyNow(e.target.checked)}
                disabled={!canApprove}
              />
              <Label htmlFor="key-activate">Activate immediately</Label>
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={pending === "create-key" || !canApprove}>
                {pending === "create-key" ? "Creating..." : "Create signing key"}
              </Button>
            </div>
          </form>

          <div className="max-h-[320px] overflow-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Key ID</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Algorithm</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {signingKeys.map((key) => (
                  <tr key={key.id} className="border-t">
                    <td className="px-3 py-2">{key.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{key.keyId}</td>
                    <td className="px-3 py-2">{key.scope}</td>
                    <td className="px-3 py-2 font-mono text-xs">{key.algorithm}</td>
                    <td className="px-3 py-2">
                      {key.revokedAt ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : key.isActive ? (
                        <Badge>Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            !canApprove ||
                            Boolean(key.revokedAt) ||
                            key.isActive ||
                            pending === `activate-key:${key.id}`
                          }
                          onClick={() => void handleActivateSigningKey(key.id)}
                        >
                          Activate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canApprove || Boolean(key.revokedAt) || pending === `revoke-key:${key.id}`}
                          onClick={() => void handleRevokeSigningKey(key.id)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {signingKeys.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-muted-foreground" colSpan={5}>
                      No signing keys yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

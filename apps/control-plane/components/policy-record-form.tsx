"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneHeaders } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";
import type { PolicyRecord, RolloutState } from "@/lib/types";

const ROLLOUT: RolloutState[] = ["draft", "shadow", "canary", "enforced", "rolled_back"];
const ROLLOUT_LABELS: Record<RolloutState, string> = {
  draft: "Draft (not enforced)",
  shadow: "Monitoring only",
  canary: "Limited enforcement",
  enforced: "Live enforcement",
  rolled_back: "Rolled back"
};

const selectClass = cn(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
);

type Props =
  | { mode: "create"; initialPolicy?: undefined }
  | { mode: "edit"; initialPolicy: PolicyRecord };

export function PolicyRecordForm(props: Props) {
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const initial = isEdit ? props.initialPolicy : null;

  const [id, setId] = useState(() => initial?.id ?? `policy-${Date.now()}`);
  const [name, setName] = useState(initial?.name ?? "Example policy");
  const [packageName, setPackageName] = useState(initial?.packageName ?? "arbiter.authz");
  const [version, setVersion] = useState(initial?.version ?? "1");
  const [rolloutState, setRolloutState] = useState<RolloutState>(initial?.rolloutState ?? "draft");
  const [rulesText, setRulesText] = useState(() =>
    initial ? JSON.stringify(initial.rules, null, 2) : "{}"
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let rules: Record<string, unknown>;
    try {
      rules = JSON.parse(rulesText) as Record<string, unknown>;
    } catch {
      setError("Rules must be valid JSON.");
      return;
    }

    setPending(true);
    try {
      if (props.mode === "create") {
        const res = await fetch("/api/policies", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...controlPlaneHeaders()
          },
          body: JSON.stringify({
            id: id.trim(),
            name: name.trim(),
            packageName: packageName.trim(),
            version: version.trim(),
            rolloutState,
            rules
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((data as { error?: string }).error ?? `HTTP ${res.status}`);
          return;
        }
        router.push(`/policies/${encodeURIComponent(id.trim())}`);
      } else {
        const res = await fetch(`/api/policies/${encodeURIComponent(props.initialPolicy.id)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...controlPlaneHeaders()
          },
          body: JSON.stringify({
            name: name.trim(),
            packageName: packageName.trim(),
            version: version.trim(),
            rolloutState,
            rules
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError((data as { error?: string }).error ?? `HTTP ${res.status}`);
          return;
        }
        router.push(`/policies/${encodeURIComponent(props.initialPolicy.id)}`);
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-lg gap-4">
      <div className="grid gap-2">
        <Label htmlFor="policy-id">Rule ID</Label>
        <Input
          id="policy-id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
          disabled={isEdit}
          className={isEdit ? "opacity-80" : undefined}
        />
        {isEdit && <p className="text-xs text-muted-foreground">Rule ID cannot be changed after creation.</p>}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="policy-name">Rule name</Label>
        <Input id="policy-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pkg">Policy package</Label>
        <Input id="pkg" value={packageName} onChange={(e) => setPackageName(e.target.value)} required />
        <p className="text-xs text-muted-foreground">Keep the package aligned with your Rego policy bundle.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ver">Revision</Label>
          <Input id="ver" value={version} onChange={(e) => setVersion(e.target.value)} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rollout">Enforcement stage</Label>
          <select
            id="rollout"
            className={selectClass}
            value={rolloutState}
            onChange={(e) => setRolloutState(e.target.value as RolloutState)}
          >
            {ROLLOUT.map((s) => (
              <option key={s} value={s}>
                {ROLLOUT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="rules">Rule metadata (JSON)</Label>
        <Textarea
          id="rules"
          className="min-h-[140px] font-mono text-sm"
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          This metadata is stored by the control plane. Runtime Rego still lives under <code>policy/</code>.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending
          ? "Saving…"
          : isEdit
            ? "Save changes"
            : "Create policy & open detail"}
      </Button>
    </form>
  );
}

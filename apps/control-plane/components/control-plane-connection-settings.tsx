"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clearControlPlaneClientConfig,
  loadControlPlaneClientConfig,
  saveControlPlaneClientConfig
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS = ["", "viewer", "editor", "approver", "admin"] as const;

const selectClass = cn(
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
);

type Props = {
  title?: string;
  description?: string;
};

export function ControlPlaneConnectionSettings({
  title = "Connection Settings",
  description = "Optional headers for secured deployments. Saved only in this browser."
}: Props) {
  const [controlKey, setControlKey] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadControlPlaneClientConfig();
    setControlKey(saved.controlKey);
    setTenantId(saved.tenantId);
    setRole(saved.role);
  }, []);

  function handleSave() {
    saveControlPlaneClientConfig({ controlKey, tenantId, role });
    setStatus("Saved. New requests will include these headers.");
  }

  function handleClear() {
    clearControlPlaneClientConfig();
    setControlKey("");
    setTenantId("");
    setRole("");
    setStatus("Cleared.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="cp-key">Control API key (optional)</Label>
          <Input
            id="cp-key"
            type="password"
            placeholder="X-Arbiter-Control-Key"
            value={controlKey}
            onChange={(e) => setControlKey(e.target.value)}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="cp-tenant">Tenant ID (optional)</Label>
            <Input
              id="cp-tenant"
              placeholder="default"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-role">Role (optional)</Label>
            <select id="cp-role" className={selectClass} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option || "unset"}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={handleSave}>
            Save settings
          </Button>
          <Button type="button" variant="ghost" onClick={handleClear}>
            Clear
          </Button>
        </div>
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
      </CardContent>
    </Card>
  );
}


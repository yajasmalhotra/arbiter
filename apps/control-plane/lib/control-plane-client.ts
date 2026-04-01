"use client";

import {
  CONTROL_PLANE_AUTH_HEADER,
  CONTROL_PLANE_ROLE_HEADER,
  CONTROL_PLANE_TENANT_HEADER
} from "./control-plane-headers";

export type ControlPlaneClientConfig = {
  controlKey: string;
  tenantId: string;
  role: string;
};

const STORAGE_KEY = "arbiter-control-plane-client-config";

const EMPTY_CONFIG: ControlPlaneClientConfig = {
  controlKey: "",
  tenantId: "",
  role: ""
};

export function loadControlPlaneClientConfig(): ControlPlaneClientConfig {
  if (typeof window === "undefined") {
    return EMPTY_CONFIG;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return EMPTY_CONFIG;
    }
    const parsed = JSON.parse(raw) as Partial<ControlPlaneClientConfig>;
    return {
      controlKey: String(parsed.controlKey ?? "").trim(),
      tenantId: String(parsed.tenantId ?? "").trim(),
      role: String(parsed.role ?? "").trim()
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function saveControlPlaneClientConfig(
  next: Partial<ControlPlaneClientConfig>
): ControlPlaneClientConfig {
  const normalized: ControlPlaneClientConfig = {
    controlKey: String(next.controlKey ?? "").trim(),
    tenantId: String(next.tenantId ?? "").trim(),
    role: String(next.role ?? "").trim()
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function clearControlPlaneClientConfig(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(STORAGE_KEY);
}

export function controlPlaneHeaders(
  config: Partial<ControlPlaneClientConfig> = loadControlPlaneClientConfig()
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.controlKey?.trim()) {
    headers[CONTROL_PLANE_AUTH_HEADER] = config.controlKey.trim();
  }
  if (config.tenantId?.trim()) {
    headers[CONTROL_PLANE_TENANT_HEADER] = config.tenantId.trim();
  }
  if (config.role?.trim()) {
    headers[CONTROL_PLANE_ROLE_HEADER] = config.role.trim();
  }
  return headers;
}


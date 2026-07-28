"use client";

import {
  CONTROL_PLANE_AUTH_HEADER,
  CONTROL_PLANE_IDENTITY_COOKIE,
  CONTROL_PLANE_ROLE_HEADER,
  CONTROL_PLANE_TENANT_HEADER
} from "./control-plane-headers";

export type ControlPlaneClientConfig = {
  controlKey: string;
  identityToken: string;
  tenantId: string;
  role: string;
};

const STORAGE_KEY = "arbiter-control-plane-client-config";

const EMPTY_CONFIG: ControlPlaneClientConfig = {
  controlKey: "",
  identityToken: "",
  tenantId: "",
  role: ""
};

const UPDATE_EVENT = "arbiter-control-plane-client-config-updated";

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
      identityToken: String(parsed.identityToken ?? "").trim(),
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
    identityToken: String(next.identityToken ?? "").trim(),
    tenantId: String(next.tenantId ?? "").trim(),
    role: String(next.role ?? "").trim()
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    if (normalized.identityToken) {
      document.cookie = `${CONTROL_PLANE_IDENTITY_COOKIE}=${encodeURIComponent(normalized.identityToken)}; Path=/; SameSite=Lax; Secure`;
    } else {
      document.cookie = `${CONTROL_PLANE_IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
    }
    window.dispatchEvent(new Event(UPDATE_EVENT));
  }
  return normalized;
}

export function clearControlPlaneClientConfig(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(STORAGE_KEY);
  document.cookie = `${CONTROL_PLANE_IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

export function controlPlaneHeaders(
  config: Partial<ControlPlaneClientConfig> = loadControlPlaneClientConfig()
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.controlKey?.trim()) {
    headers[CONTROL_PLANE_AUTH_HEADER] = config.controlKey.trim();
  }
  if (config.identityToken?.trim()) {
    headers.authorization = `Bearer ${config.identityToken.trim()}`;
  }
  if (config.tenantId?.trim()) {
    headers[CONTROL_PLANE_TENANT_HEADER] = config.tenantId.trim();
  }
  if (config.role?.trim()) {
    headers[CONTROL_PLANE_ROLE_HEADER] = config.role.trim();
  }
  return headers;
}

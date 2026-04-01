import type { BundleStatus, RolloutState } from "./types";

const ROLLOUT_LABELS: Record<RolloutState, string> = {
  draft: "Draft",
  shadow: "Monitoring",
  canary: "Limited rollout",
  enforced: "Live protection",
  rolled_back: "Rolled back"
};

const BUNDLE_STATUS_LABELS: Record<BundleStatus, string> = {
  draft: "Draft",
  published: "Published",
  active: "Active",
  rolled_back: "Rolled back"
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  policy_created: "Policy created",
  policy_updated: "Policy updated",
  policy_deleted: "Policy deleted",
  rollout_state_changed: "Policy rollout changed",
  bundle_published: "Bundle published",
  bundle_promoted: "Bundle promoted",
  bundle_activated: "Bundle promoted",
  bundle_rolled_back: "Bundle rollback completed",
  approval_requested: "Approval requested",
  approval_approved: "Approval approved",
  approval_rejected: "Approval rejected",
  service_token_created: "Integration token created",
  service_token_revoked: "Integration token revoked",
  signing_key_created: "Signing key created",
  signing_key_created_and_activated: "Signing key created and activated",
  signing_key_activated: "Signing key activated",
  signing_key_revoked: "Signing key revoked",
  intercept_decision: "Intercept decision recorded"
};

export function rolloutLabel(state: string): string {
  return ROLLOUT_LABELS[state as RolloutState] ?? state;
}

export function bundleStatusLabel(status: BundleStatus): string {
  return BUNDLE_STATUS_LABELS[status] ?? status;
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replaceAll("_", " ");
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function shortID(value: string, head = 8): string {
  if (!value) {
    return "";
  }
  if (value.length <= head) {
    return value;
  }
  return `${value.slice(0, head)}…`;
}

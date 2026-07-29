import { describe, expect, it } from "vitest";

import { clearControlPlaneRequestContext, runWithControlPlaneRequestContext } from "./context";
import { authoritativeActor } from "./store";

describe("authoritative control-plane actor", () => {
  it("uses a trusted request identity over a caller-provided actor", () => {
    const actor = runWithControlPlaneRequestContext(
      { tenantId: "tenant-a", actor: "oidc:alice", roles: ["admin"] },
      () => authoritativeActor("forged:admin")
    );
    expect(actor).toBe("oidc:alice");
  });

  it("retains a caller actor only when no signed request context exists", () => {
    clearControlPlaneRequestContext();
    expect(authoritativeActor("trusted-server-job")).toBe("trusted-server-job");
  });
});

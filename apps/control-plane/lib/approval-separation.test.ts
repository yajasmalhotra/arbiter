import { describe, expect, it } from "vitest";

import { assertIndependentApprovalReviewer } from "./store";

describe("production approval separation of duties", () => {
  it("rejects self-approval for a production rollout", () => {
    expect(() =>
      assertIndependentApprovalReviewer({ channel: "prod", requestedBy: "oidc:alice" }, "oidc:alice")
    ).toThrow("production approval must be reviewed by a different actor than the requester");
  });

  it("allows an independent approver", () => {
    expect(() =>
      assertIndependentApprovalReviewer({ channel: "prod", requestedBy: "oidc:alice" }, "oidc:bob")
    ).not.toThrow();
  });
});

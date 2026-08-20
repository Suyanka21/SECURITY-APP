/**
 * approvalHandoff — the mirror that lets the guard console resume an awaiting
 * approval after the resident magic link navigates away from it.
 *
 * Pinned here: a corrupt or stale mirror is discarded (never resumed, never
 * able to wedge the console) and a forgotten mirror stays forgotten.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetPendingApproval,
  readPendingApproval,
  rememberPendingApproval,
} from "../approvalHandoff";
import type { PendingApproval } from "../types";

const KEY = "gatepass_pending_approval";

const APPROVAL: PendingApproval = {
  id: "11111111-1111-4111-8111-111111111111",
  draft: {
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: null,
    reason: "",
    method: "walk-in",
  },
  magicLinkUrl: "http://localhost:5173/approve/x?token=abc",
  expiresAt: "2024-01-01T00:05:00Z",
  status: "pending",
  traceId: "trace-create",
};

describe("approvalHandoff", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips an awaiting approval", () => {
    rememberPendingApproval(APPROVAL);
    expect(readPendingApproval()).toEqual(APPROVAL);
  });

  it("returns null once forgotten", () => {
    rememberPendingApproval(APPROVAL);
    forgetPendingApproval();
    expect(readPendingApproval()).toBeNull();
  });

  it("returns null when nothing was stored", () => {
    expect(readPendingApproval()).toBeNull();
  });

  it("discards unparseable content instead of throwing", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readPendingApproval()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("discards a structurally invalid mirror", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ approval: { id: "" }, storedAt: Date.now() }),
    );
    expect(readPendingApproval()).toBeNull();
  });

  it("discards a mirror older than a day (previous shift)", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        approval: APPROVAL,
        storedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    expect(readPendingApproval()).toBeNull();
  });

  it("keeps only the latest awaiting approval", () => {
    rememberPendingApproval(APPROVAL);
    rememberPendingApproval({ ...APPROVAL, id: "second", magicLinkUrl: "u2" });
    expect(readPendingApproval()?.id).toBe("second");
  });
});

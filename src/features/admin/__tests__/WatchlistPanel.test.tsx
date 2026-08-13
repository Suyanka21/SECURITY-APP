/**
 * WatchlistPanel — Feature 12 (Stage 5) RTL tests.
 *
 * Source: src/docs/specs/watchlist.md §2, §3, §7.
 *
 * Acceptance criteria pinned here:
 *   1. Loading, empty, error and populated states all render.
 *   2. Reason is marked required and carries a live character counter.
 *   3. Create sends the typed reason verbatim.
 *   4. Overdue entries are labelled in TEXT (not colour alone) and still
 *      appear in the active list — nothing silently disappears.
 *   5. Reconfirm resets the review clock via PATCH.
 *   6. Removal is impossible without a removal reason.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WatchlistPanel } from "../WatchlistPanel";
import { watchlistApi } from "@/lib/api/watchlist";
import type { WatchlistEntryView } from "@/lib/api/types";

vi.mock("@/lib/api/watchlist", () => ({
  watchlistApi: {
    list: vi.fn(),
    create: vi.fn(),
    review: vi.fn(),
    remove: vi.fn(),
  },
}));

const mocked = vi.mocked(watchlistApi);

function entry(overrides: Partial<WatchlistEntryView> = {}): WatchlistEntryView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    subjectName: "Mara Osei",
    subjectPlate: "KJA019",
    reason: "Barred after an altercation with staff.",
    status: "active",
    addedByGuardId: "guard-1",
    lastReviewedAt: "2026-01-01T00:00:00.000Z",
    reviewDueAt: "2026-04-01T00:00:00.000Z",
    reviewOverdue: false,
    removedByGuardId: null,
    removedReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function listOk(entries: WatchlistEntryView[], overdueCount = 0) {
  return {
    ok: true as const,
    status: 200,
    data: { entries, count: entries.length, overdueCount, traceId: "t" },
  };
}

describe("WatchlistPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading state, then the entries", async () => {
    mocked.list.mockResolvedValue(listOk([entry()]));
    render(<WatchlistPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading watchlist/i);
    expect(await screen.findByText("Mara Osei")).toBeInTheDocument();
    expect(
      screen.getByText("Barred after an altercation with staff."),
    ).toBeInTheDocument();
  });

  it("shows an explicit empty state", async () => {
    mocked.list.mockResolvedValue(listOk([]));
    render(<WatchlistPanel />);

    expect(
      await screen.findByText(/no watchlist entries match this filter/i),
    ).toBeInTheDocument();
  });

  it("surfaces a load failure as an alert", async () => {
    mocked.list.mockResolvedValue({
      ok: false as const,
      status: 403,
      error: { code: "AUTH_FORBIDDEN", message: "Admins only.", traceId: "t" },
    });
    render(<WatchlistPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Admins only.");
  });

  it("marks the reason required and counts characters", async () => {
    mocked.list.mockResolvedValue(listOk([]));
    render(<WatchlistPanel />);
    await screen.findByText(/no watchlist entries/i);

    const reason = screen.getByLabelText(/reason/i, { selector: "textarea" });
    expect(reason).toBeRequired();
    expect(screen.getByText(/0\/500/)).toBeInTheDocument();

    fireEvent.change(reason, { target: { value: "Barred." } });
    expect(screen.getByText(/7\/500/)).toBeInTheDocument();
  });

  it("creates an entry with the reason typed by the admin", async () => {
    mocked.list.mockResolvedValue(listOk([]));
    mocked.create.mockResolvedValue({
      ok: true as const,
      status: 201,
      data: { entry: entry(), traceId: "t" },
    });
    render(<WatchlistPanel />);
    await screen.findByText(/no watchlist entries/i);

    fireEvent.change(screen.getByLabelText(/subject name/i), {
      target: { value: "Mara Osei" },
    });
    fireEvent.change(screen.getByLabelText(/reason/i, { selector: "textarea" }), {
      target: { value: "Barred after an altercation with staff." },
    });
    fireEvent.click(screen.getByRole("button", { name: /add to watchlist/i }));

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    expect(mocked.create).toHaveBeenCalledWith({
      subjectName: "Mara Osei",
      reason: "Barred after an altercation with staff.",
    });
  });

  it("labels an overdue entry in text and keeps it in the list", async () => {
    mocked.list.mockResolvedValue(listOk([entry({ reviewOverdue: true })], 1));
    render(<WatchlistPanel />);

    expect(await screen.findByText(/review overdue/i)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue for review/i)).toBeInTheDocument();
    expect(screen.getByText("Mara Osei")).toBeInTheDocument();
  });

  it("reconfirms an entry, resetting the review clock", async () => {
    mocked.list.mockResolvedValue(listOk([entry({ reviewOverdue: true })], 1));
    mocked.review.mockResolvedValue({
      ok: true as const,
      status: 200,
      data: { entry: entry(), traceId: "t" },
    });
    render(<WatchlistPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /reconfirm/i }));

    await waitFor(() =>
      expect(mocked.review).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
      ),
    );
  });

  it("requires a removal reason before removing", async () => {
    mocked.list.mockResolvedValue(listOk([entry()]));
    mocked.remove.mockResolvedValue({
      ok: true as const,
      status: 200,
      data: { entry: entry({ status: "removed" }), traceId: "t" },
    });
    render(<WatchlistPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /remove/i }));

    const confirm = screen.getByRole("button", { name: /confirm removal/i });
    expect(confirm).toBeDisabled();
    expect(mocked.remove).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/removal reason/i), {
      target: { value: "Dispute resolved with the resident." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm removal/i }));

    await waitFor(() =>
      expect(mocked.remove).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        { removedReason: "Dispute resolved with the resident." },
      ),
    );
  });

  it("filters to review-overdue entries only", async () => {
    mocked.list.mockResolvedValue(listOk([entry()]));
    render(<WatchlistPanel />);
    await screen.findByText("Mara Osei");

    fireEvent.click(screen.getByLabelText(/review overdue only/i));

    await waitFor(() =>
      expect(mocked.list).toHaveBeenLastCalledWith({
        status: "active",
        needsReview: true,
      }),
    );
  });
});

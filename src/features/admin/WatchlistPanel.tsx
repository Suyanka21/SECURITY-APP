/**
 * GatePass — Admin watchlist panel (Feature 12 / Stage 5).
 *
 * Source: src/docs/specs/watchlist.md §§2–3, §7 (Option 2 — periodic review).
 * Source: src/features/admin/AccountProvisioningPanel.tsx (panel pattern).
 * Source: Frontend-UI-Engineering — explicit loading / empty / error states,
 *         keyboard-accessible native controls, status conveyed by text+icon
 *         (never colour alone).
 *
 * The endpoints behind this panel are admin/senior-guard only server-side;
 * this panel renders inside AdminDashboard, which is only reachable with a
 * DB-assigned admin role. The UI is a convenience, never the control.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, Clock, Loader2, ShieldAlert, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { watchlistApi } from "@/lib/api/watchlist";
import type { WatchlistEntryView, WatchlistStatus } from "@/lib/api/types";

const REASON_MAX = 500;

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: WatchlistEntryView[]; overdueCount: number };

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string; field?: string };

type StatusFilter = WatchlistStatus | "all";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function WatchlistPanel() {
  const nameId = useId();
  const plateId = useId();
  const reasonId = useId();
  const reasonHintId = useId();

  const [list, setList] = useState<ListState>({ status: "loading" });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [subjectName, setSubjectName] = useState("");
  const [subjectPlate, setSubjectPlate] = useState("");
  const [reason, setReason] = useState("");
  const [form, setForm] = useState<FormState>({ status: "idle" });
  const [busyId, setBusyId] = useState<string | null>(null);
  // Which row has its removal form open, and the reason typed into it.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removedReason, setRemovedReason] = useState("");

  const load = useCallback(async () => {
    setList({ status: "loading" });
    const res = await watchlistApi.list({
      status: statusFilter,
      needsReview: overdueOnly,
    });
    if (res.ok) {
      setList({
        status: "ready",
        entries: res.data.entries,
        overdueCount: res.data.overdueCount,
      });
    } else {
      setList({ status: "error", message: res.error.message });
    }
  }, [statusFilter, overdueOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setForm({ status: "submitting" });

    const res = await watchlistApi.create({
      subjectName: subjectName.trim(),
      ...(subjectPlate.trim() ? { subjectPlate: subjectPlate.trim() } : {}),
      reason: reason.trim(),
    });

    if (res.ok) {
      setSubjectName("");
      setSubjectPlate("");
      setReason("");
      setForm({ status: "idle" });
      await load();
    } else {
      setForm({
        status: "error",
        message: res.error.message,
        field: res.error.field,
      });
    }
  };

  const onReconfirm = async (entry: WatchlistEntryView) => {
    setBusyId(entry.id);
    const res = await watchlistApi.review(entry.id);
    setBusyId(null);
    if (res.ok) await load();
    else setList({ status: "error", message: res.error.message });
  };

  const onRemove = async (event: React.FormEvent, entry: WatchlistEntryView) => {
    event.preventDefault();
    // Removal must stay explainable — no reason, no removal.
    if (!removedReason.trim()) return;

    setBusyId(entry.id);
    const res = await watchlistApi.remove(entry.id, {
      removedReason: removedReason.trim(),
    });
    setBusyId(null);
    if (res.ok) {
      setRemovingId(null);
      setRemovedReason("");
      await load();
    } else {
      setList({ status: "error", message: res.error.message });
    }
  };

  const submitting = form.status === "submitting";

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm md:col-span-2">
      <header className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          Watchlist
        </h2>
        <p className="text-xs text-muted-foreground">
          A match warns the guard with the reason and requires supervisor
          escalation. It never blocks entry automatically. Entries stay active
          until someone removes them — they are re-reviewed every 90 days.
        </p>
      </header>

      {/* ── Create ─────────────────────────────────────────────────────── */}
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={onCreate}>
        <div className="flex flex-col gap-1">
          <Label htmlFor={nameId}>
            Subject name <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </Label>
          <Input
            id={nameId}
            value={subjectName}
            onChange={(e) => setSubjectName(e.target.value)}
            autoComplete="off"
            maxLength={120}
            required
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={plateId}>
            Plate{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id={plateId}
            value={subjectPlate}
            onChange={(e) => setSubjectPlate(e.target.value)}
            autoComplete="off"
            maxLength={32}
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor={reasonId}>
            Reason <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </Label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={reasonHintId}
            maxLength={REASON_MAX}
            rows={2}
            required
            disabled={submitting}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span id={reasonHintId} className="text-xs text-muted-foreground">
            Required. Guards see this text verbatim. {reason.length}/{REASON_MAX}
          </span>
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={submitting}>
            {submitting && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Add to watchlist
          </Button>
        </div>
      </form>

      {form.status === "error" && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {form.message}
          {form.field ? ` (${form.field})` : ""}
        </div>
      )}

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Label htmlFor="watchlist-status-filter" className="text-xs">
          Show
        </Label>
        <select
          id="watchlist-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="active">Active</option>
          <option value="removed">Removed</option>
          <option value="all">All</option>
        </select>

        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Review overdue only
        </label>

        {list.status === "ready" && list.overdueCount > 0 && (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {list.overdueCount} overdue for review
          </span>
        )}
      </div>

      {/* ── List ───────────────────────────────────────────────────────── */}
      <div className="mt-3">
        {list.status === "loading" && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading watchlist…
          </p>
        )}

        {list.status === "error" && (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {list.message}
          </div>
        )}

        {list.status === "ready" && list.entries.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No watchlist entries match this filter.
          </p>
        )}

        {list.status === "ready" && list.entries.length > 0 && (
          <ul className="divide-y divide-border">
            {list.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {entry.subjectName}
                    {entry.subjectPlate && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.subjectPlate}
                      </span>
                    )}
                    {entry.status === "removed" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        Removed
                      </span>
                    )}
                    {entry.reviewOverdue && (
                      <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        Review overdue
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 break-words text-sm text-muted-foreground">
                    {entry.reason}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.status === "removed"
                      ? `Removed: ${entry.removedReason ?? "—"}`
                      : `Next review ${formatDate(entry.reviewDueAt)}`}
                  </p>
                </div>

                {entry.status === "active" && (
                  <div className="flex items-start gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyId === entry.id}
                      onClick={() => void onReconfirm(entry)}
                    >
                      Reconfirm
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyId === entry.id}
                      onClick={() => {
                        setRemovingId(
                          removingId === entry.id ? null : entry.id,
                        );
                        setRemovedReason("");
                      }}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Remove
                    </Button>
                  </div>
                )}

                {removingId === entry.id && (
                  <form
                    className="flex w-full flex-wrap items-end gap-2"
                    onSubmit={(e) => void onRemove(e, entry)}
                  >
                    <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
                      <Label htmlFor={`remove-reason-${entry.id}`} className="text-xs">
                        Removal reason <span aria-hidden="true">*</span>
                        <span className="sr-only">(required)</span>
                      </Label>
                      <Input
                        id={`remove-reason-${entry.id}`}
                        value={removedReason}
                        onChange={(e) => setRemovedReason(e.target.value)}
                        maxLength={REASON_MAX}
                        required
                        disabled={busyId === entry.id}
                      />
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busyId === entry.id || !removedReason.trim()}
                    >
                      Confirm removal
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Entries are never deleted or auto-expired. An overdue entry keeps
        warning guards until someone reconfirms or removes it with a reason.
      </p>
    </section>
  );
}

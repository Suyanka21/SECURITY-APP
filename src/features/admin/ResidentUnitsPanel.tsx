/**
 * GatePass — Admin panel for units, claim codes, residents and a unit's
 * registrations (R4a).
 *
 * Source: src/docs/specs/resident-admin-panels.md §3–§4.
 *
 * Every route behind this panel is requireRole("admin") on the server; the
 * panel only renders inside AdminDashboard. The UI is a convenience, never
 * the control.
 *
 * - A claim code lives only in UnitDetail's state: never in a store,
 *   localStorage, a URL or a log. UnitDetail is keyed by unit, so the code
 *   is gone on Dismiss, when another unit is selected, and on unmount.
 * - Residents show `phoneMasked` exactly as the server sends it; the server
 *   never sends an admin the full number.
 */

import { useCallback, useEffect, useId, useState } from "react";
import { Building2, Copy, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiErrorBody } from "@/lib/api/types";
import { autoApprovalApi } from "@/lib/api/auto-approval";
import {
  residentAdminApi,
  UNIT_LABEL_MAX,
  type AdminRegistrationStatus,
  type AdminRegistrationView,
  type AdminResidentView,
  type ClaimCodeIssued,
  type UnitView,
} from "@/lib/api/resident-admin";

const REASON_MIN = 3;
const REASON_MAX = 500;

type Load<T> =
  | { status: "loading" }
  | { status: "error"; error: ApiErrorBody }
  | { status: "ready"; data: T };

const STATUS_LABEL: Record<AdminRegistrationStatus, string> = {
  active: "Active",
  renew_due: "Renew due",
  expired: "Expired",
  disabled: "Switched off",
  removed: "Removed by resident",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ErrorBox({ error }: { error: ApiErrorBody }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <span className="font-medium">{error.code}</span> — {error.message}
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading {what}…
    </p>
  );
}

function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<{ ok: true; data: T } | { ok: false; error: ApiErrorBody }>) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void fetcher(controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      setState(res.ok ? { status: "ready", data: res.data } : { status: "error", error: res.error });
    });
    return () => controller.abort();
  }, [fetcher, nonce]);
  return { state, reload };
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ResidentUnitsPanel() {
  const labelId = useId();
  const labelHintId = useId();
  const [includeInactive, setIncludeInactive] = useState(false);
  const fetchUnits = useCallback(
    (signal: AbortSignal) => residentAdminApi.listUnits(includeInactive, signal),
    [includeInactive],
  );
  const units = useLoad(fetchUnits);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Lives here, not in UnitDetail: a deactivated unit drops out of the
  // default list, which unmounts its detail.
  const [unitNotice, setUnitNotice] = useState<string | null>(null);

  const selectUnit = (id: string) => {
    setSelectedId(id);
    setUnitNotice(null);
  };

  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiErrorBody | null>(null);

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await residentAdminApi.createUnit(label.trim());
    setCreating(false);
    if (res.ok) {
      setLabel("");
      selectUnit(res.data.unit.id);
      units.reload();
    } else {
      setCreateError(res.error);
    }
  };

  const unitList = units.state.status === "ready" ? units.state.data.units : [];
  const selected = unitList.find((u) => u.id === selectedId) ?? null;
  const trimmedLength = label.trim().length;

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm md:col-span-2">
      <header className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          Units and residents
        </h2>
        <p className="text-xs text-muted-foreground">
          Create units, give a resident a one-time claim code, and manage the
          residents and registrations of a unit.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* ── (a) Units ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <form className="flex flex-col gap-1" onSubmit={onCreate}>
            <Label htmlFor={labelId}>New unit label</Label>
            <div className="flex gap-2">
              <Input
                id={labelId}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={UNIT_LABEL_MAX}
                aria-describedby={labelHintId}
                aria-invalid={createError?.field === "label" || undefined}
                autoComplete="off"
                disabled={creating}
              />
              <Button type="submit" size="sm" disabled={creating || trimmedLength === 0}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Create
              </Button>
            </div>
            <span id={labelHintId} className="text-xs text-muted-foreground">
              1–{UNIT_LABEL_MAX} characters. {trimmedLength}/{UNIT_LABEL_MAX}
            </span>
            {createError && <ErrorBox error={createError} />}
          </form>

          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            Include inactive units
          </label>

          {units.state.status === "loading" && <Loading what="units" />}
          {units.state.status === "error" && <ErrorBox error={units.state.error} />}
          {units.state.status === "ready" && unitList.length === 0 && (
            <p className="text-sm text-muted-foreground">No units yet.</p>
          )}
          {unitList.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Units">
              {unitList.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    aria-pressed={u.id === selectedId}
                    onClick={() => selectUnit(u.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                      u.id === selectedId ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
                    }`}
                  >
                    <span className="font-medium">{u.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.isActive ? `${u.activeResidentCount} resident${u.activeResidentCount === 1 ? "" : "s"}` : "Inactive"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Unit detail: (b) claim code, (c) residents, (d) registrations ── */}
        <div className="md:col-span-2">
          {unitNotice && (
            <p role="status" className="mb-3 text-sm">
              {unitNotice}
            </p>
          )}
          {selected ? (
            <UnitDetail
              key={selected.id}
              unit={selected}
              onUnitChanged={units.reload}
              onUnitDeactivated={(message) => {
                setUnitNotice(message);
                units.reload();
              }}
            />
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Select a unit to manage it.</p>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Unit detail ─────────────────────────────────────────────────────────────

function UnitDetail({
  unit,
  onUnitChanged,
  onUnitDeactivated,
}: {
  unit: UnitView;
  onUnitChanged: () => void;
  onUnitDeactivated: (message: string) => void;
}) {
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [deactivated, setDeactivated] = useState(false);
  const [registrationsNonce, setRegistrationsNonce] = useState(0);
  const [claimCode, setClaimCode] = useState<ClaimCodeIssued | null>(null);
  const [copied, setCopied] = useState(false);

  const onDeactivate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await residentAdminApi.deactivateUnit(unit.id);
    setBusy(false);
    setConfirmDeactivate(false);
    if (res.ok) {
      const { deactivatedResidentCount, expiredPassCount, disabledRuleCount } = res.data;
      setDeactivated(true);
      setClaimCode(null);
      onUnitDeactivated(
        `Unit ${unit.label} deactivated: ${deactivatedResidentCount} resident(s) deactivated, ${expiredPassCount} open pass(es) expired, ${disabledRuleCount} rule(s) switched off.`,
      );
    } else {
      setError(res.error);
    }
  };

  const onIssueCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    setClaimCode(null);
    const res = await residentAdminApi.issueClaimCode(unit.id);
    setBusy(false);
    if (res.ok) setClaimCode(res.data.claimCode);
    else setError(res.error);
  };

  const onCopy = async () => {
    if (!claimCode) return;
    try {
      await navigator.clipboard.writeText(claimCode.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const active = unit.isActive && !deactivated;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Unit {unit.label}
          {!active && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal">Inactive</span>}
        </h3>
        {active && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onIssueCode()}>
              Issue claim code
            </Button>
            {!confirmDeactivate && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDeactivate(true)}>
                Deactivate unit
              </Button>
            )}
          </div>
        )}
      </div>

      {confirmDeactivate && active && (
        <div className="rounded-md border border-destructive/30 p-3 text-sm">
          <p>
            Deactivate unit {unit.label}? In the same step this deactivates its
            residents, expires its open passes and switches off its rules.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void onDeactivate()}>
              Confirm deactivate {unit.label}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDeactivate(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <ErrorBox error={error} />}

      {claimCode && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3" aria-label="Claim code">
          <p className="font-mono text-lg font-semibold tracking-widest">{claimCode.code}</p>
          <p className="text-xs text-muted-foreground">Expires {formatDate(claimCode.expiresAt)}</p>
          <p className="mt-1 text-xs">
            Shown once. Give it to the resident in person or by phone; it can't be shown again.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void onCopy()}>
              <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setClaimCode(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <ResidentsSection
        unitId={unit.id}
        readOnly={!active}
        onResidentDeactivated={() => {
          // Deactivating a resident switches off their rules and changes the
          // unit's resident count.
          setRegistrationsNonce((n) => n + 1);
          onUnitChanged();
        }}
      />
      <RegistrationsSection unitId={unit.id} readOnly={!active} refreshKey={registrationsNonce} />
    </div>
  );
}

// ─── (c) Residents ───────────────────────────────────────────────────────────

function ResidentsSection({
  unitId,
  readOnly,
  onResidentDeactivated,
}: {
  unitId: string;
  readOnly: boolean;
  onResidentDeactivated: () => void;
}) {
  const [includeInactive, setIncludeInactive] = useState(false);
  const fetchResidents = useCallback(
    (signal: AbortSignal) => residentAdminApi.listResidents(unitId, includeInactive, signal),
    [unitId, includeInactive],
  );
  const residents = useLoad(fetchResidents);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);

  const onDeactivate = async (resident: AdminResidentView) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await residentAdminApi.deactivateResident(resident.id);
    setBusy(false);
    setConfirmId(null);
    if (res.ok) {
      residents.reload();
      onResidentDeactivated();
    } else {
      setError(res.error);
    }
  };

  return (
    <section aria-label="Residents" className="border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium">Residents</h4>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Include inactive residents
        </label>
      </div>
      {error && <ErrorBox error={error} />}
      {residents.state.status === "loading" && <Loading what="residents" />}
      {residents.state.status === "error" && <ErrorBox error={residents.state.error} />}
      {residents.state.status === "ready" && residents.state.data.residents.length === 0 && (
        <p className="text-sm text-muted-foreground">No residents have claimed this unit.</p>
      )}
      {residents.state.status === "ready" && residents.state.data.residents.length > 0 && (
        <ul className="divide-y divide-border">
          {residents.state.data.residents.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.displayName}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{r.phoneMasked}</span> · claimed {formatDate(r.claimedAt)} ·{" "}
                  {r.isActive ? "Active" : "Inactive"}
                </p>
              </div>
              {r.isActive && !readOnly && confirmId !== r.id && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmId(r.id)}>
                  Deactivate
                </Button>
              )}
              {confirmId === r.id && (
                <div className="flex w-full flex-wrap items-center gap-2 text-xs">
                  <span>Deactivate {r.displayName}? Their own rules are switched off at the same time.</span>
                  <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void onDeactivate(r)}>
                    Confirm deactivate {r.displayName}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── (d) Registrations and rules ─────────────────────────────────────────────

type RowAction = { id: string; mode: "off" | "clear" };

function RegistrationsSection({
  unitId,
  readOnly,
  refreshKey,
}: {
  unitId: string;
  readOnly: boolean;
  refreshKey: number;
}) {
  const fetchRegistrations = useCallback(
    (signal: AbortSignal) => residentAdminApi.listRegistrations(unitId, signal),
    [unitId],
  );
  const registrations = useLoad(fetchRegistrations);
  const { reload: reloadRegistrations } = registrations;
  useEffect(() => {
    if (refreshKey > 0) reloadRegistrations();
  }, [refreshKey, reloadRegistrations]);
  const [action, setAction] = useState<RowAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: RowAction) => {
    setAction(action?.id === next.id && action.mode === next.mode ? null : next);
    setReason("");
    setError(null);
  };

  const onSubmit = async (event: React.FormEvent, row: AdminRegistrationView) => {
    event.preventDefault();
    if (!action || busy || reason.trim().length < REASON_MIN) return;
    setBusy(true);
    setError(null);
    const res =
      action.mode === "off"
        ? await autoApprovalApi.deactivateRule(row.ruleId, reason.trim())
        : await autoApprovalApi.clearBlock(row.ruleId, reason.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      action.mode === "off"
        ? `${row.label}: switched off.`
        : row.removedAt
          ? `${row.label}: block cleared. The resident can now register this again.`
          : `${row.label}: block cleared. The resident must first remove the switched-off entry in their portal, then register it again.`,
    );
    setAction(null);
    setReason("");
    registrations.reload();
  };

  return (
    <section aria-label="Registrations" className="border-t border-border pt-3">
      <h4 className="mb-2 text-sm font-medium">Registrations and rules</h4>
      {notice && <p role="status" className="mb-2 text-sm">{notice}</p>}
      {registrations.state.status === "loading" && <Loading what="registrations" />}
      {registrations.state.status === "error" && <ErrorBox error={registrations.state.error} />}
      {registrations.state.status === "ready" && registrations.state.data.registrations.length === 0 && (
        <p className="text-sm text-muted-foreground">No household members or vehicles registered.</p>
      )}
      {registrations.state.status === "ready" && registrations.state.data.registrations.length > 0 && (
        <ul className="divide-y divide-border">
          {registrations.state.data.registrations.map((row) => {
            const standingBlock = row.block !== null && row.block.clearedAt === null;
            const canSwitchOff = !readOnly && row.ruleActive && row.status !== "removed";
            const canClear = !readOnly && standingBlock;
            const isOpen = action?.id === row.id;
            const reasonFieldId = `reg-reason-${row.id}`;
            return (
              <li key={row.id} className="flex flex-wrap gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {row.label}
                    {row.plate && <span className="font-mono text-xs text-muted-foreground">{row.plate}</span>}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
                      {row.kind === "vehicle" ? "Vehicle" : "Person"}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">{STATUS_LABEL[row.status]}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">Registered by {row.residentDisplayName}</p>
                  {row.block && (
                    <p className="text-xs">
                      {standingBlock ? "Blocked" : "Block cleared"}: switched off by {row.block.blockedBy} on{" "}
                      {formatDate(row.block.blockedAt)}
                      {row.block.reason ? ` — ${row.block.reason}` : ""}
                      {row.block.clearedAt &&
                        `. Cleared by ${row.block.clearedBy ?? "—"} on ${formatDate(row.block.clearedAt)} — ${row.block.clearReason ?? ""}`}
                    </p>
                  )}
                </div>
                <div className="flex items-start gap-2">
                  {canSwitchOff && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => open({ id: row.id, mode: "off" })}>
                      Switch off
                    </Button>
                  )}
                  {canClear && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => open({ id: row.id, mode: "clear" })}>
                      Clear block
                    </Button>
                  )}
                </div>
                {isOpen && action && (
                  <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(e) => void onSubmit(e, row)}>
                    <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
                      <Label htmlFor={reasonFieldId} className="text-xs">
                        {action.mode === "off" ? "Reason for switching off" : "Reason for clearing the block"}{" "}
                        <span aria-hidden="true">*</span>
                        <span className="sr-only">(required)</span>
                      </Label>
                      <Input
                        id={reasonFieldId}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={REASON_MAX}
                        aria-invalid={error?.field === "reason" || undefined}
                        aria-describedby={error?.field === "reason" ? `${reasonFieldId}-error` : undefined}
                        disabled={busy}
                        required
                      />
                      <span className="text-xs text-muted-foreground">
                        {REASON_MIN}–{REASON_MAX} characters. {reason.trim().length}/{REASON_MAX}
                      </span>
                      {error?.field === "reason" && (
                        <span id={`${reasonFieldId}-error`} role="alert" className="text-xs text-destructive">
                          <span className="font-medium">{error.code}</span> — {error.message}
                        </span>
                      )}
                    </div>
                    <Button type="submit" size="sm" disabled={busy || reason.trim().length < REASON_MIN}>
                      {action.mode === "off" ? "Confirm switch off" : "Confirm clear"}
                    </Button>
                  </form>
                )}
                {isOpen && error && error.field !== "reason" && (
                  <div className="w-full">
                    <ErrorBox error={error} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

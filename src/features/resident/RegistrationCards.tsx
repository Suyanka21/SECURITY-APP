/**
 * GatePass — resident capabilities 2 and 3: household members / workers and
 * vehicles.
 *
 * Source: src/docs/specs/resident-portal.md §3.4, §4. Each registration
 * becomes a 90-day auto-approval rule for the resident's own unit; host and
 * unit are set by the server. The copy states plainly what the gate can and
 * cannot recognise.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Car, Loader2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  residentApi,
  type ResidentMe,
  type ResidentRegistration,
  type ResidentRegistrationKind,
} from "@/lib/api/resident";

function describeError(status: number, code: string, message: string): string {
  if (status === 0) return "No connection. Check your internet and try again.";
  if (code === "REGISTRATION_DUPLICATE" || code === "REGISTRATION_LIMIT_REACHED") return message;
  if (code === "REGISTRATION_DISABLED") return message;
  if (code === "REGISTRATION_NOT_FOUND") return "That registration no longer exists.";
  if (status === 403) return "Your resident access is no longer active. Contact estate management.";
  if (status === 422) return message;
  if (status === 429) return "Too many changes. Please wait a while and try again.";
  return "Something went wrong. Try again.";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function StatusLine({ registration }: { registration: ResidentRegistration }) {
  switch (registration.status) {
    case "active":
      return <>Valid until {formatDate(registration.expiresAt)}</>;
    case "renew_due":
      return (
        <span className="text-amber-700 dark:text-amber-400">
          Expires {formatDate(registration.expiresAt)} — renew to keep it
        </span>
      );
    case "expired":
      return <span className="text-destructive">Expired — no longer recognised at the gate</span>;
    case "disabled":
      return <span className="text-destructive">Switched off by estate management</span>;
  }
}

const COPY = {
  person: {
    title: "Household members & workers",
    icon: Users,
    labelField: "Full name",
    placeholder: "Mary Njeri",
    submit: "Register person",
    empty: "No one registered yet.",
  },
  vehicle: {
    title: "Vehicles",
    icon: Car,
    labelField: "Description",
    placeholder: "White Vitz",
    submit: "Register vehicle",
    empty: "No vehicles registered yet.",
  },
} as const;

function RegistrationCard({
  kind,
  resident,
  registrations,
  loading,
  onCreated,
  onRemoved,
  onRenewed,
}: {
  kind: ResidentRegistrationKind;
  resident: ResidentMe;
  registrations: ResidentRegistration[];
  loading: boolean;
  onCreated: (r: ResidentRegistration) => void;
  onRemoved: (id: string) => void;
  onRenewed: (r: ResidentRegistration) => void;
}) {
  const copy = COPY[kind];
  const Icon = copy.icon;
  const [label, setLabel] = useState("");
  const [plate, setPlate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError(kind === "person" ? "Enter the person's full name." : "Describe the vehicle, e.g. White Vitz.");
      return;
    }
    if (kind === "vehicle" && !plate.trim()) {
      setError("Enter the vehicle's number plate.");
      return;
    }
    setSubmitting(true);
    const result = await residentApi.createRegistration(
      kind === "vehicle"
        ? { kind, label: label.trim(), plate: plate.trim() }
        : { kind, label: label.trim() },
    );
    setSubmitting(false);
    if (!result.ok) {
      setError(describeError(result.status, result.error.code, result.error.message));
      return;
    }
    onCreated(result.data.registration);
    setLabel("");
    setPlate("");
  }

  async function remove(id: string) {
    setError(null);
    setBusyId(id);
    const result = await residentApi.removeRegistration(id);
    setBusyId(null);
    setConfirmingId(null);
    if (!result.ok && result.error.code !== "REGISTRATION_NOT_FOUND") {
      setError(describeError(result.status, result.error.code, result.error.message));
      return;
    }
    onRemoved(id);
  }

  async function renew(id: string) {
    setError(null);
    setBusyId(id);
    const result = await residentApi.renewRegistration(id);
    setBusyId(null);
    if (!result.ok) {
      setError(describeError(result.status, result.error.code, result.error.message));
      return;
    }
    onRenewed(result.data.registration);
  }

  const titleId = `registrations-${kind}-title`;
  return (
    <section
      className="rounded-lg border border-border bg-card p-5 shadow-sm"
      aria-labelledby={titleId}
      data-testid={`registrations-${kind}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {copy.title}
        </h2>
      </div>

      <p className="mb-4 text-sm text-muted-foreground" data-testid={`registrations-${kind}-explainer`}>
        {kind === "person" ? (
          <>
            Let in without calling you — but only if the guard types this person's name{" "}
            <strong>exactly as you register it</strong>, with you ({resident.displayName}) as host and
            unit {resident.unitLabel}. If the name is typed differently, the guard will ask you to
            approve as usual.
          </>
        ) : (
          <>
            When a guard enters this number plate for unit {resident.unitLabel}, the vehicle is let in
            without calling you, whoever is driving.
          </>
        )}{" "}
        Each registration lasts 90 days; renew it when prompted.
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : registrations.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid={`registrations-${kind}-empty`}>
          {copy.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid={`registrations-${kind}-list`}>
          {registrations.map((r) => (
            <li key={r.id} className="py-3" data-testid={`registration-${r.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {r.label}
                    {r.plate && <span className="ml-2 font-mono text-sm">{r.plate}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground" data-testid={`registration-${r.id}-status`}>
                    <StatusLine registration={r} />
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {(r.status === "renew_due" || r.status === "expired") && (
                    <Button
                      size="sm"
                      onClick={() => void renew(r.id)}
                      disabled={busyId === r.id}
                      data-testid={`registration-${r.id}-renew`}
                    >
                      Renew
                    </Button>
                  )}
                  {confirmingId === r.id ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void remove(r.id)}
                      disabled={busyId === r.id}
                      data-testid={`registration-${r.id}-confirm-remove`}
                    >
                      Confirm
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingId(r.id)}
                      disabled={busyId === r.id}
                      aria-label={`Remove ${r.label}`}
                      data-testid={`registration-${r.id}-remove`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="mt-4 space-y-3 border-t border-border pt-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={`registration-${kind}-label`}>{copy.labelField}</Label>
          <Input
            id={`registration-${kind}-label`}
            maxLength={60}
            placeholder={copy.placeholder}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={submitting}
          />
        </div>
        {kind === "vehicle" && (
          <div className="space-y-2">
            <Label htmlFor="registration-vehicle-plate">Number plate</Label>
            <Input
              id="registration-vehicle-plate"
              maxLength={12}
              autoCapitalize="characters"
              placeholder="KCA 123A"
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              disabled={submitting}
            />
          </div>
        )}
        <Button
          type="submit"
          variant="secondary"
          className="w-full"
          disabled={submitting}
          data-testid={`registrations-${kind}-submit`}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {copy.submit}
        </Button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function RegistrationCards({ resident }: { resident: ResidentMe }) {
  const [registrations, setRegistrations] = useState<ResidentRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    const result = await residentApi.listRegistrations(signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      setLoadError(describeError(result.status, result.error.code, result.error.message));
      return;
    }
    setRegistrations(result.data.registrations);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const replace = (r: ResidentRegistration) =>
    setRegistrations((rs) => rs.map((x) => (x.id === r.id ? r : x)));
  const shared = {
    resident,
    loading,
    onCreated: (r: ResidentRegistration) => setRegistrations((rs) => [...rs, r]),
    onRemoved: (id: string) => setRegistrations((rs) => rs.filter((x) => x.id !== id)),
    onRenewed: replace,
  };

  return (
    <>
      {loadError && (
        <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {loadError}{" "}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      <RegistrationCard
        kind="person"
        registrations={registrations.filter((r) => r.kind === "person")}
        {...shared}
      />
      <RegistrationCard
        kind="vehicle"
        registrations={registrations.filter((r) => r.kind === "vehicle")}
        {...shared}
      />
    </>
  );
}

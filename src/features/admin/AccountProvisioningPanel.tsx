/**
 * GatePass — Admin account-provisioning panel (Decision A1).
 *
 * Source: src/docs/adr/0001-...md — only an authenticated admin provisions
 *         accounts; the ROLE is server-controlled. This panel is rendered only
 *         inside AdminDashboard (which is only reached with a DB admin role),
 *         and POST /api/admin/accounts re-enforces requireRole("admin").
 * Source: Frontend-UI-Engineering — explicit loading / error / success states,
 *         keyboard-accessible native controls, design-system tokens.
 *
 * Security: the response may include a one-time temporaryPassword when the
 * server generated it. It is shown ONCE for the admin to relay out-of-band and
 * is never stored client-side beyond this ephemeral component state.
 */

import { useId, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  accountsApi,
  PROVISIONABLE_ROLES,
  type ProvisionableRole,
  type ProvisionedAccountView,
} from "@/lib/api/accounts";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | {
      status: "success";
      account: ProvisionedAccountView;
      temporaryPassword?: string;
    }
  | { status: "error"; code: string; message: string; field?: string };

const ROLE_LABELS: Record<ProvisionableRole, string> = {
  guard: "Guard",
  "senior-guard": "Senior guard",
  admin: "Admin",
};

export function AccountProvisioningPanel() {
  const nameId = useId();
  const badgeId = useId();
  const emailId = useId();
  const roleId = useId();
  const passwordId = useId();

  const [name, setName] = useState("");
  const [badgeNumber, setBadgeNumber] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProvisionableRole>("guard");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const submitting = state.status === "submitting";

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState({ status: "submitting" });

    const res = await accountsApi.createAccount({
      name: name.trim(),
      badgeNumber: badgeNumber.trim(),
      email: email.trim(),
      role,
      ...(password.trim() ? { password: password.trim() } : {}),
    });

    if (res.ok) {
      setState({
        status: "success",
        account: res.data.account,
        temporaryPassword: res.data.temporaryPassword,
      });
      setName("");
      setBadgeNumber("");
      setEmail("");
      setRole("guard");
      setPassword("");
    } else {
      setState({
        status: "error",
        code: res.error.code,
        message: res.error.message,
        field: res.error.field,
      });
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm md:col-span-2">
      <header className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Create staff account
        </h2>
        <p className="text-xs text-muted-foreground">
          Provision a guard, senior-guard, or admin. The role is assigned by the
          server and stored on the account — new staff cannot pick their own.
        </p>
      </header>

      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1">
          <Label htmlFor={nameId}>Full name</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            maxLength={120}
            required
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={badgeId}>Badge number</Label>
          <Input
            id={badgeId}
            value={badgeNumber}
            onChange={(e) => setBadgeNumber(e.target.value)}
            autoComplete="off"
            maxLength={32}
            required
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={emailId}>Email</Label>
          <Input
            id={emailId}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            maxLength={254}
            required
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={roleId}>Role</Label>
          <select
            id={roleId}
            value={role}
            onChange={(e) => setRole(e.target.value as ProvisionableRole)}
            disabled={submitting}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {PROVISIONABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor={passwordId}>
            Temporary password{" "}
            <span className="font-normal text-muted-foreground">
              (optional — leave blank to auto-generate)
            </span>
          </Label>
          <Input
            id={passwordId}
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            minLength={12}
            maxLength={128}
            placeholder="At least 12 characters"
            disabled={submitting}
          />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={submitting}>
            {submitting && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Create account
          </Button>
        </div>
      </form>

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span className="font-medium">{state.code}</span> — {state.message}
          {state.field ? ` (${state.field})` : ""}
        </div>
      )}

      {state.status === "success" && (
        <div
          role="status"
          className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm"
        >
          <p className="font-medium text-foreground">
            Created {state.account.name} · #{state.account.badgeNumber}
          </p>
          <p className="text-muted-foreground">
            Role <span className="font-medium">{state.account.role}</span> ·{" "}
            {state.account.email}
          </p>
          {state.temporaryPassword && (
            <p className="mt-2 text-foreground">
              Temporary password (shown once):{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {state.temporaryPassword}
              </code>
              <span className="block text-xs text-muted-foreground">
                Share it securely; ask the new user to change it after first
                sign-in.
              </span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

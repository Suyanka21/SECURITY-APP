---
name: testing-gatepass
description: How to bring up and end-to-end test the GatePass visitor-management app (roles, passes, PIN lockout, watchlist, exits) in a local browser session.
---

# Testing GatePass end-to-end

## Services
- Frontend: `npm run dev` → http://localhost:5173
- API: `npm run server` → http://localhost:3001 (`GET /api/health` returns `{"status":"ok"}`)
- Both die on box/session restart — always re-check health before recording, and start them
  detached (`setsid ... > /tmp/log 2>&1 < /dev/null &`) so a later `pkill` doesn't kill your shell.

## Required runtime env (may be missing from `.env` / `.env.local`)
- `PIN_PEPPER` — required by `src/server/services/pin-service.ts`. If absent, issuing a pass
  fails with a user-visible `INTERNAL_ERROR: PIN backup is misconfigured (PIN_PEPPER missing)`.
  Start the API with a value set if the repo env files don't contain one.
- `APP_PUBLIC_ORIGIN` — origin baked into resident approval links and pass URLs. If it points at
  a port nothing is serving (e.g. `:8080` while dev runs on `:5173`), the on-screen magic link
  dead-ends with ERR_CONNECTION_REFUSED. Override it to the running frontend origin for demos.
- `VITE_SUPABASE_ANON_KEY` — if login 401s "Invalid API key", `.env` and `.env.local` disagree;
  use the working key.

## Roles (password `GatePass!2026`, all server-resolved from `guards.role`)
- `guard@gatepass.test` — gate station console only; 403 on `/api/entries/on-premise`,
  `/api/watchlist`, invitations.
- `sguard-setup@gatepass.test` (badge S-900, senior-guard) — needed for pass issuance,
  on-premise list, notes, exits.
- `admin@gatepass.test` — admin dashboard (account provisioning, watchlist, on-premise).
- `resident@gatepass.test` — deliberately has no `guards` row → "Residents don't sign in here" /
  "Account not linked". Residents have no dashboard by design.

## Switching accounts
The gate console has **no sign-out control** (sign-out exists only in AdminDashboard and the
not-linked screen). To switch between console roles, clear browser storage over CDP
(http://localhost:29229) then reload; helper scripts used previously:
`node /home/ubuntu/gp-clear.mjs` (localStorage+sessionStorage clear) and
`node /home/ubuntu/gp-onboard.mjs skip <guard|admin>` (sets `gatepass_welcomed`,
`gatepass_role`, `gatepass_onboarding_complete`). Run such scripts from a directory where
`playwright` resolves (e.g. /home/ubuntu), not /tmp. Note: setting onboarding keys does NOT
sign the current user out — clear storage first, then reload, then sign in.

**Resident-role trap (blocks testing if you hit it):** if you pick "Resident / Host" in the
onboarding role picker, `Index.tsx` returns the "Residents don't sign in here" screen *before* any
auth check, so the staff login screen becomes unreachable from the UI. Help Center → "Replay
Tutorial" keeps the stored role (`replayOnboarding` preserves `prev.role`) and just restarts the
resident walkthrough, and `resetOnboarding` is exported but wired to no component. The only way
out is clearing `gatepass_role` (storage clear / `gp-onboard.mjs skip guard`) and reloading — so
budget a storage reset whenever a test picks the resident role, and never assume an on-screen
control can undo it. Onboarding keys: `gatepass_welcomed`, `gatepass_role`,
`gatepass_onboarding_complete`, `gatepass_onboarding_step`.

## Flow cheatsheet
- Walk-in with host phone **blank** → "Request resident approval" shows the single-use magic link
  on screen. The "Open" link navigates in the same tab; as of the Stage 6 approval-handoff fix the
  guard console recovers on browser Back and shows the banner "Resident approved. Entry logged."
  plus the "Entry recorded" panel. The pending approval is persisted in localStorage key
  `gatepass_pending_approval` with `magicLinkUrl` deliberately stripped, so after a reload the link
  box reads "The link is not shown again after the console was reopened…" and, as of the resumed-
  approval fix, no Copy link / Open controls are rendered at all in that state (they only appear
  while the link is still in memory). If you do see them on a resumed approval, that is a
  regression.
- Pass issuance: senior-guard/admin → console `admin` tab → "Invite visitor" → returns QR, pass
  URL, pass reference and 6-digit PIN (shown once).
- Redemption: `qr` tab → "Redeem by PIN" (pass ref + PIN). Error codes seen: `PIN_INVALID`
  (with attempts-remaining countdown), `PIN_LOCKED` after 5 wrong attempts, `PIN_REPLAYED`,
  `PIN_NOT_FOUND`, `QR_NOT_FOUND`, and `QR_LOCKED` (validating the QR token of a PIN-locked pass).
- Important UI caveat: any failed PIN/QR redemption puts the console into `mode: "error"` and
  replaces the QR panel with the full-screen refusal screen (`ErrorPanel`). The in-panel banners
  (`pin-locked-banner`, `qr-locked-banner`) and the `disabled` "Validate QR" button are therefore
  effectively unreachable through the UI — always assert on the full-screen refusal instead, and
  re-enter the flow via "Reset flow" → `qr` tab between attempts.
- That refusal screen is lock-aware: when `qrState === "locked"` it shows a padlock, the heading
  **"Locked"** (`error-panel-title`) and the note (`error-panel-locked-note`) "Too many incorrect
  PIN attempts locked this pass — the QR on it is dead too. Re-scanning will not help…", with
  `Code: PIN_LOCKED` (5th wrong PIN) or `Code: QR_LOCKED` (validating that pass's QR token).
  Non-lock refusals (e.g. `PIN_INVALID`) still say "Entry blocked" — use that as the contrast check.
- Visitor-facing `/pass/<token>`: a PIN-locked pass renders title "Locked" + `INVITATION_LOCKED`
  with no QR image and no "Valid until" row.
- Browser URL trap: the dev server also serves a mock harness at `/audit/index.html`. Chrome
  autocomplete often jumps there when you type `localhost:5173` — type the full
  `http://localhost:5173/`, press Delete to drop the inline completion, then Enter, and confirm the
  address bar before asserting anything.
- Plate comparison appears on the confirmation panel when the pass has a plate; mismatch is a soft
  warning and never disables "Log entry".
- Watchlist matching is case/space-insensitive; a match logs the entry anyway and shows a red
  `role="alert"` banner. On the QR/PIN pre-log path, logging is refused with
  `WATCHLIST_ESCALATION_REQUIRED` until a supervisor name and acknowledgement checkbox are set.
- Notes and exits live in the senior-guard/admin "Currently on-premise" table.

## Suites
```
env -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY npx vitest run --config vitest.server.config.ts
npm test && npx tsc --noEmit && npm run lint && npm run build
```

## Devin Secrets Needed
- Live Supabase project URL + anon key + service role key (or a populated `.env.local`).
- `DATABASE_URL` for the live Supabase pooler.
- `PIN_PEPPER` (any stable secret string; must match across restarts or previously issued PINs stop verifying).

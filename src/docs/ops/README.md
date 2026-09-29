# GatePass — Launch Documentation Index

Start here if you are preparing, running or reviewing the GatePass pilot.

> Legal and privacy material in this folder and on the public `/legal/*`
> pages is **DRAFT — NOT A LEGAL DOCUMENT** until a Kenyan lawyer or
> compliance professional has reviewed it. It is scaffolding for that review.

## What GatePass is

- [GatePass definition](../GATEPASS%20DEFINITION.md) — product scope and roles.
- [API contract](../gatepass-api-contract.md) — endpoints and error model.
- [Architecture decisions (ADRs)](../adr/) — auth role vs onboarding role, resident model.

## Technical readiness (Task 6)

- [Task 6 pre-ship report — PR #34](https://github.com/Suyanka21/SECURITY-APP/pull/34):
  production fail-fast config, clean production dependency audit,
  real-Postgres integration suite.
- [Dependency audit](../deploy/dependency-audit.md) — remaining advisories and why they are unreachable.
- [First-admin bootstrap & account provisioning](../deploy/first-admin-bootstrap.md).
- [Override audit atomicity — PR #33](https://github.com/Suyanka21/SECURITY-APP/pull/33).
- [Trustless audit reports](../TRUSTLESS-AUDIT-REPORT-v2.md) — findings that drove the hardening PRs.

## Running the pilot (Task 7)

| Document | For whom | Purpose |
|---|---|---|
| [Pilot launch checklist](./pilot-launch-checklist.md) | Everyone signing off | Every check, owner and verification before go-live; accepted gaps; sign-off table. |
| [Environment & configuration checklist](./environment-configuration-checklist.md) | Technical contact | Every variable, what happens if it is missing, what must never be exposed, rotation. |
| [Operations runbook](./operations-runbook.md) | Guards, supervisors, technical contact | Day-to-day: accounts, offline, sync, audit, locked passes, handover, lost devices. |
| [Admin & supervisor SOPs](./admin-sops.md) | Senior guards, admins | Step-by-step procedures with records to keep. |
| [Incident response](./incident-response.md) | Supervisor, estate manager, technical contact | First 15 minutes / then / evidence / who closes, for eight incident types. |
| [Privacy & data-handling DRAFT](./privacy-data-handling-DRAFT.md) | Legal / compliance reviewer | Accurate description of what is stored, who sees it, and every decision the reviewer must make. |
| [Pilot-readiness report](./pilot-readiness-report.md) | Estate manager, security company | PASS/FAIL verdict for operations and for legal/privacy scaffolding, with blockers. |

## Public pages (role-neutral, no login)

| Route | Content | Draft banner |
|---|---|---|
| `/legal/privacy` | Short privacy notice | yes |
| `/legal/terms` | Terms / acceptable use | yes |
| `/support` | Help for visitors, residents and staff | no (operational) |
| `/support/incident` | How to report a problem | no (operational) |

Reachable from the footer on the login, visitor pass, resident approval and
404 pages. Source: `src/features/public-info/`. Tests:
`src/features/public-info/__tests__/publicInfo.test.tsx`,
`src/server/__tests__/access-boundaries.test.ts`.

## Testing

- [Test plans](../test-plans/) and the GatePass testing skill (`.agents/skills/testing-gatepass/`).
- Standard gates: `npx eslint .`, `npx vitest run`,
  `SUPABASE_URL= npx vitest run --config vitest.server.config.ts`,
  `npx tsc --noEmit`, `NODE_ENV=production npx vite build`.
- Real-database gate: `DATABASE_URL=… npx vitest run --config vitest.integration.config.ts`.

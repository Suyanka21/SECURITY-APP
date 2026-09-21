# GatePass — Pilot-Readiness Report (Task 7)

Scope: is GatePass ready for a **controlled pilot** with one security company
and one estate? This is not a statement that GatePass is fully shippable for
commercial rollout, and nothing in it is legal advice.

## Verdicts

| Area | Verdict | Why |
|---|---|---|
| **Operations readiness** | **PASS — conditional** | Every day-to-day situation in the handoff has a written, code-accurate procedure; the access boundaries those procedures rely on are enforced server-side and proven by HTTP-level tests. Conditional on the three operational gaps below being accepted in writing on the launch checklist (section E). |
| **Privacy / legal scaffolding readiness** | **PASS as scaffolding · FAIL as legal text** | The public pages and the reviewer draft exist, are reachable without login, carry an unmissable DRAFT banner, invent no guarantees, and list every decision the reviewer must make. They are **not** usable as a published privacy notice or terms until a Kenyan lawyer / compliance professional reviews them (checklist D5). |

## What was verified in code (not only documented)

- `/api/audit/*` requires `admin` or `senior-guard`: 401 unauthenticated, 403 for a plain guard, through the real Express middleware stack (`access-boundaries.test.ts`, 13 tests).
- Admin reports (`/api/admin/*`) are refused to plain guards and unauthenticated callers.
- Public approval preview/decision and visitor preview return plain-language 4xx bodies with no stack, SQL, driver text, auth-header instructions or unexpected keys; the only identifier allowed is the labelled opaque `trace-<uuid>` support reference.
- `/legal/privacy`, `/legal/terms`, `/support`, `/support/incident` render with no auth or onboarding, legal pages show the DRAFT banner top and bottom, all public surfaces expose the four footer links, and no page contains raw error codes, trace IDs, bearer/auth text, service-role or database details, invented emails or phone numbers, or claimed retention/law/liability (`publicInfo.test.tsx`, 9 tests).
- Support contact comes only from `VITE_SUPPORT_EMAIL` / `VITE_SUPPORT_PHONE`; when unset the pages say so rather than inventing one.

## Gates (this branch)

```
npx eslint .                                        0 errors, 90 warnings (identical to main)
npx tsc --noEmit                                    clean
npx vitest run                                      Test Files 41 passed   Tests 534 passed
SUPABASE_URL= npx vitest run --config vitest.server.config.ts
                                                    Test Files 43 passed   Tests 578 passed
NODE_ENV=production npx vite build                  ✓ built
```

## Legal / privacy items that require professional review before rollout

1. Operator (data controller) identity and contact.
2. Purpose / lawful-basis wording for each data category.
3. Retention periods — **nothing is auto-deleted today**; the notice currently says a period has not been set.
4. Deletion and correction procedure, including whether audit rows are exempt.
5. Rights of visitors, residents and staff and how they exercise them.
6. Processor terms with Supabase and any future SMS/WhatsApp provider.
7. Breach-notification duties, recipients and deadlines.
8. Governing law, liability, warranty and dispute terms for the Terms of Use (all deliberately absent).
9. Whether a physical notice at the gate is required.
10. Employment-law considerations for monitoring guards' activity.

## Remaining operational blockers / accepted gaps

| Gap | Impact | Workaround in docs |
|---|---|---|
| No in-app account deactivation or password reset | Technical contact must edit `guards.is_active` / use Supabase Auth dashboard | Runbook §3–§4, SOP 2 |
| `/api/audit` serves the in-memory log; it empties on restart | Disputes must use the `audit_events` table via DB access | Runbook §8, Incident §5 |
| No visitor-history export | Manual SQL on written admin instruction | Runbook §9 |
| No retention enforcement | Data accumulates until manually deleted | Privacy draft §4, checklist D6 |
| No offline page reload (no service worker) | Queue survives; a hard refresh offline shows the browser error page | Runbook §6 |
| `drizzle/` migrations do not apply in file order on an empty DB | Use `drizzle-kit push` for the pilot | Checklist A2 |
| RLS enablement script is not in the repository | Technical contact keeps it with deploy notes | Checklist A3 |
| No real SMS/WhatsApp provider wired (default-deny mock) | Resident links must be relayed by the guard until a provider is added | Privacy draft §3 |
| Support contact, escalation contacts and sign-off names all blank | Fill before go-live | Checklist A9, D3, F |

## Out of scope for this report

The final live walkthrough / recording (handoff Task 6.7 and the combined
recording of PRs A–E) has not been done and is deliberately deferred until
after Task 7 is reviewed.

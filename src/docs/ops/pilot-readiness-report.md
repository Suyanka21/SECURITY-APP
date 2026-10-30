# GatePass — Pilot-Readiness Report (Task 7)

Scope: is GatePass ready for a **controlled pilot** with one security company
and one estate? This is not a statement that GatePass is fully shippable for
commercial rollout, and nothing in it is legal advice.

## Verdicts

| Area | Verdict | Why |
|---|---|---|
| **Operations readiness** | **PASS — conditional** | Every day-to-day situation in the handoff has a written, code-accurate procedure; the access boundaries those procedures rely on are enforced server-side and proven by HTTP-level tests. Conditional on the three operational gaps below being accepted in writing on the launch checklist (section E). |
| **Privacy / legal scaffolding readiness** | **PASS as scaffolding · FAIL as legal text** | The public pages and the reviewer draft exist and open without login. The two legal pages carry a NEEDS LEGAL REVIEW banner and a review list in every section, and no screen links to them, invent no guarantees, and list every decision the reviewer must make. They are **not** usable as a published privacy notice or terms until a Kenyan lawyer / compliance professional reviews them (checklist D5). |

## What was verified in code (not only documented)

- `/api/audit/*` requires `admin` or `senior-guard`: 401 unauthenticated, 403 for a plain guard, through the real Express middleware stack (`access-boundaries.test.ts`, 13 tests).
- Admin reports (`/api/admin/*`) are refused to plain guards and unauthenticated callers.
- Public approval preview/decision and visitor preview return plain-language 4xx bodies with no stack, SQL, driver text, auth-header instructions or unexpected keys; the only identifier allowed is the labelled opaque `trace-<uuid>` support reference.
- `/legal/privacy`, `/legal/terms`, `/support`, `/support/incident` render with no auth or onboarding, legal pages show the NEEDS LEGAL REVIEW banner top and bottom and a review list in every section, the footer on every public surface links only to the two support pages and no screen links to `/legal/*` while `LEGAL_TEXT_APPROVED` is false, and no page contains raw error codes, trace IDs, bearer/auth text, service-role or database details, invented emails or phone numbers, or claimed retention/law/liability (`publicInfo.test.tsx`, 16 tests).
- Support contact comes only from `VITE_SUPPORT_EMAIL` / `VITE_SUPPORT_PHONE`; when unset the pages say so rather than inventing one.

## Gates (this branch)

```
npx eslint .                                        0 errors; warning count identical to main
npx tsc --noEmit                                    clean
npx vitest run                                      Test Files 49 passed   Tests 623 passed
vitest -c vitest.server.config.ts                   Test Files 53 passed   Tests 683 passed
vitest -c vitest.integration.config.ts (fresh DB from drizzle/*.sql, also in CI)
                                                    Test Files 7 passed    Tests 101 passed
NODE_ENV=production npx vite build                  ✓ built
```

## API types versus real responses (one-time check, 2026-10-30)

**Method.** The full integration suite (7 files, 101 tests, local Postgres
built from `drizzle/*.sql`) was run with a temporary hook that recorded the
JSON body of every 2xx response (507 responses, 34 routes). For each
staff-facing response type in `src/lib/api/types.ts`, every field path (nested
objects and list items included) was compared with the field paths actually
returned. Each mismatch was then checked against the screens. The hook and
compare script were local only and are not committed. **Nothing was fixed.**

**Mismatches (typed, but the server never returns them):**

| Type | Field | Server | Screen reads it? | Risk |
|---|---|---|---|---|
| `NotificationView` (in `NotificationsListResponse`, `NotificationRetryResponse`) | `templateKey: string` (required) | never sent | no (only declared again in `src/features/gatepass/types.ts:143`) | none today; a future screen would get `undefined`, like `targetPhone` did |

**Typed as optional, never seen in the integration responses:**

| Type | Field | Note |
|---|---|---|
| `QrValidateResponse` | `watchlistMatch` | Sent only on a watchlist hit (`qr-service.ts:209`); the screen reads it (`GatePassPanels.tsx:700`). No integration test scans a watchlisted visitor, so the real shape is unproven on a real DB. |

**Lists that were empty in every integration response** (top level matched;
item fields not observable): `ListShiftsResponse` (14 item fields),
`ListDeliveriesResponse` (9), `ListOnPremiseResponse` (14),
`ListWatchlistResponse` (13).

**Matched exactly:** `ApprovalStatusResponse`, `CreateApprovalResponse`,
`ListVisitorProfilesResponse`, `IssueVisitorInvitationResponse`,
`PreviewVisitorInvitationResponse`. No route returned a field its type lacks.

**Not reached by any integration test** (no comparison possible):
`CreateEntryResponse`, `PinValidateResponse`, `SyncBatchResponse`,
`RecognizedVisitorsResponse`, `VisitorProfileResponse`, `RecordExitResponse`,
`AddGuardNoteResponse`/`ListGuardNotesResponse`, `CreateDeliveryEntryResponse`,
`WatchlistEntryResponse`.

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
| No in-app account deactivation | Technical contact must edit `guards.is_active` in the database | Runbook §3, SOP 2 |
| Staff password reset depends on Supabase Auth email settings | Without custom SMTP and the redirect URL, reset emails fail or open the sign-in page | Runbook §4, environment checklist §2a, gate A8b |
| `/api/audit` serves the in-memory log; it empties on restart | Disputes must use the `audit_events` table via DB access | Runbook §8, Incident §5 |
| No visitor-history export | Manual SQL on written admin instruction | Runbook §9 |
| No retention enforcement | Data accumulates until manually deleted | Privacy draft §4, checklist D6 |
| No offline page reload (no service worker) | Queue survives; a hard refresh offline shows the browser error page | Runbook §6 |
| No real SMS/WhatsApp provider wired (default-deny mock); the SMS fallback row is never dispatched | Resident links must be relayed by the guard until Twilio lands (`src/docs/specs/twilio-provider.md`) | Privacy draft §3, checklist A10 |
| Support contact, escalation contacts and sign-off names all blank | Fill before go-live | Checklist A9, D3, F |

## Out of scope for this report

The final live walkthrough / recording (handoff Task 6.7 and the combined
recording of PRs A–E) has not been done and is deliberately deferred until
after Task 7 is reviewed.

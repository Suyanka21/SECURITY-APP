# Feature 10 — Vehicle Verification at Manual Scan (Stage 3)

Status: Accepted · Stage 3 of the GatePass v1 consolidated scope.

## 1. Problem

When a guard validates a QR pass, the visitor's pre-registered vehicle plate
is already known (it travels in the QR-validation response, sourced from
`authorization_decisions.plate`). Today the guard has no on-screen prompt to
compare the plate on file against the vehicle physically at the gate — the
plate field is just pre-filled and easy to accept blindly. We want to surface
the expected plate for a deliberate visual comparison and flag a discrepancy,
without ever turning a mismatch into a hard gate.

## 2. Scope

- IN: on the QR scan-confirmation screen, show the pre-registered ("expected")
  plate as a distinct reference; compare it against the plate the guard
  observes/enters; render a **soft warning** when they differ.
- OUT: no automatic block/deny on mismatch; no new database schema; no plate
  capture via camera/OCR; no persistence of the "observed" value beyond the
  existing entry record's `plate` field; no change to QR validation,
  authorization, or replay-prevention behaviour.

## 3. Data source (no new schema)

The expected plate is already available end-to-end and needs no migration:

- `authorization_decisions.plate` (pre-registered at approval time)
- returned by `POST /api/entries/qr/validate` as
  `QrValidateResponse.visitor.plate: string | null`
- surfaced today into the confirmation draft as `draft.plate`

Stage 3 keeps the expected value alongside the editable draft so the two can
be compared. The "observed" plate is simply the current value of the existing
editable `plate` field — no new input control, no new endpoint.

## 4. Behaviour

Let `expectedPlate` = the pre-registered plate from the QR scan, and
`observedPlate` = the current value of the confirmation form's plate field.

Normalisation (comparison only — never mutates what is stored/displayed):
uppercase, then strip every non-alphanumeric character. So `"gr 1234-a"`,
`"GR1234A"`, and `"gr-1234 a"` all compare equal.

| expectedPlate        | observedPlate        | UI                                             |
|----------------------|----------------------|------------------------------------------------|
| null / empty         | anything             | info: "No plate on file for this visitor."     |
| present              | empty                | reference shown; no mismatch warning           |
| present              | normalises == expected | reference shown; subtle "matches" confirmation |
| present              | normalises != expected | **soft warning** (both values shown)           |

Hard rules:

- A mismatch is **never** an automatic block. The confirm/submit control stays
  fully enabled in every state above.
- The warning is advisory copy for the guard, e.g. "Observed plate does not
  match the pre-registered plate. Verify the vehicle before continuing — this
  does not block entry."
- Verification UI only appears on the QR confirmation flow (where a
  pre-registered plate exists). Walk-in / override entries are unaffected.

## 5. Frontend contract

- `GatePassState.expectedPlate?: string | null` — pre-registered plate from the
  most recent successful QR scan. Set by `QR_SCAN_SUCCEEDED`; cleared by
  `QR_SCAN_STARTED`, `QR_SCAN_FAILED`, and `RESET_FLOW`.
- Pure helpers in `src/features/gatepass/plate-verification.ts`:
  - `normalizePlate(value: string | null | undefined): string`
  - `getPlateComparison(expected, observed): PlateComparison`
    where `PlateComparison` is one of
    `"no-expected" | "no-observed" | "match" | "mismatch"`.
- `VehicleVerification` presentational component renders the reference + status
  from a `PlateComparison`; it holds no state and issues no side effects.

## 6. Security / correctness

- No new untrusted input crosses a server boundary (the observed plate is the
  existing `plate` field already validated by the entry submission path).
- Comparison is a pure, deterministic string function — no locale surprises
  (ASCII upper-case + alphanumeric filter).
- Colour is never the sole signal: match/mismatch carry text + icon, and the
  warning uses `role="alert"` so it is announced.

## 7. Acceptance criteria

1. Expected plate is displayed on the QR confirmation screen when one is on file.
2. When no plate is on file, an informational note is shown instead of a warning.
3. Observed plate equal to expected (after normalisation) shows a match state,
   no warning.
4. Observed plate differing from expected shows a soft warning naming both.
5. The submit/confirm control is enabled in all of the above — mismatch never
   blocks or disables continuation.
6. Existing QR validation, authorization, and replay-prevention flows are
   unchanged (no server/schema edits).

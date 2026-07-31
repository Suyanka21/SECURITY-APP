/**
 * GatePass — Feature 10: Vehicle Verification (Stage 3)
 *
 * Pure, deterministic helpers for comparing a visitor's pre-registered
 * ("expected") plate against the plate a guard observes/enters at the gate.
 *
 * A mismatch is a SOFT WARNING only — it never blocks entry. See
 * src/docs/specs/vehicle-verification.md.
 */

/**
 * Comparison outcome between an expected (pre-registered) plate and the
 * plate the guard currently has on the confirmation form.
 *
 * - "no-expected": nothing on file to compare against.
 * - "no-observed": a plate is on file but the form value is blank.
 * - "match":       both present and equal after normalisation.
 * - "mismatch":    both present and differ after normalisation.
 */
export type PlateComparison =
  | "no-expected"
  | "no-observed"
  | "match"
  | "mismatch";

/**
 * Normalise a plate for comparison ONLY — this value is never stored or
 * displayed. Upper-cases and strips every non-alphanumeric character so
 * "gr 1234-a", "GR1234A", and "gr-1234 a" all compare equal.
 */
export function normalizePlate(value: string | null | undefined): string {
  if (!value) return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Compare the expected plate against the observed plate. Pure and total:
 * every combination maps to exactly one PlateComparison.
 */
export function getPlateComparison(
  expected: string | null | undefined,
  observed: string | null | undefined,
): PlateComparison {
  const normExpected = normalizePlate(expected);
  if (normExpected.length === 0) return "no-expected";

  const normObserved = normalizePlate(observed);
  if (normObserved.length === 0) return "no-observed";

  return normExpected === normObserved ? "match" : "mismatch";
}

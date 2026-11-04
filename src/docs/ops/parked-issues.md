# Parked issues

Review flags that are **not** fixed inside the PR that raised them. The rule:

- flags about **login, permissions or personal data** are fixed in the PR;
- **style, test-coverage and wording** flags are parked here so nothing is lost.

One line each. Severity is the reviewer's (🔴 / 🟡 / flag). Remove a line in the
PR that fixes it.

| Date | PR | Severity | Issue |
|---|---|---|---|
| 2026-11-04 | unit reactivation PR | flag | `useGatePassController.test.tsx` notification-polling tests are flaky locally (a different one of 88 fails about 1 run in 4, file untouched); pre-existing, needs a fake-timer audit. |

# Parked issues

Review flags that are **not** fixed inside the PR that raised them. The rule:

- flags about **login, permissions or personal data** are fixed in the PR;
- **style, test-coverage and wording** flags are parked here so nothing is lost.

One line each. Severity is the reviewer's (🔴 / 🟡 / flag). Remove a line in the
PR that fixes it.

| Date | PR | Severity | Issue |
|---|---|---|---|
| 2026-10-30 | [#54](https://github.com/Suyanka21/SECURITY-APP/pull/54) | flag | Pilot checklist B4 and the known-gaps list still say password reset is done outside the app; A8b now tests the in-app reset. |

# Production dependency audit

Command of record:

```bash
npm audit --omit=dev --json
```

Policy: every **high** or **critical** finding in the production dependency
tree must be upgraded, moved out of `dependencies` if it is build-only, or
explained here. Nothing is left unexplained. Re-run before every deploy.

## State after this audit (2026-05-13)

`npm audit --omit=dev` → **0 critical, 0 high, 2 moderate, 0 low**.

### Resolved

| Package (path) | Severity | Action |
|---|---|---|
| `brace-expansion` via `tailwindcss-animate → tailwindcss → sucrase → glob → minimatch` | high | `tailwindcss-animate` moved to `devDependencies` — it is a Tailwind plugin imported only by `tailwind.config.ts`, i.e. build-time. It never runs in the browser or on the Express server, so its transitive tree is not production code. |
| `nanoid` via `tailwindcss-animate → tailwindcss → postcss` | high | Same move as above. |
| `postcss` via `tailwindcss-animate → tailwindcss` | high | Same move. `postcss` itself is already a devDependency; the direct-listed copy is the CSS build toolchain and is patched to the lockfile's latest via `npm update`. |
| `postcss-selector-parser` via `tailwindcss-animate → tailwindcss` | low | Same move. |
| `ip-address` via `express-rate-limit` | high | Runtime (rate limiter on auth/approval routes). Upgraded in lockfile to `ip-address@10.7.1` (`express-rate-limit@8.7.0`, same major, its own range `^10.2.0` already admits the fix). |
| `body-parser` via `express@5.2.1` | low | Runtime. Lockfile bumped to `body-parser@2.3.0` (within Express's own range). |
| `qs` via `express` / `body-parser` | moderate | Runtime. Lockfile bumped to `qs@6.16.0`. |
| `react-router-dom` (GHSA-jjmj-jmhj-qwj2, open redirect leading to XSS, `<=6.30.5`) | moderate | Upgraded to `react-router-dom@6.30.6` (patch). |

### Remaining — accepted with rationale

Both remaining advisories are **moderate** and target `react-router@6.x`
(all of 6.0.0 – 7.17.0). The only fix npm offers is `react-router-dom@7.x`, a
major upgrade with a different data-router API — not a "safe" upgrade and not
one to take in a hardening PR.

| Advisory | Why it is not reachable in GatePass |
|---|---|
| GHSA-337j-9hxr-rhxg — arbitrary constructor injection via `deserializeErrors()` in SSR hydration | Requires server-side rendering with `<RouterProvider>` hydration. GatePass is a client-only Vite SPA built with `<BrowserRouter>`; `deserializeErrors` is never invoked because there is no server-rendered error payload to deserialise. |
| GHSA-wrjc-x8rr-h8h6 — open redirect via a backslash in `<Link to>` / `useNavigate()` | Requires an attacker-controlled navigation target. Every `navigate()` / `<Link to>` / `<Navigate to>` target in `src/` is a string literal (`navigate("/")`, `to="/..."`); no route target is built from query strings, `location.state`, or API responses. Verified with `rg 'navigate\(|<Link|<Navigate' src` — the only parameterised `to` is the unused `src/components/NavLink.tsx` wrapper. |

Both become non-issues when the app moves to react-router 7; that migration is
tracked as a separate follow-up, not part of launch hardening.

## Verifying

```bash
npm audit --omit=dev            # expect: 0 high, 0 critical
npm ls react-router react-router-dom express-rate-limit ip-address body-parser qs
```

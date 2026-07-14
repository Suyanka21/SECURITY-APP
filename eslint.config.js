import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Files that predate the auth work and are explicitly hands-off (audited
// backend hardening + their tests — see PR #15 / ADR 0001). `no-explicit-any`
// is a pre-existing baseline in these files only; it is downgraded to `warn`
// HERE so the baseline stays visible without blocking CI. This list is
// intentionally explicit (not a broad glob): any NEW file — the auth flow,
// the admin dashboard, anything from Phase 2 onward — is not listed, so
// `no-explicit-any` remains a hard error there.
const legacyAnyFiles = [
  "src/server/app.ts",
  "src/server/index.ts",
  "src/server/routes/audit.ts",
  "src/server/routes/entries.ts",
  "src/server/routes/qr.ts",
  "src/server/routes/sync.ts",
  "src/server/routes/visitors.ts",
  "src/server/services/approval-service.ts",
  "src/server/services/audit-logger.ts",
  "src/server/services/auto-approval-service.ts",
  "src/server/services/entry-service.ts",
  "src/server/services/qr-service.ts",
  "src/server/services/sync-service.ts",
  "src/server/services/visitor-profile-service.ts",
  "src/server/services/visitor-service.ts",
  "src/server/__tests__/approval-service.test.ts",
  "src/server/__tests__/audit-system.test.ts",
  "src/server/__tests__/auth-middleware.test.ts",
  "src/server/__tests__/auto-approval-service.test.ts",
  "src/server/__tests__/delivery-routes.test.ts",
  "src/server/__tests__/entry-service.test.ts",
  "src/server/__tests__/entry-validation.test.ts",
  "src/server/__tests__/sync-service.test.ts",
  "src/server/__tests__/visitor-profile-service.test.ts",
];

export default tseslint.config(
  // Vendored shadcn/ui primitives and the throwaway audit harness are generated
  // /non-hand-maintained code; exclude them from lint (nothing else is swept in).
  { ignores: ["dist", "src/components/ui/**", "audit/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: legacyAnyFiles,
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

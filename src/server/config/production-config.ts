/**
 * GatePass — Production configuration fail-fast.
 *
 * Source: Security-and-Hardening — "No fallback secrets in production",
 *   "Fail loudly on misconfiguration".
 *
 * Several settings degrade silently when unset: CORS falls back to localhost
 * origins, resident magic-links and visitor pass URLs are built against
 * http://localhost:5173, the PIN pepper is only checked when the first
 * invitation is issued, and account provisioning returns 503 on first use.
 * None of those are acceptable failure modes for a real deployment, so the
 * server refuses to start in production until every required setting is
 * present and is not a template placeholder.
 *
 * JWT_SECRET is deliberately NOT required: in production SUPABASE_URL is
 * mandatory, which switches requireAuth to Supabase JWKS verification, so the
 * legacy self-issued HS256 path (the only consumer of JWT_SECRET) is never
 * reached.
 */

export type ProductionEnv = Record<string, string | undefined>;

export interface ConfigProblem {
  name: string;
  reason: string;
}

const PLACEHOLDER_PATTERNS = [/change-me/i, /<[^>]+>/];

const MIN_PIN_PEPPER_LENGTH = 16;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function isLocalOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(
    origin,
  );
}

function requirePresent(
  env: ProductionEnv,
  name: string,
  problems: ConfigProblem[],
): string | null {
  const value = env[name]?.trim();
  if (!value) {
    problems.push({ name, reason: "is not set" });
    return null;
  }
  if (isPlaceholder(value)) {
    problems.push({ name, reason: "still holds a template placeholder value" });
    return null;
  }
  return value;
}

/**
 * Returns every production configuration problem found in `env`. Empty when
 * the configuration is deployable. Never throws — callers decide.
 */
export function collectProductionConfigProblems(
  env: ProductionEnv,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  requirePresent(env, "DATABASE_URL", problems);

  const pepper = requirePresent(env, "PIN_PEPPER", problems);
  if (pepper && pepper.length < MIN_PIN_PEPPER_LENGTH) {
    problems.push({
      name: "PIN_PEPPER",
      reason: `must be at least ${MIN_PIN_PEPPER_LENGTH} characters`,
    });
  }

  const supabaseUrl = requirePresent(env, "SUPABASE_URL", problems);
  if (supabaseUrl && !/^https:\/\//i.test(supabaseUrl)) {
    problems.push({ name: "SUPABASE_URL", reason: "must be an https:// URL" });
  }

  requirePresent(env, "SUPABASE_SERVICE_ROLE_KEY", problems);

  const origins = requirePresent(env, "ALLOWED_ORIGINS", problems);
  if (origins) {
    const list = origins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (list.length === 0) {
      problems.push({ name: "ALLOWED_ORIGINS", reason: "contains no origins" });
    } else if (list.includes("*")) {
      problems.push({
        name: "ALLOWED_ORIGINS",
        reason: "must not contain a wildcard origin",
      });
    } else if (list.every(isLocalOrigin)) {
      problems.push({
        name: "ALLOWED_ORIGINS",
        reason: "only lists localhost origins — real browsers would be refused by CORS",
      });
    }
  }

  const publicOrigin = requirePresent(env, "APP_PUBLIC_ORIGIN", problems);
  if (publicOrigin && isLocalOrigin(publicOrigin)) {
    problems.push({
      name: "APP_PUBLIC_ORIGIN",
      reason:
        "points at localhost — resident approval links and visitor pass URLs would be unreachable",
    });
  }

  return problems;
}

export function formatProductionConfigError(problems: ConfigProblem[]): string {
  const lines = problems.map((p) => `  - ${p.name} ${p.reason}`);
  return (
    "[FATAL] Production configuration is incomplete. The server will NOT start.\n" +
    lines.join("\n") +
    "\nSee .env.example for the required variables."
  );
}

/**
 * Throws in production when the configuration is not deployable. A no-op in
 * every other NODE_ENV so local development keeps its localhost fallbacks.
 */
export function assertProductionConfig(env: ProductionEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;

  const problems = collectProductionConfigProblems(env);
  if (problems.length === 0) return;

  const message = formatProductionConfigError(problems);
  console.error(message);
  throw new Error(message);
}

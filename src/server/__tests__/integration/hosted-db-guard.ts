const HOSTED_DOMAINS = ["supabase.co", "supabase.com"];

function isHostedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  return HOSTED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Throws if `databaseUrl` points at a hosted Supabase database. The
 * integration suite inserts and deletes rows, so it must only ever run
 * against a local Postgres.
 */
export function assertLocalDatabaseUrl(databaseUrl: string | undefined): void {
  if (!databaseUrl) return;
  let host: string | null;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    host = null;
  }
  const hosted = host === null ? /supabase\.com?\b/i.test(databaseUrl) : isHostedHost(host);
  if (!hosted) return;
  throw new Error(
    `Refusing to run integration tests: DATABASE_URL points at a hosted Supabase database` +
      `${host ? ` (${host})` : ""}. These tests insert and delete rows. ` +
      `Set DATABASE_URL to a local Postgres, e.g. postgresql://postgres:gp@localhost:54329/gatepass.`,
  );
}

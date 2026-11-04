/**
 * GatePass — sends notification rows left `queued`.
 *
 * Every row is dispatched right after it is queued (approval create, SMS
 * fallback). If the server stops between that commit and the dispatch, the
 * row stays `queued` and nothing else picks it up. This sweep runs at start-up
 * and then every minute (one server instance, decision D3) and dispatches such
 * rows while their approval is still pending.
 */

import { sql } from "drizzle-orm";
import { dispatchNotification, type DrizzleDB } from "./notification-service";
import type { NotificationProviderRegistry } from "./registry";

/** A row this old is not being dispatched by the request that queued it. */
export const QUEUED_SWEEP_AFTER_MS = 60_000;
export const QUEUED_SWEEP_INTERVAL_MS = 60_000;

export async function dispatchStrandedQueuedNotifications(
  db: DrizzleDB,
  opts: { providers: NotificationProviderRegistry; olderThanMs?: number },
): Promise<number> {
  const olderThanMs = opts.olderThanMs ?? QUEUED_SWEEP_AFTER_MS;
  // Claim by bumping updated_at, so an overlapping sweep skips these rows.
  const pg = db as unknown as { execute: (q: unknown) => Promise<unknown> };
  const claimed = (await pg.execute(sql`
    UPDATE notifications n
       SET updated_at = now()
      FROM approval_requests a
     WHERE n.approval_id = a.id
       AND n.status = 'queued'
       AND a.status = 'pending'
       AND n.updated_at < now() - make_interval(secs => ${olderThanMs / 1000})
    RETURNING n.id, a.requested_by_guard_id
  `)) as unknown as { rows: { id: string; requested_by_guard_id: string }[] };

  for (const row of claimed.rows) {
    try {
      await dispatchNotification(db, row.id, {
        providers: opts.providers,
        systemGuardId: row.requested_by_guard_id,
      });
    } catch (err) {
      console.error(`[NOTIFY] queued sweep dispatch error | notification=${row.id}`, err);
    }
  }
  if (claimed.rows.length > 0) {
    console.log(`[NOTIFY] queued sweep dispatched ${claimed.rows.length} notification(s)`);
  }
  return claimed.rows.length;
}

/** Runs the sweep now and every interval; returns a stop function. */
export function startQueuedNotificationSweep(
  db: DrizzleDB,
  getProviders: () => NotificationProviderRegistry,
  intervalMs: number = QUEUED_SWEEP_INTERVAL_MS,
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    dispatchStrandedQueuedNotifications(db, { providers: getProviders() })
      .catch((err) => {
        console.error("[NOTIFY] queued sweep error", err);
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

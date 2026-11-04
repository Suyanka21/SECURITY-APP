/**
 * GatePass — sends notification rows left `queued`.
 *
 * Every row is dispatched right after it is queued (approval create, SMS
 * fallback). If the server stops between that commit and the dispatch, the
 * row stays `queued` and nothing else picks it up. This sweep runs at start-up
 * and then every minute (one server instance, decision D3) and dispatches such
 * rows while their approval is still pending and before its deadline.
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
       AND a.expires_at > now()
       AND n.updated_at < now() - make_interval(secs => ${olderThanMs / 1000})
    RETURNING n.id, a.requested_by_guard_id
  `)) as unknown as { rows: { id: string; requested_by_guard_id: string }[] };

  let dispatched = 0;
  for (const row of claimed.rows) {
    try {
      // A backlog takes time: re-check just before this send that the guard
      // is still waiting (decided or past its deadline = no link to send).
      const still = (await pg.execute(sql`
        SELECT 1 FROM notifications n JOIN approval_requests a ON a.id = n.approval_id
         WHERE n.id = ${row.id} AND n.status = 'queued'
           AND a.status = 'pending' AND a.expires_at > now()
      `)) as unknown as { rows: unknown[] };
      if (still.rows.length === 0) continue;
      dispatched += 1;
      await dispatchNotification(db, row.id, {
        providers: opts.providers,
        systemGuardId: row.requested_by_guard_id,
      });
    } catch (err) {
      console.error(`[NOTIFY] queued sweep dispatch error | notification=${row.id}`, err);
    }
  }
  if (dispatched > 0) {
    console.log(`[NOTIFY] queued sweep dispatched ${dispatched} notification(s)`);
  }
  return dispatched;
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

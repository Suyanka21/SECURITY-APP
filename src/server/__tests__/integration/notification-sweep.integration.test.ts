/**
 * GatePass — queued-notification sweep on real Postgres.
 *
 * A row left `queued` (server stopped between commit and dispatch) is sent by
 * the sweep while its approval is pending; fresh rows and rows of a decided
 * approval are left alone, and a second sweep sends nothing again.
 *
 * PREREQUISITES: DATABASE_URL set, schema migrated.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/db/schema";
import { approvalRequests, auditEvents, guards, notifications } from "@/db/schema";
import { clearAuditDB, clearAuditLog, setAuditDB } from "../../services/audit-logger";
import { createApprovalRequest } from "../../services/approval-service";
import { MockNotificationProvider } from "../../services/notifications/mock-provider";
import { dispatchStrandedQueuedNotifications } from "../../services/notifications/queued-sweep";

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let guardId: string;
const stamp = Date.now();

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  pool = new Pool({ connectionString: databaseUrl, max: 5 });
  db = drizzle(pool, { schema });
  setAuditDB(db);
  const [g] = await db
    .insert(guards)
    .values({ id: randomUUID(), badgeNumber: `SWEEP-${stamp}`, name: "Sweep Guard", role: "guard", isActive: true })
    .returning({ id: guards.id });
  guardId = g.id;
});

afterAll(async () => {
  clearAuditLog();
  const approvals = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.requestedByGuardId, guardId));
  const ids = approvals.map((a) => a.id);
  if (ids.length > 0) {
    await db.delete(notifications).where(inArray(notifications.approvalId, ids));
    await db.delete(approvalRequests).where(inArray(approvalRequests.id, ids));
  }
  await db.delete(auditEvents).where(eq(auditEvents.guardId, guardId));
  await db.delete(guards).where(eq(guards.id, guardId));
  clearAuditDB();
  await pool.end();
});

async function queuedApproval(name: string): Promise<{ approvalId: string; notificationId: string }> {
  const out = await createApprovalRequest(
    {
      offlineId: randomUUID(),
      draft: { visitorName: name, host: "Sweep Host", unit: `SW-${stamp}`, plate: null, reason: "", method: "walk-in" },
      hostPhoneE164: "+254700000777",
    } as Parameters<typeof createApprovalRequest>[0],
    guardId,
    db as unknown as Parameters<typeof createApprovalRequest>[2],
  );
  expect(out.enqueuedNotification, "approval queues a notification").toBeTruthy();
  return { approvalId: out.response.approvalId, notificationId: out.enqueuedNotification!.id };
}

function sweepDb() {
  return db as unknown as Parameters<typeof dispatchStrandedQueuedNotifications>[0];
}

async function backdate(notificationId: string, minutes: number) {
  await db.execute(
    sql`UPDATE notifications SET updated_at = now() - make_interval(mins => ${minutes}) WHERE id = ${notificationId}`,
  );
}

async function statusOf(id: string) {
  const [r] = await db.select({ status: notifications.status }).from(notifications).where(eq(notifications.id, id));
  return r.status;
}

describe("queued-notification sweep", () => {
  it("sends a stranded queued row once; skips fresh rows, expired approvals and approvals past their deadline", async () => {
    const stranded = await queuedApproval("Sweep Stranded");
    const fresh = await queuedApproval("Sweep Fresh");
    const decided = await queuedApproval("Sweep Decided");
    const pastDeadline = await queuedApproval("Sweep Past Deadline");
    await backdate(stranded.notificationId, 5);
    await backdate(decided.notificationId, 5);
    await backdate(pastDeadline.notificationId, 5);
    // Still 'pending' in the row (expiry is applied on read), but past expires_at.
    await db.execute(
      sql`UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${pastDeadline.approvalId}`,
    );
    await db.execute(
      sql`UPDATE approval_requests SET status = 'expired', decided_at = now() WHERE id = ${decided.approvalId}`,
    );

    const sms = new MockNotificationProvider("sms");
    const whatsapp = new MockNotificationProvider("whatsapp");
    const providers = { sms, whatsapp };

    const sendsFor = async (id: string) => {
      const [r] = await db
        .select({ key: notifications.idempotencyKey })
        .from(notifications)
        .where(eq(notifications.id, id));
      return [sms, whatsapp].flatMap((p) => p.attempts).filter((m) => m.idempotencyKey.startsWith(`${r.key}:`)).length;
    };

    expect(await dispatchStrandedQueuedNotifications(sweepDb(), { providers })).toBeGreaterThanOrEqual(1);
    expect(await statusOf(stranded.notificationId)).toBe("delivered");
    expect(await sendsFor(stranded.notificationId)).toBe(1);
    expect(await statusOf(fresh.notificationId)).toBe("queued");
    expect(await sendsFor(fresh.notificationId)).toBe(0);
    expect(await statusOf(decided.notificationId)).toBe("queued");
    expect(await sendsFor(decided.notificationId)).toBe(0);
    expect(await statusOf(pastDeadline.notificationId)).toBe("queued");
    expect(await sendsFor(pastDeadline.notificationId)).toBe(0);

    await dispatchStrandedQueuedNotifications(sweepDb(), { providers });
    expect(await sendsFor(stranded.notificationId), "second sweep sends nothing again").toBe(1);
  });
});

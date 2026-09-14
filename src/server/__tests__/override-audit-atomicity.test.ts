// @vitest-environment node
/**
 * GatePass — override_authorized audit row is atomic with the override row.
 *
 * Failure-injection tests: the override_events insert is forced to fail
 * inside the caller's transaction. Afterwards NO override_authorized
 * record may exist anywhere — not on the independent audit connection,
 * not in the committed transaction, not in the in-memory log served by
 * /api/audit, not on stdout.
 *
 * Covers every caller of createOverrideEvent: entry-service,
 * delivery-service, sync-service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEntry } from "../services/entry-service";
import { createDeliveryEntry } from "../services/delivery-service";
import { syncEntries } from "../services/sync-service";
import {
  setAuditDB,
  clearAuditDB,
  clearAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";
import {
  guards,
  entryRecords,
  overrideEvents,
  auditEvents,
  syncEvents,
  authorizationDecisions,
} from "@/db/schema";

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OVERRIDE_REASON = "Emergency maintenance required for unit plumbing";

type Row = Record<string, unknown>;

/**
 * A DB double with real commit/rollback semantics:
 *  - `committed` holds rows from successful transactions and non-tx inserts
 *  - `auditConnection` is the SEPARATE connection audit-logger writes
 *    through (setAuditDB) — exactly the independent path under test
 *  - a transaction buffers its inserts and copies them into `committed`
 *    only if the callback resolves
 */
function makeDB(opts: { failOverrideInsert: boolean }) {
  const committed: { table: unknown; row: Row }[] = [];
  const auditConnection: Row[] = [];

  const insertInto = (sink: { table: unknown; row: Row }[]) =>
    vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation(async (row: Row) => {
        if (opts.failOverrideInsert && table === overrideEvents) {
          throw new Error("Simulated DB failure on override_events insert");
        }
        sink.push({ table, row });
      }),
    }));

  const from = vi.fn().mockImplementation((table: unknown) => ({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(async () => {
        if (table === guards) return [{ id: GUARD_ID, isActive: true }];
        if (table === entryRecords) return [];
        if (table === authorizationDecisions) return [];
        return [];
      }),
    }),
  }));

  const db = {
    select: vi.fn().mockReturnValue({ from }),
    insert: insertInto(committed),
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const buffered: { table: unknown; row: Row }[] = [];
      await fn({ insert: insertInto(buffered) });
      committed.push(...buffered);
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    query: {},
  };

  const auditDB = {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation(async (row: Row) => {
        auditConnection.push(row);
      }),
    })),
  };

  const persistedOverrideAuthorized = () => [
    ...auditConnection.filter((r) => r.eventType === "override_authorized"),
    ...committed
      .filter((c) => c.table === auditEvents && c.row.eventType === "override_authorized")
      .map((c) => c.row),
  ];
  const committedOverrides = () => committed.filter((c) => c.table === overrideEvents);

  return { db, auditDB, committed, auditConnection, persistedOverrideAuthorized, committedOverrides };
}

describe("override_authorized audit row is atomic with the override row", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearAuditLog();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    clearAuditDB();
    clearAuditLog();
    logSpy.mockRestore();
  });

  const authorizedOnStdout = () =>
    logSpy.mock.calls.filter((c) => String(c[0]).includes("override_authorized"));

  const expectNoAuthorizedAnywhere = (h: ReturnType<typeof makeDB>) => {
    expect(h.committedOverrides()).toHaveLength(0);
    expect(h.persistedOverrideAuthorized()).toHaveLength(0);
    expect(getAuditEventsByType("override_authorized")).toHaveLength(0);
    expect(authorizedOnStdout()).toHaveLength(0);
  };

  const overrideEntryInput = () => ({
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    reason: OVERRIDE_REASON,
    method: "override" as const,
    guardId: GUARD_ID,
    createdAt: new Date().toISOString(),
  });

  it("createEntry: a failed override insert leaves no persisted override_authorized row", async () => {
    const h = makeDB({ failOverrideInsert: true });
    setAuditDB(h.auditDB);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createEntry(overrideEntryInput(), h.db as any)).rejects.toThrow(
      /Simulated DB failure/,
    );

    expectNoAuthorizedAnywhere(h);
  });

  it("createDeliveryEntry: a failed override insert leaves no persisted override_authorized row", async () => {
    const h = makeDB({ failOverrideInsert: true });
    setAuditDB(h.auditDB);

    await expect(
      createDeliveryEntry(
        {
          ...overrideEntryInput(),
          host: "Reception",
          entryKind: "delivery",
          deliveryCategory: "parcel",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        h.db as any,
      ),
    ).rejects.toThrow(/Simulated DB failure/);

    expectNoAuthorizedAnywhere(h);
  });

  it("syncEntries: a rejected override entry leaves no persisted override_authorized row", async () => {
    const h = makeDB({ failOverrideInsert: true });
    setAuditDB(h.auditDB);

    const { response } = await syncEntries(
      {
        guardId: GUARD_ID,
        entries: [
          {
            offlineId: "55555555-5555-5555-5555-555555555555",
            ...overrideEntryInput(),
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      h.db as any,
    );

    expect(response.results[0].status).toBe("rejected");
    expectNoAuthorizedAnywhere(h);
  });

  it("createEntry: a successful override commits exactly one override_authorized row with the override", async () => {
    const h = makeDB({ failOverrideInsert: false });
    setAuditDB(h.auditDB);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createEntry(overrideEntryInput(), h.db as any);

    expect(h.committedOverrides()).toHaveLength(1);
    const rows = h.persistedOverrideAuthorized();
    expect(rows).toHaveLength(1);
    expect(rows[0].traceId).toBe(h.committedOverrides()[0].row.traceId);
    expect(getAuditEventsByType("override_authorized")).toHaveLength(1);
    expect(authorizedOnStdout()).toHaveLength(1);
  });

  it("override_rejected is still persisted even though the transaction rolls back", async () => {
    const h = makeDB({ failOverrideInsert: false });
    setAuditDB(h.auditDB);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createEntry({ ...overrideEntryInput(), reason: "short" }, h.db as any),
    ).rejects.toThrow();

    expect(h.committedOverrides()).toHaveLength(0);
    expect(h.auditConnection.filter((r) => r.eventType === "override_rejected")).toHaveLength(1);
    expect(h.persistedOverrideAuthorized()).toHaveLength(0);
  });
});

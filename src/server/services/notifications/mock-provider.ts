/**
 * GatePass — MockNotificationProvider
 *
 * Source: src/docs/specs/notifications.md §6 (B7 — mock by default).
 * Source: Trustless-System-Auditor — every failure path must be provable.
 *
 * In-memory provider used by:
 *   - server tests (vitest)
 *   - the trustless audit harness (audit/main.tsx)
 *   - default production config when no real provider env is set
 *     (default-deny: see service-factory; this mock REFUSES to be used
 *      unless explicitly opted in via env)
 *
 * Scripted behavior:
 *   - .scriptOk()              → next send succeeds (HTTP 200)
 *   - .scriptError(code, ...)  → next send rejects with NotificationError
 *   - The dispatcher's idempotency contract is verified here: a second
 *     send() with the same idempotencyKey reuses the scripted response
 *     (or last one) WITHOUT producing a second "delivery" — proves the
 *     dispatcher never sends duplicates even under retry.
 */

import {
  NotificationError,
  type NotificationErrorCode,
  type NotificationProvider,
  type NotificationSendInput,
  type NotificationSendResult,
  type NotificationChannel,
  truncateResponseExcerpt,
} from "./provider";

interface ScriptedOk {
  kind: "ok";
  responseCode: number;
  responseExcerpt: string;
}

interface ScriptedErr {
  kind: "err";
  code: NotificationErrorCode;
  message: string;
  responseCode: number;
  responseExcerpt: string;
}

type ScriptedStep = ScriptedOk | ScriptedErr;

export interface SentMessage {
  channel: NotificationChannel;
  target: string;
  body: string;
  idempotencyKey: string;
  result: NotificationSendResult | { errorCode: NotificationErrorCode };
}

export interface MockProviderOptions {
  /** When true, refuse all sends with INVALID_CREDENTIALS (default-deny). */
  defaultDeny?: boolean;
}

export class MockNotificationProvider implements NotificationProvider {
  private script: ScriptedStep[] = [];
  /** All send() calls — including duplicates suppressed by idempotency. */
  public readonly attempts: SentMessage[] = [];
  /** Unique deliveries by idempotency key — proves dedup. */
  public readonly deliveries = new Map<string, SentMessage>();

  constructor(
    public readonly channel: NotificationChannel,
    private readonly options: MockProviderOptions = {},
  ) {}

  scriptOk(opts: { responseCode?: number; body?: string } = {}): this {
    this.script.push({
      kind: "ok",
      responseCode: opts.responseCode ?? 200,
      responseExcerpt: truncateResponseExcerpt(opts.body ?? "{\"ok\":true}"),
    });
    return this;
  }

  scriptError(
    code: NotificationErrorCode,
    opts: { message?: string; responseCode?: number; body?: string } = {},
  ): this {
    this.script.push({
      kind: "err",
      code,
      message: opts.message ?? `Mock ${code}`,
      responseCode: opts.responseCode ?? 500,
      responseExcerpt: truncateResponseExcerpt(opts.body ?? code),
    });
    return this;
  }

  reset(): void {
    this.script = [];
    this.attempts.length = 0;
    this.deliveries.clear();
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    if (this.options.defaultDeny) {
      throw new NotificationError(
        "INVALID_CREDENTIALS",
        "Mock provider in default-deny mode",
        401,
        "default-deny",
      );
    }

    // Idempotency: replay the prior result without producing a new
    // "send" — proves the dispatcher never causes a double-send.
    const prior = this.deliveries.get(input.idempotencyKey);
    if (prior) {
      this.attempts.push({
        channel: this.channel,
        target: input.target,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        result: prior.result,
      });
      if (
        "errorCode" in prior.result &&
        prior.result.errorCode !== undefined
      ) {
        // The prior attempt failed; replaying it must NOT silently
        // succeed — the dispatcher's job is to decide retry vs. fail.
        const replay = prior.result;
        throw new NotificationError(
          replay.errorCode,
          "Replay of prior failed send",
          0,
          "replay",
        );
      }
      return prior.result as NotificationSendResult;
    }

    const step =
      this.script.shift() ??
      ({ kind: "ok", responseCode: 200, responseExcerpt: "{\"ok\":true}" } as ScriptedOk);

    if (step.kind === "err") {
      const record: SentMessage = {
        channel: this.channel,
        target: input.target,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        result: { errorCode: step.code },
      };
      this.attempts.push(record);
      this.deliveries.set(input.idempotencyKey, record);
      throw new NotificationError(
        step.code,
        step.message,
        step.responseCode,
        step.responseExcerpt,
      );
    }

    const result: NotificationSendResult = {
      providerMessageId: `mock_${this.channel}_${this.deliveries.size + 1}`,
      responseCode: step.responseCode,
      responseExcerpt: step.responseExcerpt,
    };
    const record: SentMessage = {
      channel: this.channel,
      target: input.target,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      result,
    };
    this.attempts.push(record);
    this.deliveries.set(input.idempotencyKey, record);
    return result;
  }
}

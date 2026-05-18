/**
 * GatePass — Notification Provider Registry
 *
 * Source: src/docs/specs/notifications.md §6 (provider interface), B7
 *         (mock by default).
 * Source: API-and-Interface-Design — single injection point for
 *         providers; routes/tests never import concrete providers.
 *
 * The registry is module-scoped so the app boot, the route layer,
 * and the test suite can all swap providers without threading
 * dependencies through every call site. Tests call
 * setNotificationProviders() in `beforeEach`; app.ts wires the real
 * (or default-deny mock) providers in createApp().
 */

import { MockNotificationProvider } from "./mock-provider";
import type {
  NotificationProvider,
  NotificationChannel,
} from "./provider";

export interface NotificationProviderRegistry {
  whatsapp: NotificationProvider;
  sms: NotificationProvider;
}

let current: NotificationProviderRegistry = buildDefaultRegistry();

function buildDefaultRegistry(): NotificationProviderRegistry {
  // Default-deny: until app boot explicitly wires providers, every
  // send() rejects with INVALID_CREDENTIALS. The dispatcher catches
  // it and marks rows 'failed' just like any other provider error,
  // so no notification is ever silently dropped.
  return {
    whatsapp: new MockNotificationProvider("whatsapp", { defaultDeny: true }),
    sms: new MockNotificationProvider("sms", { defaultDeny: true }),
  };
}

export function getNotificationProviders(): NotificationProviderRegistry {
  return current;
}

export function setNotificationProviders(
  next: NotificationProviderRegistry,
): void {
  current = next;
}

export function setNotificationProvider(
  channel: NotificationChannel,
  provider: NotificationProvider,
): void {
  current = { ...current, [channel]: provider };
}

export function resetNotificationProviders(): void {
  current = buildDefaultRegistry();
}

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
import {
  twilioStatusCallbackUrl,
  TwilioSmsProvider,
  TwilioWhatsAppProvider,
  type TwilioProviderDeps,
} from "./twilio-provider";
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

// ─── Boot wiring from environment variables (twilio-provider.md §4) ─────────

export type ProviderEnv = Record<string, string | undefined>;

export const WHATSAPP_PROVIDER_VALUES = ["twilio", "disabled", "mock"] as const;
export const SMS_PROVIDER_VALUES = ["twilio", "mock"] as const;

/**
 * The channel the first notification row uses. With WhatsApp disabled
 * (SMS-only pilot, decision D2) the approval goes straight to SMS.
 */
export function firstNotificationChannel(env: ProviderEnv = process.env): NotificationChannel {
  return env.NOTIFICATIONS_WHATSAPP_PROVIDER?.trim() === "disabled" ? "sms" : "whatsapp";
}

function twilioCredentials(env: ProviderEnv) {
  return {
    accountSid: env.TWILIO_ACCOUNT_SID?.trim() ?? "",
    apiKeySid: env.TWILIO_API_KEY_SID?.trim() ?? "",
    apiKeySecret: env.TWILIO_API_KEY_SECRET ?? "",
    statusCallbackUrl: twilioStatusCallbackUrl(env),
  };
}

/**
 * Builds the registry at boot. Unset (or `disabled`, `mock` and unknown
 * values) keeps the default-deny provider for that channel, so nothing is
 * sent by accident; production refuses `mock` and unknown values before this
 * runs (production-config.ts). `mock` never succeeds outside tests, which set
 * their own providers.
 */
export function buildNotificationProvidersFromEnv(
  env: ProviderEnv = process.env,
  deps?: TwilioProviderDeps,
): NotificationProviderRegistry {
  const registry = buildDefaultRegistry();
  if (env.NOTIFICATIONS_SMS_PROVIDER?.trim() === "twilio") {
    registry.sms = new TwilioSmsProvider(
      { ...twilioCredentials(env), messagingServiceSid: env.TWILIO_SMS_MESSAGING_SERVICE_SID?.trim() ?? "" },
      deps,
    );
  }
  if (env.NOTIFICATIONS_WHATSAPP_PROVIDER?.trim() === "twilio") {
    registry.whatsapp = new TwilioWhatsAppProvider(
      {
        ...twilioCredentials(env),
        from: env.TWILIO_WHATSAPP_FROM?.trim() ?? "",
        contentSid: env.TWILIO_WHATSAPP_CONTENT_SID?.trim() ?? "",
      },
      deps,
    );
  }
  return registry;
}

/**
 * Plain-language copy for the public visitor pass page.
 * Kept out of the component file so Fast Refresh sees only a component there.
 */
export type PassErrorKind = "locked" | "expired" | "consumed" | "not-found" | "unavailable";

export interface PassError {
  kind: PassErrorKind;
  title: string;
  body: string;
  /** What the visitor can actually do next. */
  hint: string;
}

// The server speaks INVITATION_*; earlier drafts of this page keyed off QR_*
// codes, so both spellings are accepted rather than silently falling through
// to the generic panel. This is a public surface: the code and the backend
// message are never rendered, only these words.
export function describePassError(code: string): PassError {
  switch (code) {
    case "INVITATION_LOCKED":
    case "QR_LOCKED":
      return {
        kind: "locked",
        title: "Locked",
        body: "This pass was locked after too many incorrect PIN attempts. The guard cannot let you in with it.",
        hint: "Ask your host to issue a new pass.",
      };
    case "INVITATION_EXPIRED":
    case "QR_EXPIRED":
      return {
        kind: "expired",
        title: "Pass expired",
        body: "The time window for this pass has passed.",
        hint: "Ask your host to issue a new pass.",
      };
    case "INVITATION_CONSUMED":
    case "QR_CONSUMED":
      return {
        kind: "consumed",
        title: "Pass already used",
        body: "This pass was already scanned at the gate and can only be used once.",
        hint: "Ask your host to issue a new pass if you need to enter again.",
      };
    case "INVITATION_NOT_FOUND":
    case "QR_NOT_FOUND":
      return {
        kind: "not-found",
        title: "Pass not found",
        body: "We couldn't find a pass for this link. It may be incomplete or may have been cancelled.",
        hint: "Open the link exactly as your host sent it, or ask them to issue a new pass.",
      };
    case "NETWORK_ERROR":
    case "REQUEST_TIMEOUT":
      return {
        kind: "unavailable",
        title: "Couldn't load your pass",
        body: "Your device couldn't reach the gate system.",
        hint: "Check your connection and try again. Your pass is not affected.",
      };
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
      return {
        kind: "unavailable",
        title: "Too many attempts",
        body: "This link was opened too many times in a short period.",
        hint: "Wait a minute and try again.",
      };
    default:
      return {
        kind: "unavailable",
        title: "Couldn't load your pass",
        body: "Something went wrong on our side while loading this pass.",
        hint: "Try again in a moment. If it keeps failing, show this screen to the guard.",
      };
  }
}

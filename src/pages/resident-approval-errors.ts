/**
 * Plain-language copy for the public resident approval page.
 * Kept out of the component file so Fast Refresh sees only a component there.
 */
export interface PublicError {
  title: string;
  body: string;
}

/**
 * Maps every code the resident page can receive to words a resident can
 * act on. Unknown codes fall through to a generic retry message — the
 * code itself is never rendered.
 */
export function describeApprovalError(code: string): PublicError {
  switch (code) {
    case "APPROVAL_TOKEN_INVALID":
      return {
        title: "This link isn't valid",
        body: "The approval link is incomplete or has been altered. Open the link exactly as the guard sent it, or ask them to send a new one.",
      };
    case "APPROVAL_NOT_FOUND":
      return {
        title: "Request not found",
        body: "We couldn't find this approval request. It may have been removed, or the link may be incomplete. Ask the guard to send a new one.",
      };
    case "APPROVAL_ALREADY_DECIDED":
    case "TOKEN_ALREADY_USED":
      return {
        title: "Already handled",
        body: "A decision has already been recorded for this request, so this link can't be used again. If that wasn't you, contact the gate.",
      };
    case "APPROVAL_EXPIRED":
      return {
        title: "Request expired",
        body: "This approval link timed out before a decision was recorded. Ask the guard to send a new one.",
      };
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
      return {
        title: "Too many attempts",
        body: "Please wait a minute and open the link again.",
      };
    case "NETWORK_ERROR":
    case "REQUEST_TIMEOUT":
      return {
        title: "Couldn't reach the gate",
        body: "Check your connection and try again. The request is still waiting for you.",
      };
    default:
      return {
        title: "Something went wrong",
        body: "We couldn't load this request right now. Try again in a moment, or ask the guard for help.",
      };
  }
}

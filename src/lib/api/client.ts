/**
 * GatePass — HTTP client wired to the backend in src/server.
 *
 * Contract: src/docs/gatepass-api-contract.md
 *
 * Design rules (Trustless-System-Auditor + API-and-Interface-Design):
 * - Every call returns a discriminated `ApiResult<T>` — callers must
 *   handle both branches. There is no thrown-exception path for expected
 *   HTTP failures.
 * - 4xx/5xx responses parse the contract `{ error: APIError }` body. If
 *   the body cannot be parsed, a synthetic error is generated so the UI
 *   still sees a `code` and `message`.
 * - Network failures (fetch rejection, abort, offline) map to a
 *   synthetic `NETWORK_ERROR` with status 0 — never silently swallowed.
 * - `Authorization: Bearer <token>` is injected from getAuthToken(); if
 *   no token is available the request still goes out and the backend
 *   responds 401, which the caller surfaces.
 */

import { getAuthToken } from "./auth";
import type { ApiErrorBody, ApiResult } from "./types";

// ─── Configuration ────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://localhost:3001";
const DEFAULT_TIMEOUT_MS = 10_000;

function resolveBaseUrl(): string {
  const envUrl = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }).env?.VITE_API_BASE_URL;
  return envUrl && envUrl.length > 0 ? envUrl : DEFAULT_BASE_URL;
}

// ─── Status-code helpers ──────────────────────────────────────────────

/** Synthetic error codes for transport-level failures (not server-issued). */
export const TransportErrorCodes = {
  NETWORK_ERROR: "NETWORK_ERROR",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  PARSE_ERROR: "PARSE_ERROR",
} as const;

/** Maps an HTTP status to the canonical contract failure code. */
export function statusToContractCode(status: number): string {
  switch (status) {
    case 401:
      return "AUTH_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 422:
      return "VALIDATION_ERROR";
    case 429:
      return "RATE_LIMITED";
    case 500:
    case 502:
    case 503:
    case 504:
      return "SERVER_ERROR";
    default:
      return `HTTP_${status}`;
  }
}

// ─── Internal request runner ──────────────────────────────────────────

interface RequestOptions {
  // PATCH + DELETE added for Feature 4 (visitor profile CRUD); spec §4.
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const url = new URL(path, resolveBaseUrl());
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseErrorBody(
  response: Response
): Promise<ApiErrorBody> {
  const fallback: ApiErrorBody = {
    code: statusToContractCode(response.status),
    message: response.statusText || "Request failed",
    traceId: "unavailable",
  };

  try {
    const text = await response.text();
    if (!text) return fallback;
    const parsed = JSON.parse(text) as { error?: Partial<ApiErrorBody> };
    if (parsed && parsed.error && typeof parsed.error === "object") {
      return {
        code: parsed.error.code ?? fallback.code,
        message: parsed.error.message ?? fallback.message,
        field: parsed.error.field,
        traceId: parsed.error.traceId ?? fallback.traceId,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function runRequest<T>(opts: RequestOptions): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const externalSignal = opts.signal;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timeoutId);

  // Chain external signal into our controller so callers can cancel too.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const url = buildUrl(opts.path, opts.query);

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    const isAbort =
      err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: {
        code: isAbort
          ? TransportErrorCodes.REQUEST_TIMEOUT
          : TransportErrorCodes.NETWORK_ERROR,
        message: isAbort
          ? "Request timed out before the server responded."
          : "Could not reach the GatePass backend. Check connectivity.",
        traceId: "transport",
      },
    };
  } finally {
    cleanup();
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }

  // Successful range: 2xx. The sync endpoint returns 207 for partial
  // success — still treat as `ok: true` because the body contains
  // per-entry results the UI must surface.
  if (response.status >= 200 && response.status < 300) {
    try {
      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch {
      return {
        ok: false,
        status: response.status,
        error: {
          code: TransportErrorCodes.PARSE_ERROR,
          message: "Server returned a success status with an invalid body.",
          traceId: "parse",
        },
      };
    }
  }

  const error = await parseErrorBody(response);
  return { ok: false, status: response.status, error };
}

// ─── Public API ───────────────────────────────────────────────────────

export const apiClient = {
  get<T>(
    path: string,
    options: { query?: RequestOptions["query"]; signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return runRequest<T>({ method: "GET", path, ...options });
  },
  post<T>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return runRequest<T>({ method: "POST", path, body, ...options });
  },
  patch<T>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return runRequest<T>({ method: "PATCH", path, body, ...options });
  },
  // A DELETE body is optional but supported: watchlist removals (Feature 12)
  // must carry a mandatory removal reason.
  del<T>(
    path: string,
    options: { body?: unknown; signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return runRequest<T>({ method: "DELETE", path, ...options });
  },
};

// Exposed for tests that need to verify base URL resolution.
export const __internal = { resolveBaseUrl };

/**
 * GatePass — staff password reset request (POST /api/auth/password-reset).
 *
 * Source: src/server/routes/password-reset.ts.
 *
 * The server answers every well-formed email with the same 202 body, so the
 * caller cannot learn whether an account exists. The email travels in the
 * JSON body, never in the URL.
 */

import { apiClient } from "./client";
import type { ApiResult } from "./types";

export interface PasswordResetResponse {
  message: string;
  traceId: string;
}

export const passwordResetApi = {
  request(email: string): Promise<ApiResult<PasswordResetResponse>> {
    return apiClient.post<PasswordResetResponse>("/api/auth/password-reset", {
      email,
    });
  },
};

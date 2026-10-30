import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ signIn: vi.fn(), loginAvailable: true, error: null }),
}));

import { LoginScreen } from "../LoginScreen";

describe("LoginScreen — forgotten password", () => {
  it("links to the reset page with no email or other data in the URL", () => {
    render(
      <MemoryRouter>
        <LoginScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/reset-password",
    );
  });
});

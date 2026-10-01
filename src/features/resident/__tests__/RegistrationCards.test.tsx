import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RegistrationCards } from "../RegistrationCards";
import type { ResidentMe, ResidentRegistration } from "@/lib/api/resident";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  renew: vi.fn(),
}));
vi.mock("@/lib/api/resident", () => ({
  residentApi: {
    listRegistrations: (...a: unknown[]) => mocks.list(...a),
    createRegistration: (...a: unknown[]) => mocks.create(...a),
    removeRegistration: (...a: unknown[]) => mocks.remove(...a),
    renewRegistration: (...a: unknown[]) => mocks.renew(...a),
  },
}));

const RESIDENT: ResidentMe = {
  id: "res-1",
  displayName: "Amina Wanjiru",
  phoneE164: "+254700000001",
  unitId: "unit-1",
  unitLabel: "B12",
};

function reg(over: Partial<ResidentRegistration>): ResidentRegistration {
  return {
    id: "r1",
    kind: "person",
    label: "Mary Njeri",
    plate: null,
    status: "active",
    expiresAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

function listed(registrations: ResidentRegistration[]) {
  return { ok: true, status: 200, data: { registrations, count: registrations.length, renewPromptDays: 14 } };
}

describe("RegistrationCards", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
  });
  afterEach(cleanup);

  it("household copy says plainly that the name must be typed exactly", async () => {
    mocks.list.mockResolvedValue(listed([]));
    render(<RegistrationCards resident={RESIDENT} />);
    await screen.findByTestId("registrations-person-empty");
    const text = screen.getByTestId("registrations-person-explainer").textContent ?? "";
    expect(text).toMatch(/exactly as you register it/);
    expect(text).toContain("Amina Wanjiru");
    expect(text).toContain("B12");
    expect(text).toMatch(/ask you to approve as usual/);
    expect(screen.getByTestId("registrations-vehicle-explainer").textContent).toMatch(/number plate/);
  });

  it("splits the list by kind and sends only kind + label (+ plate) — never host, unit or identity", async () => {
    mocks.list.mockResolvedValue(
      listed([reg({}), reg({ id: "v1", kind: "vehicle", label: "White Vitz", plate: "KDA 123X" })]),
    );
    mocks.create.mockResolvedValue({
      ok: true,
      status: 201,
      data: { registration: reg({ id: "v2", kind: "vehicle", label: "Blue Demio", plate: "KDE 900E" }) },
    });
    render(<RegistrationCards resident={RESIDENT} />);
    expect(await screen.findByTestId("registration-r1")).toBeTruthy();
    expect(screen.getByTestId("registrations-vehicle-list").textContent).toContain("KDA 123X");
    expect(screen.getByTestId("registrations-person-list").textContent).not.toContain("White Vitz");

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: " Blue Demio " } });
    fireEvent.change(screen.getByLabelText("Number plate"), { target: { value: "KDE 900E" } });
    fireEvent.click(screen.getByTestId("registrations-vehicle-submit"));
    await screen.findByTestId("registration-v2");
    expect(mocks.create.mock.calls[0][0]).toEqual({ kind: "vehicle", label: "Blue Demio", plate: "KDE 900E" });
  });

  it("a vehicle without a plate is refused locally", async () => {
    mocks.list.mockResolvedValue(listed([]));
    render(<RegistrationCards resident={RESIDENT} />);
    await screen.findByTestId("registrations-vehicle-empty");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "White Vitz" } });
    fireEvent.click(screen.getByTestId("registrations-vehicle-submit"));
    expect(screen.getByRole("alert").textContent).toMatch(/number plate/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("server duplicate message is shown as-is", async () => {
    mocks.list.mockResolvedValue(listed([]));
    mocks.create.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: "REGISTRATION_DUPLICATE", message: '"Mary Njeri" is already registered for your unit.', traceId: "t" },
    });
    render(<RegistrationCards resident={RESIDENT} />);
    await screen.findByTestId("registrations-person-empty");
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mary Njeri" } });
    fireEvent.click(screen.getByTestId("registrations-person-submit"));
    expect((await screen.findByRole("alert")).textContent).toContain("already registered");
  });

  it("remove needs a confirm click, then drops the row", async () => {
    mocks.list.mockResolvedValue(listed([reg({})]));
    mocks.remove.mockResolvedValue({ ok: true, status: 200, data: { registration: { id: "r1" } } });
    render(<RegistrationCards resident={RESIDENT} />);
    fireEvent.click(await screen.findByTestId("registration-r1-remove"));
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("registration-r1-confirm-remove"));
    await waitFor(() => expect(screen.queryByTestId("registration-r1")).toBeNull());
    expect(mocks.remove).toHaveBeenCalledWith("r1");
  });

  it("renew is offered only when due or expired, and updates the row", async () => {
    mocks.list.mockResolvedValue(
      listed([
        reg({ id: "due", status: "renew_due" }),
        reg({ id: "ok", label: "Other", status: "active" }),
        reg({ id: "off", label: "Off", status: "disabled" }),
      ]),
    );
    mocks.renew.mockResolvedValue({
      ok: true,
      status: 200,
      data: { registration: reg({ id: "due", status: "active", expiresAt: "2026-09-01T00:00:00.000Z" }) },
    });
    render(<RegistrationCards resident={RESIDENT} />);
    await screen.findByTestId("registration-due");
    expect(screen.queryByTestId("registration-ok-renew")).toBeNull();
    expect(screen.queryByTestId("registration-off-renew")).toBeNull();
    expect(screen.getByTestId("registration-off-status").textContent).toMatch(/Switched off/);
    expect(screen.getByTestId("registration-due-status").textContent).toMatch(/renew/);
    fireEvent.click(screen.getByTestId("registration-due-renew"));
    await waitFor(() => expect(screen.queryByTestId("registration-due-renew")).toBeNull());
    expect(mocks.renew).toHaveBeenCalledWith("due");
  });
});

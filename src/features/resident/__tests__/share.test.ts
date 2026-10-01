import { describe, expect, it } from "vitest";
import { normalizeKenyanPhone, passShareText, whatsappShareUrl } from "../share";

describe("normalizeKenyanPhone", () => {
  it.each([
    ["0712 345 678", "+254712345678"],
    ["0112345678", "+254112345678"],
    ["712345678", "+254712345678"],
    ["254712345678", "+254712345678"],
    ["+254 712-345-678", "+254712345678"],
    ["+447700900123", "+447700900123"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each(["", "12345", "0812345678", "+0123456789", "abc", "07123456789"])(
    "rejects %s",
    (input) => {
      expect(normalizeKenyanPhone(input)).toBeNull();
    },
  );
});

describe("share text", () => {
  const pass = {
    visitorName: "John Kamau",
    unit: "B12",
    expiresAt: "2026-05-14T18:00:00.000Z",
    passUrl: "https://gate.example/pass/abc_DEF-123",
  };

  it("contains the pass link and the visitor/unit, and nothing secret beyond the link", () => {
    const text = passShareText(pass);
    expect(text).toContain(pass.passUrl);
    expect(text).toContain("John Kamau");
    expect(text).toContain("B12");
    expect(text).not.toMatch(/PIN/i);
  });

  it("wa.me URL carries the fully encoded text", () => {
    const text = passShareText(pass);
    const url = whatsappShareUrl(text);
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(url.slice("https://wa.me/?text=".length))).toBe(text);
  });
});

import "@testing-library/jest-dom";
import { afterEach } from "vitest";

// jsdom keeps one window per test FILE, so storage written by a component under
// test would leak into later tests in the same file.
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

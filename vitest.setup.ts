import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Provider tests mock fetch and opt into proxy settings explicitly. Host proxy
// variables would route those fixture requests to real external services.
for (const key of ["OPENPBL_OUTBOUND_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[key];
}

afterEach(() => {
  cleanup();
});

// Polyfills for jsdom environment
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// jsdom deliberately leaves Canvas unimplemented and logs a warning on every
// getContext call. Tests that exercise rendering fallbacks only need the
// browser's nullable contract, so provide that contract without noisy output.
if (typeof globalThis.HTMLCanvasElement !== "undefined") {
  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
}

// Silence expected console errors during tests
const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && (first.includes("not wrapped in act") || first.includes("ReactDOM"))) {
    return;
  }
  originalError(...args);
};

// Stub scrollTo for jsdom
if (typeof window !== "undefined" && !window.scrollTo) {
  window.scrollTo = (() => {}) as unknown as typeof window.scrollTo;
}

// Provide a fake URL.createObjectURL for file upload tests
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = (() => "blob:mock") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as unknown as typeof URL.revokeObjectURL;
}

// Ensure vi is exposed globally for tests
export { vi };

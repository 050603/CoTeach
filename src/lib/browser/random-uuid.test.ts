import { afterEach, describe, expect, it, vi } from "vitest";
import { browserRandomUUID } from "./random-uuid";

afterEach(() => vi.unstubAllGlobals());

describe("browser request UUIDs", () => {
  it("uses native UUID generation in secure contexts", () => {
    const randomUUID = vi.fn(() => "7634b4d8-2582-4da5-bc71-a13939131e32");
    vi.stubGlobal("crypto", { randomUUID });
    expect(browserRandomUUID()).toBe("7634b4d8-2582-4da5-bc71-a13939131e32");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates distinct RFC 4122 v4 IDs when HTTP omits randomUUID", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 100 }, browserRandomUUID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });
});

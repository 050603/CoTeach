import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("retired V1 account route", () => {
  it("requires the V2 entry without accessing legacy account tables", async () => {
    const response = await POST();
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "V2_AUTH_REQUIRED" });
  });
});

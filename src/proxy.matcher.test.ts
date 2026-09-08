// @vitest-environment node

import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "./proxy";

describe("proxy matcher", () => {
  it("keeps upload bodies out of Proxy buffering", () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/uploads",
    })).toBe(false);
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/uploads/00000000-0000-4000-8000-000000000000",
    })).toBe(false);
  });

  it("continues matching protected pages and other APIs", () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/teacher",
    })).toBe(true);
    expect(unstable_doesMiddlewareMatch({
      config,
      url: "http://localhost:3000/api/courses",
    })).toBe(true);
  });
});

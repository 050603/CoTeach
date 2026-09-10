// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { signTeacherToken } from "@/lib/auth/session";
import { config, proxy } from "./proxy";

const originalSecret = process.env.JWT_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

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

describe("teacher login memory", () => {
  it("sends a returning teacher with a valid persistent session to the workspace", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const signed = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const request = new NextRequest("http://localhost:3000/teacher/login", {
      headers: { cookie: `${signed.cookieName}=${signed.token}` },
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/teacher");
  });

  it("keeps the login form available when the session was reported expired", async () => {
    process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
    const signed = await signTeacherToken({
      teacherId: "teacher-1",
      username: "teacher",
      displayName: "Teacher",
      sessionVersion: 1,
    });
    const request = new NextRequest(
      "http://localhost:3000/teacher/login?reason=session-expired",
      { headers: { cookie: `${signed.cookieName}=${signed.token}` } },
    );

    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/repository", () => ({
  PlatformError: class PlatformError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("@/lib/platform/survey-export", () => ({ createSurveyCsvExport: mocks.create }));

import { PlatformError } from "@/lib/platform/repository";
import { GET } from "./route";

const context = { params: Promise.resolve({ activityId: "survey-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.create.mockResolvedValue({
    csv: "\uFEFFstudent_name,Q1\r\n林同学,回答\r\n",
    fileName: "设计思维-课堂问卷-问卷数据.csv",
    rowCount: 1,
  });
});

describe("survey export endpoint", () => {
  it("returns an authenticated private CSV attachment", async () => {
    const response = await GET(new Request("http://localhost/api/platform/activities/survey-1/survey-export"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain(encodeURIComponent("设计思维-课堂问卷-问卷数据.csv"));
    expect(await response.text()).toContain("林同学,回答");
    expect(mocks.create).toHaveBeenCalledWith({ sub: "teacher", role: "teacher" }, "survey-1");
  });

  it("does not read survey data when authentication fails", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    const response = await GET(new Request("http://localhost/api"), context);
    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves authorization and validation errors", async () => {
    mocks.create.mockRejectedValue(new PlatformError("FORBIDDEN", "无权导出该活动数据", 403));
    const response = await GET(new Request("http://localhost/api"), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN", message: "无权导出该活动数据" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), archive: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/repository", () => ({
  PlatformError: class PlatformError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
vi.mock("@/lib/platform/student-record-export", () => ({
  STUDENT_RECORD_EXPORT_SECTIONS: ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections", "evaluations", "summary_csv"],
  createStudentRecordsArchive: mocks.archive,
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ offeringId: "course" }) };
const request = (body: unknown) => new Request("http://localhost/api/platform/offerings/course/students/export", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.archive.mockResolvedValue({ bytes: Buffer.from("zip"), fileName: "课程-学生学习记录.zip" });
});

describe("student record export endpoint", () => {
  it("returns a private ZIP for the requested students and sections", async () => {
    const response = await POST(request({ enrollmentIds: ["e1", "e2"], sections: ["summary", "evaluations"] }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain(encodeURIComponent("课程-学生学习记录.zip"));
    expect(mocks.archive).toHaveBeenCalledWith(expect.anything(), "course", ["e1", "e2"], ["summary", "evaluations"]);
  });

  it("rejects missing selections before loading records", async () => {
    const response = await POST(request({ enrollmentIds: [], sections: [] }), context);
    expect(response.status).toBe(400);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("honors same-origin and authentication failures", async () => {
    mocks.csrf.mockReturnValueOnce(new Response(null, { status: 403 }));
    expect((await POST(request({ enrollmentIds: ["e"], sections: ["summary"] }), context)).status).toBe(403);
    mocks.csrf.mockReturnValue(null);
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    expect((await POST(request({ enrollmentIds: ["e"], sections: ["summary"] }), context)).status).toBe(401);
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});

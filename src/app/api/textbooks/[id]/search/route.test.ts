import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), find: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ prisma: { textbook: { findUnique: mocks.find } } }));
vi.mock("@/lib/textbook/service", () => ({ searchTextbookEvidence: mocks.search }));
import { GET } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const invoke = (query = "q=课程", bookId = id) => GET(new Request(`http://localhost/api/textbooks/${bookId}/search?${query}`), { params: Promise.resolve({ id: bookId }) });

describe("textbook search route", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "teacher" } }); mocks.find.mockResolvedValue({ currentRevision: { id: "current" }, revisions: [{ id: "latest" }] }); mocks.search.mockResolvedValue({ query: "课程", degraded: false, hits: [] }); });
  it("queries only revision ids and searches the current revision", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.find).toHaveBeenCalledWith({ where: { id }, select: { currentRevision: { select: { id: true } }, revisions: { orderBy: { revision: "desc" }, take: 1, select: { id: true } } } });
    expect(mocks.search).toHaveBeenCalledWith({ revisionIds: ["current"], sectionIds: [], query: "课程", limit: 20 });
  });
  it("falls back to the latest revision and forwards filters", async () => {
    mocks.find.mockResolvedValue({ currentRevision: null, revisions: [{ id: "latest" }] });
    await invoke(`q=课程&sectionId=${id}&limit=5`);
    expect(mocks.search).toHaveBeenCalledWith({ revisionIds: ["latest"], sectionIds: [id], query: "课程", limit: 5 });
  });
  it("retains missing-textbook errors", async () => {
    mocks.find.mockResolvedValue(null);
    const response = await invoke();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "TEXTBOOK_NOT_FOUND", message: "教材不存在。" });
  });
  it("retains the degraded response before parsing", async () => {
    mocks.find.mockResolvedValue({ currentRevision: null, revisions: [] });
    expect(await (await invoke()).json()).toEqual({ query: "课程", degraded: true, degradationReason: "教材尚未完成结构解析。", hits: [] });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("validates requests before touching the database", async () => {
    expect((await invoke("q=")).status).toBe(400);
    expect((await invoke("q=x", "invalid")).status).toBe(404);
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("keeps the authentication response", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await invoke()).status).toBe(401);
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("preserves retrieval failures", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.search.mockRejectedValue(new Error("offline"));
    const response = await invoke();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "TEXTBOOK_SEARCH_FAILED" });
    consoleSpy.mockRestore();
  });
});

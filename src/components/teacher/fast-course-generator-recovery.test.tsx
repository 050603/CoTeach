import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/teacher/resource-package-form", () => ({ ResourcePackageForm: () => null }));
vi.mock("@/components/teacher/course-textbook-selector", () => ({ CourseTextbookSelector: () => null }));
vi.mock("@/components/teacher/quick-generation-stage", () => ({
  QuickGenerationStage: ({ failed, message, onRetry }: { failed: boolean; message: string; onRetry: () => void }) => (
    <div><p>{message}</p>{failed && <button onClick={onRetry}>从已完成页面继续</button>}</div>
  ),
}));
import { FastCourseGenerator } from "./fast-course-generator";

describe("explicit failed-stage regeneration", () => {
  beforeEach(() => { vi.useFakeTimers(); window.sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([true, false])("continues the original blueprint only after the saved-draft action, accepted=%s", async (accepted) => {
    const requests: Array<{ method: string; action?: string }> = [];
    const failedDesign = { id: "design-1", status: "failed", progress: 70, trace: [],
      step: "failed", stepIndex: 2, message: "蓝图已保存", error: "首次编译未通过", reviewStatus: "auto-continued",
      estimatedRemainingSeconds: 0, requestPreview: { teacherBrief: "保留全部流程" } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const action = typeof init?.body === "string" ? JSON.parse(init.body).action as string : undefined;
      requests.push({ method: init?.method ?? "GET", action });
      if (url.endsWith("/design-generation")) {
        if (action === "resume-saved-first-draft") return accepted
          ? Response.json({ backgroundEnabled: true, job: { ...failedDesign, status: "queued", error: null, message: "正在继续原稿" } })
          : Response.json({ error: "SAVED_FIRST_DRAFT_INVALID", detail: "教材缺失内容仍需补齐，原稿已保留。" }, { status: 422 });
        return Response.json({ backgroundEnabled: true, job: failedDesign });
      }
      if (url.endsWith("/generation")) return Response.json({ backgroundEnabled: true, job: null });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<FastCourseGenerator course={{ id: "course-1", content: { knowledgePoints: [] } } as unknown as Course}
      onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(requests.filter((request) => request.action)).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "继续已保存首稿" })); });
    expect(requests.filter((request) => request.action === "resume-saved-first-draft")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
    if (accepted) expect(screen.getByText("正在继续原稿")).toBeTruthy();
    else expect(screen.getByText("教材缺失内容仍需补齐，原稿已保留。")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(requests.filter((request) => request.action === "resume-saved-first-draft")).toHaveLength(1);
  });

  it.each([true, false])("starts a new request only after a teacher action, background=%s", async (background) => {
    const requests: Array<{ url: string; action?: string }> = [];
    let regenerating = false;
    const savedDesign = { id: "design-1", status: "completed", progress: 100, trace: [],
      step: "lessonOutline", stepIndex: 2, message: "设计已完成", reviewStatus: "approved",
      estimatedRemainingSeconds: 0, artifacts: [] };
    const failedContent = { id: "content-1", status: "failed", progress: 0, totalScenes: 3, scenesGenerated: 0,
      message: "首稿未通过质量验收", error: "教材条目缺失", activePages: [], stageProgress: [], events: [],
      requestPreview: { sceneOutlines: [] }, estimatedRemainingSeconds: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const action = typeof init?.body === "string" ? JSON.parse(init.body).action as string : undefined;
      requests.push({ url, action });
      if (url.endsWith("/design-generation")) return Response.json({ backgroundEnabled: background, job: savedDesign });
      if (action === "regenerate-failed-stages") regenerating = true;
      if (url.endsWith("/generation")) return Response.json({ backgroundEnabled: background,
        job: regenerating ? { ...failedContent, status: "running", error: null, message: "正在生成失败阶段" } : failedContent });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<FastCourseGenerator course={{ id: "course-1", content: { knowledgePoints: [] } } as unknown as Course}
      onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(requests.filter((request) => request.action === "regenerate-failed-stages")).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "从已完成页面继续" })); });
    expect(requests.filter((request) => request.action === "regenerate-failed-stages")).toHaveLength(1);
    expect(requests.filter((request) => request.action === "resume-from-checkpoints")).toHaveLength(0);
    expect(requests.filter((request) => request.url.endsWith("/design-generation") && request.action)).toHaveLength(0);
    expect(screen.getByText("正在生成失败阶段")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(requests.filter((request) => request.action === "regenerate-failed-stages")).toHaveLength(1);
  });
});

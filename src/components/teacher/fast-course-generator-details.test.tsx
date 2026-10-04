import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, TeachingBlueprint } from "@/lib/session/types";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/teacher/resource-package-form", () => ({ ResourcePackageForm: () => null }));
vi.mock("@/components/teacher/course-textbook-selector", () => ({ CourseTextbookSelector: () => null }));

import { FastCourseGenerator } from "./fast-course-generator";
import { TeachingBlueprintDetails } from "./teaching-blueprint-details";

const outline: SceneOutline = {
  id: "page-1", title: "认识训练样本", description: "比较训练集与验证集的用途", keyPoints: ["数据划分"],
  type: "slide", order: 1, lectureSectionId: "section-1", lectureSectionTitle: "训练数据", targetDurationSec: 120,
};
const blueprint: TeachingBlueprint = {
  schemaVersion: 3, inputFingerprint: "saved", createdAt: "2026-10-01T00:00:00Z", assessmentMode: "adaptive",
  budget: { totalDurationSec: 180, teachingDurationSec: 120, learnerActivityDurationSec: 0, assessmentDurationSec: 60, teachingRatio: 2 / 3, assessmentRatio: 1 / 3 },
  sections: [{
    id: "section-1", title: "训练数据", order: 1, learningObjective: "区分数据集用途", knowledgePointIds: ["kp-1"],
    teachingDurationSec: 120, learnerActivityDurationSec: 0, assessmentDurationSec: 60,
    sharedContext: { learningPurpose: "理解模型验证", caseId: "case-1", caseFacts: ["验证集独立于训练集"], fixedWording: [], stableTerms: ["训练集"], conceptBoundaries: ["不能用验证集训练模型"] },
    units: [{ id: "unit-1", title: "数据划分的理由", knowledgePointIds: ["kp-1"], learningOutcome: "解释为什么分开数据", explanation: "独立验证集用于评估模型的泛化表现。", mechanism: "通过未用于训练的数据检验模型。", workedExample: "将样本分别用于训练与验证。", conditions: ["保持验证集独立"], misconceptions: ["训练准确率等于泛化能力"], sourceKind: "course-source", evidenceQuotes: ["验证集不得参与模型训练。"] }],
    pages: [{ id: "page-1", title: outline.title, type: "slide", unitIds: ["unit-1"], knowledgePointIds: ["kp-1"], description: outline.description, keyPoints: outline.keyPoints, teachingObjective: "比较两类数据集" }],
    assessmentFocus: ["判断数据是否独立"], understandingCriteria: { goals: ["区分训练与验证"], answerEssentials: ["验证数据不参与训练"], misconceptions: [], supportingUnitIds: ["unit-1"] },
  }],
};

describe("saved course outline and blueprint details", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); window.sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    ["running", null], ["paused", null], ["completed", "running"], ["completed", "failed"],
    ["completed", "completed"], ["failed", null], ["cancelled", null], [null, null],
  ])("reopens details with design=%s and classroom=%s using only reads", async (designStatus, classroomStatus) => {
    const requests: string[] = [];
    let designReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init?.method ?? "GET");
      if (String(input).endsWith("/design-generation")) {
        designReads++;
        return Response.json({ backgroundEnabled: true, outlinePreview: [{ ...outline, title: designReads > 1 ? "最新训练样本安排" : outline.title }], blueprintPreview: blueprint,
          job: designStatus ? { id: "design-1", status: designStatus, step: designStatus === "paused" ? "outlineReview" : "lessonOutline", progress: 92, trace: [], message: "正在生成", reviewKind: "outline", reviewStatus: "auto-continued", requestPreview: { generationScope: "test-lesson" } } : null });
      }
      if (String(input).endsWith("/generation")) return Response.json({ backgroundEnabled: true, job: {
        id: "classroom-job", status: classroomStatus, progress: 60, message: "制作课堂页面", events: [], totalScenes: 2, scenesGenerated: 1,
        ...(classroomStatus === "completed" ? { result: { id: "classroom-1", scenesCount: 2 } } : {}),
      } });
      throw new Error(`Unexpected request: ${input}`);
    }));
    render(<FastCourseGenerator course={{ id: "course-1", content: { knowledgePoints: [] } } as unknown as Course} onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看大纲与蓝图" })); });
    const dialog = screen.getByRole("dialog", { name: "查看课程大纲与教学蓝图" });
    expect(within(dialog).getByDisplayValue("最新训练样本安排")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "确认大纲并继续生成" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "教学蓝图" }));
    expect(within(dialog).getByText("独立验证集用于评估模型的泛化表现。")).toBeTruthy();
    expect(within(dialog).getByText("不能用验证集训练模型")).toBeTruthy();
    expect(within(dialog).getByText("验证集不得参与模型训练。")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "返回生成进度" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看大纲与蓝图" })); });
    expect(screen.getByRole("dialog", { name: "查看课程大纲与教学蓝图" })).toBeTruthy();
    expect(requests.every((method) => method === "GET")).toBe(true);
  });

  it("shows the canonical lecture and display text without the obsolete authored copies", () => {
    const spoken = structuredClone(blueprint);
    const section = spoken.sections[0]!;
    section.contentMode = "spoken";
    section.units[0]!.explanationNodes = [{ id: "node-1", kind: "concept", content: "先保留一组独立样本，训练完成后再检验模型。", prerequisiteNodeIds: [], provenance: "course-source" }];
    section.pages[0]!.presentationItems = [{ text: "独立样本用于检验", nodeIds: ["node-1"], role: "key-point" }];
    render(<TeachingBlueprintDetails blueprint={spoken} />);
    expect(screen.getByText("先保留一组独立样本，训练完成后再检验模型。")).toBeTruthy();
    expect(screen.getByText("独立样本用于检验")).toBeTruthy();
    expect(screen.queryByText(section.units[0]!.explanation)).toBeNull();
    expect(screen.queryByText(section.units[0]!.mechanism)).toBeNull();
    expect(screen.queryByText(section.units[0]!.workedExample)).toBeNull();
  });

  it("keeps cached details readable when refreshing them fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "UNAVAILABLE", detail: "暂时无法连接，请稍后重试。" }, { status: 503 })));
    render(<FastCourseGenerator course={{ id: "course-1", content: { knowledgePoints: [], _openmaicSceneOutlines: [{ id: outline.id, title: outline.title }], teachingBlueprint: blueprint } } as unknown as Course} onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看大纲与蓝图" })); });
    const dialog = screen.getByRole("dialog", { name: "查看课程大纲与教学蓝图" });
    expect(within(dialog).getByDisplayValue(outline.title)).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("暂时无法连接");
  });

  it("preserves unsubmitted generation requirements and options when viewing a failed task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ backgroundEnabled: true, outlinePreview: [outline], blueprintPreview: blueprint,
      job: { id: "failed-design", status: "failed", step: "failed", progress: 80, trace: [], message: "原稿已保存",
        requestPreview: { teacherBrief: "旧的课程要求", generationMode: "standard", assessmentMode: "adaptive", options: { enableTTS: true, enableImageGeneration: true, enableVideoGeneration: false } } },
    })));
    render(<FastCourseGenerator course={{ id: "course-1", content: { knowledgePoints: [] } } as unknown as Course} onOpenDetailed={vi.fn()} simplified />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "正在修改的新要求" } });
    fireEvent.click(screen.getByRole("button", { name: "开启深度交互模式" }));
    fireEvent.click(screen.getByRole("button", { name: /语音：/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查看大纲与蓝图" })); });
    fireEvent.click(screen.getByRole("button", { name: "返回生成进度" }));
    expect(screen.getByLabelText("补充课程生成要求（可选）")).toHaveValue("正在修改的新要求");
    expect(screen.getByRole("button", { name: "关闭深度交互，使用普通模式" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /语音：/ })).toHaveAttribute("aria-pressed", "false");
  });
});

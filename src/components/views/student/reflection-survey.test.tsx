import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStagesForSystemMode } from "@/lib/system-mode";
import type { Course, ReflectionSurveyResponseV1 } from "@/lib/session/types";
import { REFLECTION_SURVEY_QUESTIONS } from "@/lib/reflection-survey";
import { NewReflectionStudentView } from "./reflection-survey";

const mocks = vi.hoisted(() => ({
  buildReflectionEvidencePrompts: vi.fn(),
  upsertAiSupport: vi.fn(),
  upsertReflection: vi.fn(),
  updateStudentProgress: vi.fn(),
  markResourceDownloaded: vi.fn(),
}));

vi.mock("@/lib/teaching-ai/client-api", () => ({
  buildReflectionEvidencePrompts: mocks.buildReflectionEvidencePrompts,
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({
    user: { role: "student", name: "小林" },
    studentId: "student-1",
    studentName: "小林",
    upsertAiSupport: mocks.upsertAiSupport,
    upsertReflection: mocks.upsertReflection,
    updateStudentProgress: mocks.updateStudentProgress,
    markResourceDownloaded: mocks.markResourceDownloaded,
  }),
}));

const generatedSupport = {
  stageKey: "reflection",
  targetType: "student" as const,
  targetId: "student-1",
  studentId: "student-1",
  kind: "reflection-evidence" as const,
  trigger: "新版反思提示",
  inputSummary: "课程过程",
  diagnosis: "回顾一个真实变化。",
  suggestions: ["你最重要的收获和最难的一步是什么？", "AI 协作中什么有帮助？下一轮最想调整什么？"],
  evidence: ["过程记录"],
  status: "draft" as const,
  source: "llm" as const,
};

function makeCourse(overrides: Partial<Course> = {}): Course {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    id: "course-1",
    name: "校园减塑",
    subject: "科学",
    grade: "六年级",
    hours: 5,
    summary: "完成个人项目",
    drivingQuestion: "如何改善校园环境？",
    status: "teaching",
    stages: getStagesForSystemMode("new"),
    currentStageIndex: 4,
    students: [{ id: "student-1", name: "小林", joinedAt: now, stageProgress: {} }],
    groups: [{
      id: "project-1",
      name: "小林的个人项目",
      topic: "校园环境",
      keywords: [],
      selectedForms: [],
      members: [{ studentId: "student-1", name: "小林" }],
      createdAt: now,
      updatedAt: now,
    }],
    resources: [],
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fillCompleteSurvey() {
  fireEvent.change(screen.getByLabelText(REFLECTION_SURVEY_QUESTIONS.learningReflection), {
    target: { value: "我用调查数据修改了方案，并发现证据能帮助我做取舍。" },
  });
  fireEvent.change(screen.getByLabelText(REFLECTION_SURVEY_QUESTIONS.systemReflection), {
    target: { value: "AI 的提问很有帮助，资源入口还可以更清楚。" },
  });
  fireEvent.click(screen.getByLabelText(`${REFLECTION_SURVEY_QUESTIONS.aiHelpfulness}：4分，同意`));
  fireEvent.click(screen.getByLabelText(`${REFLECTION_SURVEY_QUESTIONS.systemUsability}：5分，非常同意`));
  fireEvent.click(screen.getByLabelText(`${REFLECTION_SURVEY_QUESTIONS.reuseIntention}：4分，同意`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildReflectionEvidencePrompts.mockResolvedValue(generatedSupport);
  mocks.upsertAiSupport.mockReturnValue({
    ...generatedSupport,
    id: "support-1",
    courseId: "course-1",
    studentName: "小林",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
});

describe("NewReflectionStudentView", () => {
  it("submits confirmed course questions and experience survey independently", () => {
    const course = makeCourse();
    const questionSet = { id: "package-questions", version: 2, questions: [{ id: "decision", prompt: "哪次迭代改变了你的判断？", required: true }, { id: "next", prompt: "下一轮会做什么？", required: false }] };
    course.content.stagePlan = { stages: [], reflectionQuestionSet: questionSet } as unknown as NonNullable<Course["content"]["stagePlan"]>;
    mocks.upsertReflection.mockImplementation((record) => ({ ...record, id: "new-record" }));
    render(<NewReflectionStudentView course={course} />);
    expect(screen.queryByLabelText(REFLECTION_SURVEY_QUESTIONS.learningReflection)).toBeNull();
    expect((screen.getByRole("button", { name: "提交课程反思" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("系统体验意见"), { target: { value: "希望 AI 回答更清楚" } });
    for (const field of ["aiHelpfulness", "systemUsability", "reuseIntention"] as const) fireEvent.click(within(screen.getByRole("group", { name: REFLECTION_SURVEY_QUESTIONS[field] })).getByLabelText("4 同意"));
    fireEvent.click(screen.getByRole("button", { name: "提交系统体验问卷" }));
    expect(mocks.updateStudentProgress).not.toHaveBeenCalled();
    expect(mocks.upsertReflection).toHaveBeenLastCalledWith(expect.objectContaining({ courseReflection: undefined, experienceSurvey: expect.objectContaining({ systemReflection: "希望 AI 回答更清楚" }) }));
    fireEvent.change(screen.getByLabelText(questionSet.questions[0].prompt), { target: { value: "核验调查证据后，我修改了方案。" } });
    fireEvent.click(screen.getByRole("button", { name: "提交课程反思" }));
    expect(mocks.upsertReflection).toHaveBeenLastCalledWith(expect.objectContaining({ id: "new-record", courseReflection: expect.objectContaining({ questionSetId: questionSet.id, questionSetVersion: 2, questions: questionSet.questions, answers: { decision: "核验调查证据后，我修改了方案。", next: "" } }), experienceSurvey: expect.objectContaining({ systemReflection: "希望 AI 回答更清楚" }) }));
    expect(mocks.updateStudentProgress).toHaveBeenCalledWith("reflection", 100);
  });
  it("shows the compact questions, AI prompts, and validates all five answers", async () => {
    render(<NewReflectionStudentView course={makeCourse()} />);

    expect(screen.getByRole("heading", { name: "学习反思" })).toBeTruthy();
    expect(screen.getAllByText("0/5 已完成").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("需要一点思路？").length).toBe(2);
    expect(screen.queryByText("回顾这次学习，也回顾系统体验")).toBeNull();
    expect(screen.queryByText("预计 3–5 分钟完成。没有标准答案，请用自己的真实经历回答。")).toBeNull();
    expect(screen.queryByText("姓名、学生编号和回答将对任课教师可见，并用于教学改进与本课程实验分析。")).toBeNull();
    expect(screen.getByText("* 回答将仅用于教学计划改进和本课程实验分析。")).toBeTruthy();
    expect(screen.queryByText("只提供回忆角度，不会替你写答案。")).toBeNull();
    await waitFor(() => expect(mocks.buildReflectionEvidencePrompts).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: "student-1", format: "compact" }),
    ));
    expect(screen.getByText("你最重要的收获和最难的一步是什么？")).toBeTruthy();
    expect((screen.getByRole("button", { name: "提交学习反思" }) as HTMLButtonElement).disabled).toBe(true);

    fillCompleteSurvey();
    expect((screen.getByRole("button", { name: "提交学习反思" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stores a structured response and marks the reflection stage complete", () => {
    render(<NewReflectionStudentView course={makeCourse()} />);
    fillCompleteSurvey();
    fireEvent.click(screen.getByRole("button", { name: "提交学习反思" }));

    expect(mocks.upsertReflection).toHaveBeenCalledWith(expect.objectContaining({
      studentName: "小林",
      survey: {
        schemaVersion: 1,
        learningReflection: "我用调查数据修改了方案，并发现证据能帮助我做取舍。",
        systemReflection: "AI 的提问很有帮助，资源入口还可以更清楚。",
        aiHelpfulness: 4,
        systemUsability: 5,
        reuseIntention: 4,
      } satisfies ReflectionSurveyResponseV1,
    }));
    expect(mocks.updateStudentProgress).toHaveBeenCalledWith("reflection", 100);
    expect(screen.getByText("反思已提交")).toBeTruthy();
  });

  it("marks edits as pending and uses the same update action label", () => {
    const course = makeCourse({
      reflections: [{
        id: "reflection-1",
        courseId: "course-1",
        studentId: "student-1",
        studentName: "小林",
        content: "旧格式兼容文本",
        survey: {
          schemaVersion: 1,
          learningReflection: "已经完成一次方案迭代。",
          systemReflection: "AI 提问很有帮助。",
          aiHelpfulness: 4,
          systemUsability: 3,
          reuseIntention: 5,
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:10:00.000Z",
      }],
    });
    render(<NewReflectionStudentView course={course} />);
    fireEvent.change(screen.getByLabelText(REFLECTION_SURVEY_QUESTIONS.learningReflection), { target: { value: "修改后的反思。" } });
    expect(screen.getByText("有修改待重新提交")).toBeTruthy();
    expect((screen.getByRole("button", { name: "更新学习反思" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the fixed prompts when the AI request fails", async () => {
    mocks.buildReflectionEvidencePrompts.mockRejectedValueOnce(new Error("服务不可用"));
    render(<NewReflectionStudentView course={makeCourse()} />);

    await waitFor(() => expect(screen.getByText("你最重要的收获和最难的一步分别是什么？它们之间有什么联系？")).toBeTruthy());
    expect(screen.getByText("AI 协作中什么真正帮助了你？下一轮课程最值得调整什么？")).toBeTruthy();
  });

  it("restores an existing response and disables editing after the course ends", () => {
    const survey: ReflectionSurveyResponseV1 = {
      schemaVersion: 1,
      learningReflection: "已经完成一次方案迭代。",
      systemReflection: "AI 提问很有帮助。",
      aiHelpfulness: 4,
      systemUsability: 3,
      reuseIntention: 5,
    };
    const course = makeCourse({
      status: "finished",
      reflections: [{
        id: "reflection-1",
        courseId: "course-1",
        studentId: "student-1",
        studentName: "小林",
        content: "旧格式兼容文本",
        survey,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:10:00.000Z",
      }],
    });
    render(<NewReflectionStudentView course={course} />);

    expect(screen.getByDisplayValue("已经完成一次方案迭代。")).toBeTruthy();
    expect(screen.getByText("课程已结束，反思内容仅供查看。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "更新学习反思" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.buildReflectionEvidencePrompts).not.toHaveBeenCalled();
  });
});

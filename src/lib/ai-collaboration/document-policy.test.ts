import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import {
  buildDocumentCollaborationPrompts,
  detectProtectedStudentWorkRequest,
  documentHtmlToPlainText,
  evaluateAiWorkPolicy,
  normalizeDocumentCollaborationResponse,
  protectedBoundaryForPolicy,
} from "./document-policy";

const course = {
  id: "course-1",
  name: "校园节水项目",
  drivingQuestion: "怎样减少校园中的水资源浪费？",
  expectedOutcome: "一份可验证的节水改进方案",
  learningObjectives: ["使用证据解释问题", "验证方案效果"],
  stages: [{ key: "proposal", label: "方案构思", description: "形成可验证的节水方案" }],
  currentStageIndex: 0,
  students: [{ id: "student-1", name: "小林", joinedAt: "2026-08-25T00:00:00.000Z", stageProgress: {} }],
  groups: [{
    id: "group-1",
    name: "节水行动组",
    topic: "教学楼洗手池节水",
    goal: "找到主要浪费原因并提出可验证的改进",
    selectedForms: ["方案报告"],
    keywords: ["节水"],
    members: [{ studentId: "student-1", name: "小林" }],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  }],
  feedback: [],
  learningEvidence: [],
  teacherAgentDirectives: [],
  content: {
    knowledgePoints: [{ id: "kp-1", name: "变量控制" }],
    evaluationPlan: { dimensions: [{ name: "证据质量", weight: 40 }] },
  },
} as unknown as Course;

describe("document AI collaboration policy", () => {
  it("treats the editor content as an in-progress live draft", () => {
    const prompts = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "discuss",
      request: "这个方向还有什么问题？",
      documentText: "我准备先记录三天用水情况。",
    });
    expect(prompts.system).toContain("协作从草稿形成时就开始");
    expect(prompts.system).toContain("核心问题定义、关键方案决策、核心结论、最终提交");
    expect(prompts.user).toContain("编辑器中的最新实时草稿");
    expect(prompts.user).toContain("我准备先记录三天用水情况");
    expect(prompts.user).toContain("证据质量");
    expect(prompts.user).toContain("教学楼洗手池节水");
    expect(prompts.user).toContain("形成可验证的节水方案");
    expect(prompts.user).toContain("方案报告");
  });

  it("keeps proactive collaboration narrow and non-editing", () => {
    const prompts = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "check",
      request: "看一眼当前草稿",
      documentText: "我们已经记录了三个时间段，但还没有说明为什么选择这些时间。",
      proactive: true,
    });
    expect(prompts.user).toContain("克制的主动观察");
    expect(prompts.user).toContain("不得返回修改建议");
  });

  it("gives discussion and delegated tasks distinct, teammate-oriented instructions", () => {
    const discussion = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "discuss",
      request: "我们下一步该看什么？",
      documentText: "已经观察了三个课间的用水情况。",
    });
    expect(discussion.user).toContain("具体观察");
    expect(discussion.system).toContain("现状分析、原因、建议和下一步");
    expect(discussion.system).toContain("不得替学生形成核心结论");

    const task = buildDocumentCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "proposal",
      intent: "organize",
      request: "把这两段整理得更清楚",
      documentText: "第一段。\n\n第二段。",
      selectedText: "第一段。\n\n第二段。",
    });
    expect(task.user).toContain("执行学生明确委托");
    expect(task.system).toContain("用两个换行分隔段落");
    expect(task.system).toContain("不要只复述任务或罗列通用建议");
  });

  it("binds an edit suggestion to the exact client selection", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "我只整理这一处表达。",
      focus: "测试步骤",
      suggestion: {
        title: "整理测试步骤",
        targetText: "模型试图替换成别的范围",
        replacement: "连续三天在同一时段记录用水量。",
        reason: "让时间和动作更明确。",
      },
    }, "记录几天的用水情况");
    expect(result.kind).toBe("edit-suggestion");
    expect(result.suggestion?.operation).toBe("replace");
    expect(result.suggestion?.targetText).toBe("记录几天的用水情况");
  });

  it("allows a bounded delegated task to propose an insertion", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "我整理了一段非核心背景，写入前请核对。",
      focus: "背景说明",
      suggestion: {
        operation: "insert",
        title: "补充背景说明",
        targetText: "",
        replacement: "现有观察显示，用水高峰主要集中在课间时段。",
        reason: "只整理草稿中已经出现的观察。",
      },
    }, undefined, undefined, "organize");
    expect(result.kind).toBe("edit-suggestion");
    expect(result.suggestion?.operation).toBe("insert");
  });

  it("downgrades an edit response when no text was selected", () => {
    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "请选择范围。",
      suggestion: { replacement: "整篇新文档" },
    });
    expect(result.kind).toBe("discussion");
    expect(result.suggestion).toBeUndefined();
  });

  it("extracts readable text from the rich-text document", () => {
    expect(documentHtmlToPlainText("<h2>方案</h2><p>先观察&amp;记录</p><p>再验证</p>"))
      .toBe("方案\n先观察&记录\n再验证");
  });

  it("deterministically protects student-owned core decisions and final work", () => {
    expect(detectProtectedStudentWorkRequest("帮我直接确定最终方案"))
      .toBe("关键方案决策");
    expect(detectProtectedStudentWorkRequest("请你生成完整项目报告"))
      .toBe("完整成果或最终提交");
    expect(detectProtectedStudentWorkRequest("帮我检查核心问题是否清楚"))
      .toBeUndefined();

    const result = normalizeDocumentCollaborationResponse({
      kind: "edit-suggestion",
      message: "你可以先比较两个方案的证据要求，再亲自决定。",
      suggestion: { replacement: "AI 选定的方案" },
    }, "学生原文", "关键方案决策");
    expect(result.kind).toBe("boundary");
    expect(result.suggestion).toBeUndefined();
  });

  it("keeps core project decisions in guide-only mode", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "请直接写出我们的核心结论",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("guide_only");
    expect(decision.allowedOperations).toEqual(["none"]);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.protectedCapability).toBe("核心结论");
  });

  it("keeps ordinary discussion guidance internal instead of presenting it as a boundary", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "我们记录了三个课间，下一步应该重点比较什么？",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("guide_only");
    expect(protectedBoundaryForPolicy(decision, "我们记录了三个课间，下一步应该重点比较什么？"))
      .toBeUndefined();

    const protectedDecision = evaluateAiWorkPolicy({
      intent: "discuss",
      request: "请直接写出我们的核心结论",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(protectedBoundaryForPolicy(protectedDecision, "请直接写出我们的核心结论"))
      .toBe("核心结论");
  });

  it("allows only confirmed local work for an existing selection", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "edit",
      request: "把这句话润色得更清楚",
      scope: "selection",
      selectedText: "我们观察了几个时间段。",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("local_suggestion");
    expect(decision.scope).toBe("selection");
    expect(decision.allowedOperations).toEqual(["replace"]);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("does not let proactive review run before student work exists", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "check",
      request: "看看这一段有没有问题",
      scope: "paragraph",
      proactive: true,
      hasStudentArtifact: false,
      selectedText: "",
    });
    expect(decision.outcome).toBe("guide_only");
    expect(decision.requiresExistingStudentWork).toBe(true);
    expect(decision.allowedOperations).toEqual(["none"]);
  });

  it("permits bounded auxiliary work while retaining confirmation", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "delegate",
      request: "整理已有观察，列出需要核对的资料来源",
      scope: "document",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("delegated_edit");
    expect(decision.allowedOperations).toEqual(["insert", "append"]);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("keeps a selected delegate request local", () => {
    const decision = evaluateAiWorkPolicy({
      intent: "delegate",
      request: "整理这段表达",
      scope: "selection",
      selectedText: "我们观察了几个时间段。",
      hasStudentArtifact: true,
    });
    expect(decision.outcome).toBe("local_suggestion");
    expect(decision.scope).toBe("selection");
    expect(decision.allowedOperations).toEqual(["replace"]);
  });
});

import { describe, expect, it } from "vitest";
import { publicResourcePackageSnapshot, withoutPrivatePackageContent } from "./privacy";
import { emptyResourcePackageDraft, resourcePackageDraftErrors, stagePlanFromResourcePackage } from "./types";

describe("resource package authoring boundary", () => {
  it("keeps private teacher inputs out of student snapshots without mutating the original", () => {
    const content = { resourcePackage: { source: { url: "/api/uploads/private" }, raw: "private teacher requirements" }, teachingBlueprint: { internal: "private compilation" }, teachingTimingAudit: { internal: "private timing" }, designGenerationTrace: { diagnostics: "private" }, teacherReview: { teacherId: "private" }, renderReview: { evidence: "private" }, qualityReview: { source: "private" }, qualityReviewRequired: true, stagePlan: { totalMinutes: 135 }, knowledgePoints: [] };
    const snapshot = { schemaVersion: 2, kind: "pbl-course", design: { content } };
    expect(publicResourcePackageSnapshot(snapshot).design.content).toEqual({ stagePlan: { totalMinutes: 135 }, knowledgePoints: [] });
    expect(withoutPrivatePackageContent(content)).not.toHaveProperty("resourcePackage");
    expect(withoutPrivatePackageContent(content)).not.toHaveProperty("teachingBlueprint");
    expect(withoutPrivatePackageContent(content)).not.toHaveProperty("teachingTimingAudit");
    expect(withoutPrivatePackageContent(content)).not.toHaveProperty("designGenerationTrace");
    expect(content.resourcePackage.raw).toContain("private");
  });
  it("preserves exact lesson minutes and reports conflicts instead of silently scaling", () => {
    const draft = { ...emptyResourcePackageDraft(), courseName: "AI教学设计", grade: "本科一年级", drivingQuestion: "如何设计合适的AI课程？",
      learningObjectives: ["选择适合的教学方法"], expectedOutcome: "课程方案", knowledgePoints: [{ name: "教学模式", description: "", subPoints: ["项目式学习"] }],
      lessonCount: 3, minutesPerLesson: 45, totalMinutes: 135 };
    draft.stages = draft.stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index], requirements: "小组讨论并完成个人作品" }));
    expect(resourcePackageDraftErrors(draft)).toEqual([]);
    const plan = stagePlanFromResourcePackage(draft);
    expect(plan.totalMinutes).toBe(135);
    expect(plan.stages.map((stage) => stage.durationMin)).toEqual([15, 30, 60, 20, 10]);
    expect(plan.stages[0].requirements).toContain("AI 伙伴");
    expect(resourcePackageDraftErrors({ ...draft, totalMinutes: 180 })).toContain("五阶段时长之和必须等于课程总分钟数，请修正教案时间。");
  });
});

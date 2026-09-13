import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { adaptResourcePackageDraft, inspectPackageCompatibility, readPresentationEvidence, resourcePackageFeedback } from "./compatibility";
import { emptyResourcePackageDraft, type CourseResourcePackage } from "./types";

describe("resource package compatibility review", () => {
  it("uses the presentation relationship order after a teacher reorders PPT slides", async () => {
    const bytes = await new JSZip().file("ppt/presentation.xml", '<p:presentation><p:sldIdLst><p:sldId id="10" r:id="rId2"/><p:sldId id="20" r:id="rId1"/></p:sldIdLst></p:presentation>')
      .file("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide8.xml"/></Relationships>')
      .file("ppt/slides/slide1.xml", '<p:sld><a:t>实际第二页</a:t></p:sld>').file("ppt/slides/slide8.xml", '<p:sld><a:t>实际第一页</a:t></p:sld>').generateAsync({ type: "nodebuffer" });
    expect(readPresentationEvidence(bytes)).toEqual([
      { documentRole: "launchPresentation", locator: "第1页", archivePath: "ppt/slides/slide8.xml", quote: "实际第一页" },
      { documentRole: "launchPresentation", locator: "第2页", archivePath: "ppt/slides/slide1.xml", quote: "实际第二页" },
    ]);
  });
  it("detects mixed real and virtual group instructions on the same PPT page", () => {
    const review = inspectPackageCompatibility("", [{ documentRole: "launchPresentation", locator: "第4页", quote: "每位学生拥有AI虚拟小组。\n请每组5名学生，记录组员姓名。" }]);
    expect(review.conflicts).toHaveLength(1);
    expect(review.conflicts[0].evidence[0].locator).toBe("第4页");
  });
  it("does not mistake supported AI collaboration or discussion of a learning theory for a real team instruction", () => {
    expect(inspectPackageCompatibility("学生与AI虚拟小组共同讨论。\n合作学习强调交流、反馈与意义协商。", []).conflicts).toEqual([]);
  });
  it("keeps source-specific evidence and generates downloadable upstream feedback", () => {
    const review = inspectPackageCompatibility("教师评分70%，同伴互评20%，小组自评10%。", []);
    expect(review.conflicts[0].kind).toBe("evaluation");
    const pack = { schemaVersion: 2, source: { fileName: "教学资源包.zip" }, revision: 7, ...review } as CourseResourcePackage;
    expect(resourcePackageFeedback(pack)).toContain("来源版本：7");
    expect(resourcePackageFeedback(pack)).toContain("同伴互评20%");
    expect(resourcePackageFeedback(pack)).toContain(review.conflictVersion);
  });
  it("adapts the whole confirmed plan without multiplying per-group times or changing budgets", () => {
    const draft = emptyResourcePackageDraft(); draft.totalMinutes = 135;
    draft.stages.forEach((stage, index) => { stage.durationMin = [15, 30, 60, 20, 10][index]; stage.requirements = "组建小组，每组5名学生"; stage.outputs = "小组作品"; stage.observationPoints = ["观察小组分工是否均衡，是否存在边缘化成员"]; });
    draft.stages[3].teacherActions = "每组展示4.66分钟、交流1.33分钟、衔接0.66分钟。";
    draft.stages[2].outputs = "完成10页PPT初稿及详细教案文本";
    draft.stages[2].checkpoints = ["第3课时前：完成10页PPT终稿"];
    const first = adaptResourcePackageDraft(draft).draft;
    expect(first.totalMinutes).toBe(135);
    expect(first.stages.map((stage) => stage.durationMin)).toEqual([15, 30, 60, 20, 10]);
    expect(first.stages[3].teacherActions).not.toMatch(/4\.66|1\.33|0\.66|每人/);
    expect(first.stages[3].requirements).toContain("教师选取部分学生在20分钟总预算内现场汇报");
    expect(first.stages[2].outputs).toContain("初稿（按课次检查点继续修订并交付终稿）");
    expect(adaptResourcePackageDraft(first).draft.stages[3].requirements).toBe(first.stages[3].requirements);
    expect(inspectPackageCompatibility(first.stages.map((stage) => JSON.stringify(stage)).join("\n"), []).conflicts).toEqual([]);
  });
});

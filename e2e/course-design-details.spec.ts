import { expect, test } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES } from "../src/lib/session/types";

test("saved outlines and blueprints remain readable during classroom generation", async ({ page }, testInfo) => {
  const courseId = "e2e-course-design-details";
  const timestamp = new Date().toISOString();
  const outlines = Array.from({ length: 12 }, (_, index) => ({
    id: `page-${index + 1}`, type: "slide", title: `训练数据页面 ${index + 1}`,
    description: "比较训练数据和独立验证数据的用途，解释判断依据。", keyPoints: ["训练集用于训练", "验证集检验泛化表现"],
    order: index + 1, lectureSectionId: "section-1", lectureSectionTitle: "训练数据", targetDurationSec: 120,
  }));
  const blueprint = {
    schemaVersion: 3, inputFingerprint: "browser-fixture", createdAt: timestamp, assessmentMode: "adaptive",
    budget: { totalDurationSec: 1500, teachingDurationSec: 1440, learnerActivityDurationSec: 0, assessmentDurationSec: 60, teachingRatio: .96, assessmentRatio: .04 },
    sections: [{
      id: "section-1", title: "训练数据", order: 1, learningObjective: "解释数据划分的理由", knowledgePointIds: ["kp-1"],
      teachingDurationSec: 1440, learnerActivityDurationSec: 0, assessmentDurationSec: 60,
      sharedContext: { learningPurpose: "理解独立验证", caseId: "case-1", caseFacts: ["验证样本不用于训练"], fixedWording: [], stableTerms: ["训练集", "验证集"], conceptBoundaries: ["训练准确率不等于泛化能力"] },
      units: [{ id: "unit-1", title: "数据划分的理由", knowledgePointIds: ["kp-1"], learningOutcome: "区分训练与验证", explanation: "独立验证集用于评估模型的泛化表现。", mechanism: "用未参与训练的数据检验模型。", workedExample: "将样本分别用于训练与验证。", conditions: ["保持验证集独立"], misconceptions: ["训练准确率可以代替验证"], sourceKind: "course-source", evidenceQuotes: ["验证集不得参与模型训练。"] }],
      pages: outlines.map((outline) => ({ ...outline, unitIds: ["unit-1"], knowledgePointIds: ["kp-1"], teachingObjective: "解释数据集用途" })),
      assessmentFocus: ["判断数据是否独立"], understandingCriteria: { goals: ["解释验证的用途"], answerEssentials: ["验证数据不参与训练"], misconceptions: [], supportingUnitIds: ["unit-1"] },
    }],
  };
  const course = {
    id: courseId, version: 1, name: "数据划分教学", subject: "人工智能", grade: "高中", hours: 1, summary: "数据划分", drivingQuestion: "如何评估模型？",
    status: "draft", stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0, students: [], resources: [], groups: [], inviteCode: "DETAIL", createdAt: timestamp, updatedAt: timestamp,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], teachingOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  };
  const baseURL = testInfo.project.use.baseURL || "http://localhost:3000";
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (secret) {
    const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-details", displayName: "详情验收教师" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("e2e-details-teacher").setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  const writes: string[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket((url) => !url.pathname.includes("_next"), (socket) => socket.onMessage(() => undefined));
  // All API calls use fixtures, so browser verification cannot alter saved courses.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/me") return json({ user: { id: "e2e-details-teacher", role: "teacher", name: "详情验收教师", displayName: "详情验收教师" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "详情验收教师" }, hydrated: true, updatedAt: timestamp });
    if (path.endsWith("/state")) return json({ course, eventCursor: "0" });
    if (path.endsWith("/events")) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
    if (path.endsWith("/presence")) return json({ members: [], degraded: false });
    if (path === "/api/textbooks") return json({ textbooks: [] });
    if (path.endsWith("/resource-package")) return json({ job: null });
    if (path.endsWith("/design-generation")) return json({ backgroundEnabled: true, outlinePreview: outlines, blueprintPreview: blueprint,
      job: { id: "design-1", status: "completed", step: "completed", progress: 100, trace: [], reviewStatus: "auto-continued", updatedAt: timestamp } });
    if (path.endsWith("/generation")) return json({ backgroundEnabled: true, job: {
      id: "classroom-job-1", status: "running", progress: 60, scenesGenerated: 3, totalScenes: 12, message: "正在制作课堂页面", events: [], updatedAt: timestamp,
    } });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/teacher/prepare/${courseId}/verify`, { waitUntil: "domcontentloaded" });
  const view = page.getByRole("button", { name: "查看大纲与蓝图", exact: true });
  await expect(view).toBeEnabled();
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    await page.setViewportSize(viewport);
    await view.click();
    const dialog = page.getByRole("dialog", { name: "查看课程大纲与教学蓝图" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "确认大纲并继续生成" })).toHaveCount(0);
    const firstPageTitle = dialog.getByRole("article", { name: "第 1 页：训练数据页面 1" }).locator("textarea").first();
    await expect(firstPageTitle).toHaveValue("训练数据页面 1");
    await expect(firstPageTitle).toBeDisabled();
    const scrollArea = dialog.getByTestId("outline-review-scroll-area");
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await scrollArea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(dialog.getByRole("button", { name: "返回生成进度" })).toBeInViewport();
    await dialog.getByRole("button", { name: "教学蓝图", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "教学蓝图", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "页面大纲", exact: true })).toHaveAttribute("aria-pressed", "false");
    await scrollArea.evaluate((element) => { element.scrollTop = 0; });
    await expect(dialog.getByText("独立验证集用于评估模型的泛化表现。", { exact: true })).toBeVisible();
    await expect(dialog.getByText("验证集不得参与模型训练。", { exact: true })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`details-${viewport.width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "返回生成进度" }).click();
    await expect(dialog).toBeHidden();
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(view).toBeEnabled();
  await view.click();
  await expect(page.getByRole("dialog", { name: "查看课程大纲与教学蓝图" })).toBeVisible();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

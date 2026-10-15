import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { composeExperimentForms, publicExperimentQuestions, type ExperimentConfig, type ExperimentQuestion } from "../src/lib/platform/experiment";
import { COTEACH_COMMUNITY_REFERENCE, COTEACH_SYSTEM_REFERENCE, COTEACH_TEACHER_REFERENCE, createCoTeachAssessmentTemplate } from "../src/lib/platform/experiment-templates";

test.use({ serviceWorkers: "block" });

const courseId = "e2e-posttest-layout";
const studentId = "e2e-posttest-student";
const fixedTime = "2026-09-25T00:00:00.000Z";
const questions: ExperimentQuestion[] = [
  { id: "q1", type: "single-choice", prompt: "哪种方法更适合观察校园能耗？", options: ["甲：记录数据", "乙：凭印象判断"], group: { id: "observation", title: "观察与证据", instruction: "根据课堂中的节能情境作答。" } },
  { id: "q2", type: "multiple-choice", prompt: "哪些记录可以帮助比较？", options: ["用电量", "使用时段", "墙面颜色"], group: { id: "observation", title: "观察与证据", instruction: "根据课堂中的节能情境作答。" } },
  { id: "q3", type: "true-false", prompt: "比较前需要统一记录口径。" },
  { id: "q4", type: "scale", prompt: "你有多大信心解释观察结果？", scale: { min: 1, max: 5, minLabel: "没有信心", maxLabel: "很有信心" } },
  { id: "q5", type: "short-answer", prompt: "请写下你的主要发现。" },
  { id: "q6", type: "short-answer", prompt: "下一步你会怎样验证方案？" },
];

function course(): Course {
  return {
    id: courseId, version: 1, name: "校园节能项目", subject: "科学", grade: "七年级", hours: 1,
    summary: "", drivingQuestion: "如何节约校园能源？", status: "teaching",
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 4,
    students: [{ id: studentId, name: "测试学生", joinedAt: fixedTime, stageProgress: {} }],
    resources: [], groups: [], platformContext: { offeringId: "offering", activityId: "activity", templateId: "template", templateVersionId: "version" },
    experimentPosttestSummary: { enabled: true, openedAt: fixedTime, notStartedCount: 0, inProgressCount: 1, submittedCount: 0, studentRows: [{ studentId, status: "in-progress" }] },
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
}

async function mockClassroom(page: Page, role: "student" | "teacher", assessmentPhase?: "pretest" | "posttest", assessmentQuestions: ExperimentQuestion[] = questions) {
  const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Posttest browser acceptance requires the local JWT secret");
  const token = await new SignJWT(role === "teacher"
    ? { role, sv: 1, username: "e2e-posttest", displayName: "测试教师" }
    : { role, sv: 1, userId: studentId, studentName: "测试学生" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(role === "student" ? studentId : "e2e-posttest-teacher")
    .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: role === "student" ? "openpbl_student" : "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);

  const state = course();
  if (role === "student" && !assessmentPhase) state.platformContext = undefined;
  let draft = { answers: {} as Record<string, string | string[]>, currentPage: 0, version: 0, updatedAt: fixedTime };
  let submission: { id: string; answers: typeof draft.answers; submittedAt: string } | null = null;
  await page.routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
      if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/me") return json({ user: { id: role === "student" ? studentId : "e2e-posttest-teacher", role, name: role === "student" ? "测试学生" : "测试教师", displayName: role === "student" ? "测试学生" : "测试教师" } });
    if (path === "/api/courses") return json({ courses: [state], user: { role, name: "测试用户" }, studentId, studentName: "测试学生", hydrated: true, updatedAt: fixedTime });
    if (path === `/api/courses/${courseId}/state`) return json({ course: state, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
    if (path === `/api/courses/${courseId}/actions`) return json({ ok: true, requestId: route.request().postDataJSON()?.requestId, courseVersion: state.version, updatedAt: state.updatedAt });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
    if (path === "/api/platform/activities/activity") return json({ activity: {
      id: "activity", type: "Classroom", title: "校园节能项目", description: null, isOpen: true,
      offering: { id: "offering", name: "科学课", status: "open" }, chapter: { title: "校园观察" },
      progress: { status: "in_progress" },
      instance: { id: courseId, status: "teaching", startedAt: fixedTime, endedAt: null, canWrite: true, posttestAvailable: true,
        pretestSubmitted: assessmentPhase === "pretest" ? Boolean(submission) : true,
        posttestSubmitted: assessmentPhase === "posttest" ? Boolean(submission) : false,
        experiment: { enabled: true, pretest: assessmentQuestions, posttest: assessmentQuestions } },
    } });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ enabled: true, status: "teaching", enrollmentCount: 1, pretestCount: 1, posttestCount: 0, posttestDraftCount: 1, posttestOpenedAt: fixedTime, studentRows: [{ student: { id: studentId, displayName: "测试学生" }, status: "in-progress" }], variantCounts: { aPreBPost: 0, bPreAPost: 0 }, submissions: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment`) {
      if (method === "GET") return json({ enabled: true, available: true, studentKey: studentId, questions: assessmentQuestions, draft: draft.version ? draft : null, submission });
      if (method === "PUT") {
        const input = route.request().postDataJSON() as { answers: typeof draft.answers; currentPage: number; version: number };
        if (input.version !== draft.version) return json({ message: "版本冲突" }, 409);
        draft = { answers: input.answers, currentPage: input.currentPage, version: draft.version + 1, updatedAt: fixedTime };
        return json({ draft });
      }
      if (method === "POST") {
        const input = route.request().postDataJSON() as { answers: typeof draft.answers };
        submission = { id: "submitted", answers: input.answers, submittedAt: fixedTime };
        return json({ submission });
      }
    }
    return json({ message: `Missing fixture: ${path}` }, 404);
  });
  return baseURL;
}

const templateViewports = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1366, height: 768 },
  { width: 768, height: 576 },
];

for (const viewport of templateViewports) {
  test(`teacher applies and saves the CoTeach template at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "teacher");
    let config: { customSetting: string; experiment?: ExperimentConfig } = { customSetting: "preserved" };
    let savedVersion: number | null = null;
    await page.route("**/api/platform/offerings", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ offerings: [{ id: "offering", name: "模板验收教学班", chapters: [{ id: "chapter", title: "教学理论", activities: [{ id: "activity", title: "模板验收课堂", type: "Classroom", version: 1, config }] }] }] }) }));
    await page.route("**/api/platform/activities/activity/manage", (route) => {
      const input = route.request().postDataJSON();
      config = input.config;
      savedVersion = input.version;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ activity: { id: "activity", version: 2 } }) });
    });
    await page.goto(`${baseURL}/teacher/classes/offering/activities/activity/experiment`);
    const template = page.getByRole("region", { name: "前后测模板", exact: true });
    const description = await template.getByText("前测 9 道知识题；后测 9 道知识题、34 道 CoI 和 10 道系统使用体验题。", { exact: true }).boundingBox();
    expect(description && description.width > 200).toBe(true);
    await page.getByRole("button", { name: "一键应用前后测模板" }).click();
    await expect(page.getByRole("tab", { name: "共用题 9" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "后测专属 44" })).toBeVisible();
    await page.getByRole("tab", { name: "学生视角预览" }).click();
    await page.getByRole("tab", { name: "后测", exact: true }).click();
    const preview = page.getByLabel("后测题目预览");
    await expect(preview.locator("fieldset")).toHaveCount(53);
    for (const note of [COTEACH_TEACHER_REFERENCE, COTEACH_COMMUNITY_REFERENCE, COTEACH_SYSTEM_REFERENCE]) {
      await expect(preview.getByText(note, { exact: true })).toBeVisible();
    }
    await preview.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`template-preview-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach("template-community-reference", { path: screenshot, contentType: "image/png" });
    await page.getByRole("button", { name: "保存实验配置" }).first().click();
    await expect(page.getByText("实验配置已保存到本课堂", { exact: true })).toBeVisible();
    expect(savedVersion).toBe(1);
    expect(config.customSetting).toBe("preserved");
    expect(config.experiment?.sharedQuestions).toHaveLength(9);
    expect(config.experiment?.posttest).toHaveLength(44);
    expect(config.experiment?.posttest[13].group?.referenceNote).toBe(COTEACH_COMMUNITY_REFERENCE);
  });

  test(`student sees the CoTeach reference on each social page at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "student", "posttest", form);
    await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/posttest`);
    await expect(page.getByText(/^K01　/)).toBeVisible();
    if (viewport.width < 1024) await page.getByRole("button", { name: /答题目录/ }).click();
    await page.getByRole("button", { name: "课程学习体验问卷（CoI）· 社会性存在（第14—22题）" }).first().click();
    for (const number of [14, 18, 22]) {
      await expect(page.getByText(new RegExp(`^CoI${number}　`))).toBeVisible();
      const note = page.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true });
      await expect(note).toBeVisible();
      await expect(page.getByText("指代说明 · 请先阅读", { exact: true })).toBeVisible();
      if (number < 22) await page.getByRole("button", { name: "下一步", exact: true }).click();
    }
    const noteBox = page.getByText(COTEACH_COMMUNITY_REFERENCE, { exact: true }).locator("..").locator("..");
    await noteBox.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
    const [noteBounds, footerBounds] = await Promise.all([
      noteBox.boundingBox(),
      page.getByRole("contentinfo", { name: "后测操作栏", exact: true }).boundingBox(),
    ]);
    expect(noteBounds && footerBounds && noteBounds.y >= -1 && noteBounds.y + noteBounds.height <= footerBounds.y).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`template-student-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach("student-community-reference", { path: screenshot, contentType: "image/png" });
    if (viewport.width === 1366) {
      await page.getByRole("button", { name: "知识测验（共9题）", exact: true }).first().click();
      for (let index = 0; index < form.length; index++) {
        const unknown = page.getByRole("radio", { name: "不知道", exact: true });
        const choices = await unknown.count() ? unknown : page.getByRole("radio", { name: "4 分", exact: true });
        for (const choice of await choices.all()) await choice.locator("..").click();
        const next = page.getByRole("button", { name: "下一步", exact: true });
        if (!await next.count()) break;
        await next.click();
      }
      await page.getByRole("button", { name: "检查并提交", exact: true }).click();
      await expect(page.getByText("所有题目已完成", { exact: true })).toBeVisible();
      const request = page.waitForRequest((candidate) => new URL(candidate.url()).pathname.endsWith("/experiment") && candidate.method() === "POST");
      await page.getByRole("button", { name: "确认提交后测", exact: true }).click();
      expect(Object.keys((await request).postDataJSON().answers)).toHaveLength(53);
      await expect(page.getByText("后测已提交，答案已保存到本次课堂记录。", { exact: true })).toBeVisible();
    }
  });
}

for (const { phase, viewport, short } of [
  { phase: "pretest" as const, viewport: { width: 390, height: 568 }, short: false },
  { phase: "posttest" as const, viewport: { width: 1024, height: 576 }, short: true },
]) {
  test(`standalone ${phase} keeps actions fixed and returns to the activity`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const activeQuestions = short ? questions.slice(0, 1) : questions;
    const baseURL = await mockClassroom(page, "student", phase, activeQuestions);
    await page.goto(`${baseURL}/student/activities/activity/assessments/${courseId}/${phase}`);
    const footer = page.getByRole("contentinfo", { name: `${phase === "pretest" ? "前测" : "后测"}操作栏` });
    await expect(footer).toBeVisible();
    const before = await footer.boundingBox();
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    const after = await footer.boundingBox();
    expect(before && after && Math.abs(before.y - after.y) < 2).toBe(true);
    expect(after && after.y + after.height <= viewport.height + 1).toBe(true);
    if (!short) {
      await page.getByRole("radio", { name: "甲：记录数据" }).locator("..").click();
      await page.getByRole("checkbox", { name: "用电量" }).locator("..").click();
      await page.getByRole("button", { name: /下一步/ }).click();
      await page.getByRole("radio", { name: "正确" }).locator("..").click();
      await page.getByRole("radio", { name: "3 分" }).locator("..").click();
      await page.getByRole("textbox", { name: "请写下你的主要发现。" }).fill("用电高峰集中在下午。");
      await page.getByRole("textbox", { name: "下一步你会怎样验证方案？" }).fill("对比下周同一时段的数据。");
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)).toBe(true);
      const lastQuestion = await page.getByRole("textbox", { name: "下一步你会怎样验证方案？" }).boundingBox();
      const currentFooter = await footer.boundingBox();
      expect(lastQuestion && currentFooter && lastQuestion.y + lastQuestion.height < currentFooter.y).toBe(true);
    } else {
      await page.getByRole("radio", { name: "甲：记录数据" }).locator("..").click();
    }
    await page.getByRole("button", { name: "检查并提交" }).click();
    await page.getByRole("button", { name: `确认提交${phase === "pretest" ? "前测" : "后测"}` }).click();
    await expect(page).toHaveURL(`${baseURL}/student/activities/activity`);
    if (phase === "pretest") await expect(page.getByRole("button", { name: "进入课堂" })).toBeVisible();
    else await expect(page.getByText("后测已提交，答案已保存到本次课堂记录。")).toBeVisible();
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1366, height: 768 }]) {
  test(`student posttest works at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "student");
    await page.goto(`${baseURL}/student/classroom/${courseId}`);
    await expect(page.getByRole("heading", { name: "后测", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "观察与证据" })).toBeVisible();
    const initialScreenshot = info.outputPath(`posttest-student-start-${viewport.width}.png`);
    await page.screenshot({ path: initialScreenshot, fullPage: true });
    await info.attach("student-posttest-start", { path: initialScreenshot, contentType: "image/png" });
    await page.getByRole("radio", { name: "甲：记录数据" }).locator("..").click();
    await page.getByRole("checkbox", { name: "用电量" }).locator("..").click();
    await page.getByRole("button", { name: /下一步/ }).click();
    await page.getByRole("radio", { name: "正确" }).locator("..").click();
    await page.getByRole("radio", { name: "3 分" }).locator("..").click();
    await page.getByRole("textbox", { name: "请写下你的主要发现。" }).fill("用电高峰集中在下午。");
    await page.getByRole("textbox", { name: "下一步你会怎样验证方案？" }).fill("对比下周同一时段的数据。");
    await page.getByRole("button", { name: /检查并提交/ }).click();
    await expect(page.getByText("所有题目已完成")).toBeVisible();
    await page.getByRole("button", { name: "确认提交后测" }).click();
    await expect(page.getByText("答案已锁定")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`posttest-student-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach("student-posttest", { path: screenshot, contentType: "image/png" });
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`teacher posttest shows status and roster at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const baseURL = await mockClassroom(page, "teacher");
    await page.goto(`${baseURL}/teacher/teach/${courseId}/classroom`);
    await expect(page.getByRole("heading", { name: "后测", exact: true })).toBeVisible();
    await expect(page.getByLabel("后测进度")).toContainText("作答中");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`posttest-teacher-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach("teacher-posttest", { path: screenshot, contentType: "image/png" });
  });
}

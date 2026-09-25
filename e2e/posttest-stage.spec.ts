import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

test.use({ serviceWorkers: "block" });

const courseId = "e2e-posttest-layout";
const studentId = "e2e-posttest-student";
const fixedTime = "2026-09-25T00:00:00.000Z";
const questions = [
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

async function mockClassroom(page: Page, role: "student" | "teacher") {
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
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ enabled: true, status: "teaching", enrollmentCount: 1, pretestCount: 1, posttestCount: 0, posttestDraftCount: 1, posttestOpenedAt: fixedTime, studentRows: [{ student: { id: studentId, displayName: "测试学生" }, status: "in-progress" }], variantCounts: { aPreBPost: 0, bPreAPost: 0 }, submissions: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment`) {
      if (method === "GET") return json({ enabled: true, available: true, studentKey: studentId, questions, draft: draft.version ? draft : null, submission });
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

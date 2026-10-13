import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import type { PublicDiscussionSnapshot } from "../src/lib/public-discussion/types";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("Teacher recovery fixtures require a local acceptance service.");
}
test.use({ baseURL, serviceWorkers: "block" });
const courseId = "teacher-recovery-fixture";
const at = "2026-10-13T00:00:00.000Z";

async function installClassroom(page: Page) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || "deploy/secrets/jwt_secret.txt", "utf8").trim();
  const token = await new SignJWT({ role: "teacher", sv: 1, username: "recovery-fixture", displayName: "课堂恢复验收" })
    .setProtectedHeader({ alg: "HS256" }).setSubject("recovery-teacher").setIssuer("openpbl").setAudience("openpbl-app")
    .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: "openpbl_teacher", value: token, url: baseURL }]);
  const course: Course = {
    id: courseId, version: 1, name: "教师课堂失败恢复", subject: "科学", grade: "六年级", hours: 1,
    summary: "", drivingQuestion: "怎样使用证据？", status: "teaching", currentStageIndex: 1,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), students: [], groups: [], resources: [],
    content: { pblOutline: "", knowledgePoints: [{ id: "point-1", name: "证据", description: "依据事实讨论" }], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: at, pausedAt: at, activeStageKey: "ai-learning", updatedAt: at,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 1 ? "active" : "pending" })),
    } }, createdAt: at, updatedAt: at,
  };
  const discussion: PublicDiscussionSnapshot = {
    enabled: true, teacher: { candidates: [], soundOwner: false },
    session: {
      id: "recovery-discussion", courseId, knowledgePointId: "point-1", topic: "观察证据", mode: "inquiry",
      openingPrompt: "你的结论有哪些证据？", status: "awaiting-student", version: 1, roundCount: 1,
      isCurrentStudent: false, shouldSuggestSummary: false, createdAt: at, updatedAt: at,
      turns: [{ id: "turn-1", sequence: 1, role: "assistant", source: "system", content: "请保留这条已经读取的讨论内容。", createdAt: at }],
    },
  };
  const fault = { discussion: false, finish: false };
  const errors: string[] = [], unexpected: string[] = [], finishRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.origin !== new URL(baseURL).origin) {
      unexpected.push(`External ${request.url()}`);
      return route.abort("blockedbyclient");
    }
    if (!path.startsWith("/api/")) {
      if (["GET", "HEAD"].includes(request.method())) return route.continue();
      unexpected.push(`${request.method()} ${path}`);
      return json({ message: "Fixture blocks non-API writes" }, 405);
    }
    // Every API request is resolved here, including all writes and unknown URLs.
    if (path === `/api/courses/${courseId}/actions` && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.action.type !== "END_TEACHING") {
        unexpected.push(`Action ${body.action.type}`);
        return json({ message: "Unknown fixture action" }, 400);
      }
      finishRequests.push(body.requestId);
      if (fault.finish) return json({ message: "模拟课堂保存失败，请重试" }, 503);
      course.status = "finished";
      course.version = (course.version ?? 0) + 1;
      return json({ ok: true, requestId: body.requestId, courseVersion: course.version, updatedAt: at });
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      unexpected.push(`${request.method()} ${path}`);
      return json({ message: "Fixture blocks unexpected mutation" }, 405);
    }
    if (path === "/api/auth/me") return json({ user: { id: "recovery-teacher", name: "课堂恢复验收", displayName: "课堂恢复验收", role: "teacher" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "课堂恢复验收" }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/public-discussion`) return json(fault.discussion ? { message: "讨论暂时无法读取" } : discussion, fault.discussion ? 503 : 200);
    if (path === `/api/courses/${courseId}/public-discussion/settings`) return json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
    if (path === `/api/platform/classroom-instances/${courseId}/participants`) return json({ instance: { id: courseId, title: course.name, offeringId: "fixture-offering", status: "finished", snapshot: null }, participants: [] });
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) return json({ message: "No experiment in fixture" }, 404);
    unexpected.push(`${request.method()} ${path}`);
    return json({ message: "Unknown fixture endpoint" }, 404);
  });
  return { fault, errors, unexpected, finishRequests, course };
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }]) {
  test(`discussion loading and refresh failures remain recoverable ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await installClassroom(page);
    fixture.fault.discussion = true;
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "AI 公开讨论", exact: true }).click();
    const workspace = page.getByRole("region", { name: "AI 公开讨论工作台" });
    await expect(workspace.getByRole("alert")).toContainText("讨论暂时无法读取");
    fixture.fault.discussion = false;
    await workspace.getByRole("button", { name: "重试加载讨论" }).click();
    await expect(workspace.getByLabel("公开讨论记录")).toContainText("请保留这条已经读取的讨论内容。");
    fixture.fault.discussion = true;
    await expect(workspace.getByRole("alert")).toContainText("已保留当前内容");
    await expect(workspace.getByLabel("公开讨论记录")).toContainText("请保留这条已经读取的讨论内容。");
    fixture.fault.discussion = false;
    await workspace.getByRole("button", { name: "重试加载讨论" }).click();
    await expect(workspace.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
    await info.attach("recovered-discussion", { body: await page.screenshot(), contentType: "image/png" });
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`finish failures are visible in the confirmation and retry the same request ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await installClassroom(page);
    fixture.fault.finish = true;
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    await page.getByRole("button", { name: "结束授课", exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "结束课堂", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("结束课堂未保存，请重试", { timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: "结束课堂", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page).toHaveURL(new RegExp(`/teacher/teach/${courseId}/classroom$`));
    expect(fixture.course.status).toBe("teaching");
    await info.attach("finish-save-error", { body: await page.screenshot(), contentType: "image/png" });
    fixture.fault.finish = false;
    await dialog.getByRole("button", { name: "结束课堂", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/teacher/classrooms/${courseId}$`));
    expect(fixture.course.status).toBe("finished");
    expect(fixture.finishRequests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fixture.finishRequests).size).toBe(1);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

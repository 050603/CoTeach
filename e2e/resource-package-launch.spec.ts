import { expect, test, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import { emptyResourcePackageDraft } from "../src/lib/resource-package/types";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
test.use({ baseURL });
const courseId = "e2e-package-launch", resourceId = "e2e-launch-pptx", date = "2026-09-12T00:00:00.000Z";

async function launchPdf() {
  if (process.env.OPENPBL_RESOURCE_LAUNCH_PDF) return readFileSync(process.env.OPENPBL_RESOURCE_LAUNCH_PDF);
  const pdf = await PDFDocument.create();
  for (let number = 1; number <= 10; number++) {
    const page = pdf.addPage([960, 540]);
    page.drawRectangle({ x: 24, y: 24, width: 912, height: 492, color: rgb(0.95, 0.97, 0.98), borderColor: rgb(0.2, 0.3, 0.4), borderWidth: 4 });
    page.drawText(`PROJECT LAUNCH / PAGE ${number}`, { x: 64, y: 420, size: 36 });
    page.drawRectangle({ x: 64, y: 96, width: number * 75, height: 180, color: rgb(0.2, 0.5, 0.5) });
  }
  return Buffer.from(await pdf.save());
}

async function mockLaunch(page: Page) {
  const pdf = await launchPdf();
  let course: Course = {
    id: courseId, version: 1, name: "资源包项目启动课件", subject: "人工智能教育", grade: "本科一年级", hours: 2.25,
    summary: "", drivingQuestion: "怎样设计适合学习者的人工智能课程？", status: "teaching", currentStageIndex: 0,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), students: [], groups: [],
    resources: [{ id: resourceId, title: "自动提取的项目启动 PPT", type: "PPTX", size: "2 MB", stageKey: "launch", url: `/api/uploads/${resourceId}`, previewUrl: `/api/uploads/${resourceId}?variant=classroom`, previewType: "PDF", displayMode: "slides", downloadedBy: [] }],
    content: {
      pblOutline: "", knowledgePoints: [], lessonOutline: [], teachingOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      resourcePackage: { schemaVersion: 1, id: "package-1", revision: 2, source: { id: "zip-1", fileName: "教学资源包.zip", url: "/api/uploads/zip-1" }, documents: {}, draft: emptyResourcePackageDraft(), launchResourceId: resourceId, confirmedAt: date },
    },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: date, pausedAt: date, activeStageKey: "launch", updatedAt: date,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: [900, 1800, 3600, 1200, 600][index], adjustmentSec: 0, elapsedSec: 0, status: index === 0 ? "active" : "pending" })),
    } }, createdAt: date, updatedAt: date,
  } as Course;
  const errors: string[] = [], unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim() : process.env.JWT_SECRET;
  if (secret && secret.length >= 32) {
    const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-launch", displayName: "启动课件验收" }).setProtectedHeader({ alg: "HS256" }).setSubject("e2e-launch-teacher").setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  await page.routeWebSocket((url) => !url.pathname.includes("_next"), (socket) => socket.onMessage((message) => {
    const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
    if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
  }));
  // All endpoint writes are applied only to this in-memory course; no database state changes.
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path === `/api/uploads/${resourceId}` && url.searchParams.get("variant") === "classroom") return route.fulfill({ status: 200, contentType: "application/pdf", body: pdf });
    if (path === "/api/auth/me") return json({ user: { id: "e2e-launch-teacher", role: "teacher", name: "启动课件验收", displayName: "启动课件验收" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "启动课件验收" }, hydrated: true, updatedAt: course.updatedAt });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: course.uiState?.resourceProjection ?? null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/actions`) {
      const body = request.postDataJSON();
      if (body.action.type === "SET_UI_STATE") course = { ...course, uiState: { ...course.uiState, ...body.action.payload.patch }, version: (course.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      else unexpected.push(body.action.type);
      return json({ ok: true, requestId: body.requestId, courseVersion: course.version, updatedAt: course.updatedAt });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "No fixture" }) });
  });
  await page.goto(`/teacher/teach/${courseId}/classroom`, { waitUntil: "domcontentloaded" });
  // A development-only Next indicator can cover the production toolbar in small viewports.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  return { course: () => course, errors, unexpected };
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1920, height: 1080 }]) {
  test(`package launch preview, ten pages and projection ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const fixture = await mockLaunch(page);
    await expect(page.locator('canvas[aria-label="PPT 第 1 页"]').filter({ visible: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("建议改传PDF", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "原始PPT", exact: true })).toHaveAttribute("href", `/api/uploads/${resourceId}`);
    await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
    const stageActions = page.getByLabel("当前阶段常用操作");
    await stageActions.getByRole("button", { name: "同步到学生", exact: true }).click();
    await expect.poll(() => fixture.course().uiState?.resourceProjection?.resourceId).toBe(resourceId);
    const hashes = new Set<string>();
    for (let number = 1; number <= 10; number++) {
      const next = page.getByRole("button", { name: "下一页", exact: true }).filter({ visible: true });
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("spinbutton", { name: "跳转页码", exact: true })).toBeInViewport({ ratio: 1 });
      if (number > 1) await next.click();
      await expect(page.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue(String(number));
      const canvas = page.locator(`canvas[aria-label="PPT 第 ${number} 页"]`).filter({ visible: true });
      await expect(canvas).toBeVisible();
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
        const pixels = node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data;
        if (!pixels) return 0;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 64) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) count++;
        return count;
      })).toBeGreaterThan(100);
      await expect(canvas).toBeInViewport({ ratio: 1 });
      await expect.poll(() => fixture.course().uiState?.resourceProjection?.viewState?.page).toBe(number);
      hashes.add(createHash("sha256").update(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).digest("hex"));
      const picture = info.outputPath(`launch-page-${number}.png`);
      await canvas.screenshot({ path: picture });
      await info.attach(`launch-page-${number}`, { path: picture, contentType: "image/png" });
    }
    expect(hashes.size).toBe(10);
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    await page.getByRole("button", { name: "授课展示", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue("10");
    await stageActions.getByRole("button", { name: "停止同步", exact: true }).click();
    await expect.poll(() => fixture.course().uiState?.resourceProjection).toBeNull();
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

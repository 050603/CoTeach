import { expect, test } from "@playwright/test";
import { SignJWT } from "jose";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

test.use({ serviceWorkers: "block" });
const courseId = "e2e-showcase-layout";
const studentId = "e2e-showcase-student";
const fixedTime = "2026-09-25T00:00:00.000Z";

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`student material workspace fits ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
    const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
      ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
      : process.env.JWT_SECRET;
    if (secret && secret.length >= 32) {
      const token = await new SignJWT({ role: "student", sv: 1, userId: studentId, studentName: "测试学生" })
        .setProtectedHeader({ alg: "HS256" }).setSubject(studentId).setIssuer("openpbl")
        .setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret));
      await page.context().addCookies([{ name: "openpbl_student", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    }

    const course: Course = {
      id: courseId, version: 1, name: "校园节能项目", subject: "科学", grade: "七年级", hours: 1,
      summary: "", drivingQuestion: "如何节约校园能源？", status: "teaching",
      stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 3,
      students: [{ id: studentId, name: "测试学生", joinedAt: fixedTime, stageProgress: {} }],
      resources: [], groups: [],
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
      createdAt: fixedTime, updatedAt: fixedTime,
    } as Course;
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 2; index++) {
      const portrait = index === 1;
      const sheet = pdf.addPage(portrait ? [595, 842] : [960, 540]);
      sheet.drawText(`SHOWCASE PAGE ${index + 1}`, { x: 64, y: portrait ? 750 : 440, size: 30 });
      sheet.drawRectangle({ x: 64, y: portrait ? 625 : 315, width: portrait ? 465 : 820, height: 100, borderWidth: 1 });
      sheet.drawLine({ start: { x: 64, y: portrait ? 675 : 365 }, end: { x: portrait ? 529 : 884, y: portrait ? 675 : 365 } });
    }
    const pdfBytes = Buffer.from(await pdf.save());
    const pdfArtifact = { kind: "pdf", versionId: "showcase-pdf", title: "校园能源观察成果与改进建议演示稿.pdf", sequence: 1, submittedAt: fixedTime, displayModes: ["continuous", "slides"], mimeType: "application/pdf" };
    const documentArtifact = { kind: "document", versionId: "showcase-document", title: "校园节能成果报告.docx", sequence: 2, submittedAt: fixedTime, displayModes: ["continuous"], mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    const otherArtifact = { kind: "file", versionId: "showcase-code", title: "数据分析代码.zip", sequence: 3, submittedAt: fixedTime, displayModes: ["continuous"], downloadUrl: "/api/showcase-code", mimeType: "application/zip" };
    const artifacts = [pdfArtifact, documentArtifact, otherArtifact];
    const queueItem = { studentId, studentName: "测试学生", groupId: "group-1", position: 1, status: "called", artifacts, primaryArtifactTitle: pdfArtifact.title };
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
      socket.onMessage((message) => {
        const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
        if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
      });
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
      if (path === `/api/courses/${courseId}/showcase/artifacts/showcase-pdf`) return route.fulfill({ status: 200, contentType: "application/pdf", body: pdfBytes });
      if (path === `/api/courses/${courseId}/showcase/artifacts/showcase-document`) return json({ html: "<h1>项目成果页眉</h1><p>校园用能记录</p><table><tbody><tr><th>区域</th><th>节能量</th></tr><tr><td>教室</td><td>20%</td></tr></tbody></table>" });
      if (path === "/api/auth/me") return json({ user: { id: studentId, role: "student", name: "测试学生", displayName: "测试学生" } });
      if (path === "/api/courses") return json({ courses: [course], user: { role: "student", name: "测试学生" }, studentId, studentName: "测试学生", joinedCourseId: courseId, hydrated: true, updatedAt: fixedTime });
      if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
      if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
      if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
      if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
      if (path === `/api/courses/${courseId}/showcase/presentation`) return json({ courseId, stageKey: "showcase", students: [{ studentId, name: "测试学生", groupId: "group-1", isAssigned: true, artifacts }], ownArtifacts: artifacts, activePresentation: null, presentations: [], queue: [queueItem], minutesPerStudent: 5, currentQueueItem: queueItem, nextQueueItem: null });
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "No fixture" }) });
    });
    await page.goto(`${baseURL}/student/classroom/${courseId}`);
    await expect(page.getByRole("heading", { name: "成果汇报", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择主汇报资料" })).toBeVisible();
    await page.getByRole("button", { name: "逐页演示" }).click();
    const preview = page.getByTestId("large-artifact-preview");
    const canvas = page.locator('canvas[aria-label="PDF 第 1 页"]');
    await expect(canvas).toBeVisible();
    await expect(canvas).toBeInViewport({ ratio: 1 });
    const pdfShot = testInfo.outputPath(`student-showcase-pdf-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: pdfShot, fullPage: true });
    await testInfo.attach("student-showcase-pdf", { path: pdfShot, contentType: "image/png" });
    const geometry = await preview.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    if (viewport.width > 700) {
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 2);
      expect(geometry.height).toBeGreaterThanOrEqual((geometry.viewportHeight - geometry.top + 45) * .7);
    }
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.locator('canvas[aria-label="PDF 第 2 页"]')).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "选择主汇报资料" }).click();
    await page.getByRole("option", { name: /校园节能成果报告/ }).click();
    const documentPreview = page.locator('[aria-label="最终文档预览"]');
    await expect(documentPreview.getByText("项目成果页眉")).toBeVisible();
    await expect(documentPreview.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "选择主汇报资料" }).click();
    await page.getByRole("searchbox", { name: "搜索材料" }).fill("代码");
    await page.getByRole("option", { name: /数据分析代码/ }).click();
    await expect(preview).toContainText("此格式供教师下载查看");
    await page.getByRole("button", { name: "选择主汇报资料" }).click();
    await page.getByRole("option", { name: /校园能源观察成果/ }).click();
    await page.getByRole("button", { name: "逐页演示" }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    const sidebar = page.getByTestId("student-showcase-sidebar");
    await expect(sidebar.getByRole("heading", { name: "汇报顺序 · 1 人" })).toBeVisible();
    await expect(sidebar.getByText("测试学生 · 我")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "汇报队列与流程" })).toHaveCount(0);
    const queueLayout = await sidebar.evaluate((node) => {
      const rail = node.getBoundingClientRect();
      const preview = document.querySelector('[data-testid="large-artifact-preview"]')?.getBoundingClientRect();
      const workspace = node.parentElement?.getBoundingClientRect();
      return { railLeft: rail.left, railTop: rail.top, previewRight: preview?.right ?? 0, previewBottom: preview?.bottom ?? 0, workspaceWidth: workspace?.width ?? 0 };
    });
    if (queueLayout.workspaceWidth >= 1100) expect(queueLayout.railLeft).toBeGreaterThan(queueLayout.previewRight);
    else expect(queueLayout.railTop).toBeGreaterThanOrEqual(queueLayout.previewBottom);
    const shot = testInfo.outputPath(`student-showcase-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach("student-showcase", { path: shot, contentType: "image/png" });
    expect(errors).toEqual([]);
  });
}

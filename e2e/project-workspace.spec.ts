import { expect, test, type Locator } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

test.use({ serviceWorkers: "block" });

const courseId = "e2e-project-workspace";
const studentId = "e2e-project-student";
const now = "2026-10-15T00:00:00.000Z";
const topic = "结合校园中不同区域的能源使用情况，设计一份有证据支持的节能改进方案。".repeat(12) + "必须说明方案适用的条件与限制。";
const task = "记录观察地点、日期、用能量与观察时长，比较差异后提出建议。".repeat(15) + "保留全部原始记录。";
const outputs = "提交观察记录表、改进建议和效果评估说明；标注数据来源。";
const policy = "AI 可辅助整理数据，所有结论必须由学生核对。";
const cases = [
  ...[{ width: 1366, height: 768 }, { width: 1024, height: 576 }, { width: 768, height: 1024 },
    { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 },
    { width: 320, height: 568 }].map((viewport) => ({ mode: "document" as const, viewport })),
  ...(["other", "python"] as const).flatMap((mode) =>
    [{ width: 1366, height: 768 }, { width: 390, height: 844 }].map((viewport) => ({ mode, viewport }))),
];

async function expectDialogFits(dialog: Locator) {
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: window.innerWidth, height: window.innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
}

for (const { mode, viewport } of cases) {
  test(`${mode} project details and local submission at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
    const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
      ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
      : process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error("A local test JWT signing secret is required.");
    const token = await new SignJWT({ role: "student", sv: 1, userId: studentId, studentName: "测试学生" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(studentId).setIssuer("openpbl")
      .setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_student", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
    const course = {
      id: courseId, version: 1, name: "校园节能项目", subject: "科学", grade: "初中", hours: 1,
      summary: "", drivingQuestion: topic, status: "teaching", currentStageIndex: 2,
      stages: DEFAULT_STAGES.map((stage) => ({ ...stage })),
      students: [{ id: studentId, name: "测试学生", joinedAt: now, stageProgress: {} }],
      groups: [], resources: [], submissions: [], activityLog: [], uiState: {},
      pblConfig: { generationTemplate: "new-ai-learning-only", makeArtifactMode: mode },
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
        stagePlan: { schemaVersion: 2, source: "resource-package", drivingQuestion: topic,
          projectTask: "比较校园用能情况并提出节能方案。", totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
          stages: [{ key: "make", title: "项目实践", durationMin: 25, requirements: task, outputs,
            teacherActions: "仅供教师的指导信息", aiActions: "帮助检查数据是否完整。", checkpoints: ["核对观察记录", "完成建议"] }],
          evaluationCriteria: "证据完整、建议可行、清楚说明限制。", reflectionQuestions: [], aiUsagePolicy: policy,
          finalDeliverables: [{ id: "report", name: "节能方案", format: "PDF", required: true, requirements: "附上原始记录表。" }],
        } },
      projectPdfVersions: mode === "other" ? [{ id: "previous-version", courseId, studentId, stageKey: "make", sequence: 1,
        title: "已有成果.pdf", uploadId: "previous-upload", kind: "pdf", status: "submitted", createdAt: now, submittedAt: now }] : [],
      createdAt: now, updatedAt: now,
    } as Course;
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    let uploadCount = 0;
    let finishUpload: (() => void) | undefined;
    let saveBehavior: "normal" | "hold" | "fail" = "normal";
    let finishSave: (() => void) | undefined;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).pathname.startsWith("/_next/")) { socket.connectToServer(); return; }
      socket.onMessage((message) => {
        const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
        if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
      });
    });
    // All business traffic stays in the browser fixture; no real submissions or AI calls.
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path.startsWith("/api/openmaic/interactive-runtime/") && route.request().method() === "GET") return route.continue();
      if (path === "/api/auth/me") return json({ user: { id: studentId, role: "student", name: "测试学生" } });
      if (path === "/api/courses") return json({ courses: [course], user: { role: "student", name: "测试学生" }, studentId, studentName: "测试学生", joinedCourseId: courseId, hydrated: true });
      if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
      if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
      if (path === `/api/courses/${courseId}/presence`) return json({ members: [] });
      if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: null, teacherResourceProjection: null });
      if (path === `/api/courses/${courseId}/public-discussion`) return json({ enabled: false, session: null });
      if (path === `/api/courses/${courseId}/actions`) {
        const body = route.request().postDataJSON();
        const submission = body.action?.payload?.submission;
        if (submission && saveBehavior === "hold") await new Promise<void>((resolve) => { finishSave = resolve; });
        if (submission && saveBehavior === "fail") return json({ message: "测试保存失败，草稿仍保留。" }, 503);
        if (submission) course.submissions = [...(course.submissions ?? []).filter((item) => item.id !== submission.id), submission];
        course.version = (course.version ?? 0) + 1;
        return json({ ok: true, requestId: body.requestId, courseVersion: course.version, submissionVersion: 1, updatedAt: now });
      }
      if (["/api/ai-collaboration/document", "/api/ai-collaboration/code"].includes(path)) return json({ messages: [], commentThreads: [], starters: [], conversations: [], requests: [], proactiveReviewEnabled: false });
      if (path === "/api/ai-collaboration/memory") return json({ memories: [], continuation: null });
      if (["/api/ai-collaboration/events", "/api/learning-events", `/api/courses/${courseId}/learning-events`].includes(path)) return json({ success: true });
      if (["/api/openmaic/server-providers", "/api/openmaic/provider-config", "/api/server-providers"].includes(path)) return json({ providers: [], models: [], success: true });
      if (path === `/api/courses/${courseId}/showcase/artifacts/pdf` && route.request().method() === "POST") {
        uploadCount++;
        if (uploadCount === 1) return json({ message: "测试上传失败，请重试。" }, 503);
        await new Promise<void>((resolve) => { finishUpload = resolve; });
        return json({ versionId: "new-version", uploadId: "new-upload", sequence: 2, submittedAt: now, kind: "file" });
      }
      unexpectedRequests.push(`${route.request().method()} ${path}`);
      return json({ message: "No browser fixture" }, 404);
    });
    await page.goto(`${baseURL}/student/ai-collaboration/${courseId}`);
    const detailsTrigger = page.getByRole("button", { name: "查看完整选题方向与要求", exact: true });
    await expect(detailsTrigger).toBeVisible({ timeout: 30_000 }).catch(async (error) => {
      await testInfo.attach("browser-diagnostics", { contentType: "application/json", body: JSON.stringify({ errors, unexpectedRequests }) });
      throw error;
    });
    if (mode === "python") await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
    const saveStatus = page.locator('[data-slot="save-status"]');
    await expect(saveStatus).toHaveCount(1);
    await expect(saveStatus).toBeVisible();
    expect(await saveStatus.evaluate((element) => element.closest("header")!.classList.contains("fixed"))).toBe(true);
    const leaveBounds = await page.getByRole("button", { name: "离开", exact: true }).boundingBox();
    const saveBounds = await saveStatus.boundingBox();
    expect(leaveBounds!.x + leaveBounds!.width).toBeLessThanOrEqual(saveBounds!.x + 1);
    await expect(page.getByText("服务器已保存", { exact: true })).toHaveCount(0);
    await expect(page.getByText("已就绪", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await detailsTrigger.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "选题方向与要求", exact: true });
    await expect(details.getByText(topic, { exact: true })).toHaveText(topic);
    await expect(details.getByText(task, { exact: true })).toHaveText(task);
    await expect(details.getByText(outputs, { exact: true })).toBeAttached();
    await expect(details.getByText("附上原始记录表。", { exact: false })).toBeAttached();
    await expect(details.getByText("仅供教师的指导信息")).toHaveCount(0);
    await expectDialogFits(details);
    const lastRequirement = details.getByText(policy, { exact: true });
    await lastRequirement.scrollIntoViewIfNeeded();
    await expect(lastRequirement).toBeInViewport({ ratio: 1 });
    await expect(details.getByRole("button", { name: "关闭对话框" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("requirements.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(detailsTrigger).toBeFocused();

    if (mode !== "python") {
      const editor = page.locator('[contenteditable="true"]').first();
      await expect(editor).toBeVisible();
      const originalDocument = await editor.innerText();
      const uploadLabel = mode === "other" ? "提交本地成果" : "提交其他成果";
      const uploadTrigger = page.getByRole("button", { name: uploadLabel, exact: true });
      await expect(uploadTrigger).toHaveCount(1);
      expect(await uploadTrigger.evaluate((element) => Boolean(element.closest("header")))).toBe(true);
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      await uploadTrigger.click();
      const upload = page.getByRole("dialog", { name: uploadLabel, exact: true });
      await expectDialogFits(upload);
      await expect(upload.getByText(/100 MiB/)).toBeVisible();
      if (mode === "other") await expect(upload.getByText("第 1 版 · 已有成果.pdf")).toBeVisible();

      // Exercise error/retry and a modal close during upload in both document variants.
      if (viewport.width === 1366) {
        const file = { name: "成果.txt", mimeType: "text/plain", buffer: Buffer.from("校园节能建议") };
        await upload.locator('input[type="file"]').setInputFiles(file);
        await expect(upload.getByRole("alert")).toContainText("测试上传失败，请重试。");
        await upload.locator('input[type="file"]').setInputFiles(file);
        await expect.poll(() => uploadCount).toBe(2);
        await upload.getByRole("button", { name: "关闭对话框" }).click();
        finishUpload?.();
        await uploadTrigger.click();
        await expect(upload.getByRole("status")).toContainText(mode === "other" ? "本地成果已保存为第 2 个版本" : "项目材料已上传为第 2 份");
        if (mode === "other") await expect(upload.getByText("第 2 版 · 成果.txt")).toBeVisible();
        expect(uploadCount).toBe(2);
      }
      await page.screenshot({ path: testInfo.outputPath("upload.png") });
      await upload.getByRole("button", { name: "关闭对话框" }).click();
      await expect(uploadTrigger).toBeFocused();
      await expect(editor).toHaveText(originalDocument, { useInnerText: true });
      await page.evaluate(() => window.scrollTo(0, 300));
      const toolbar = page.locator('.pbl-document-editor [role="toolbar"]').first();
      await expect.poll(async () => {
        const toolbarTop = (await toolbar.boundingBox())?.y ?? 0;
        const headerBottom = await uploadTrigger.evaluate((element) => element.closest("header")!.getBoundingClientRect().bottom);
        return toolbarTop >= headerBottom;
      }).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));

      if (mode === "document" && [1366, 390, 320].includes(viewport.width)) {
        saveBehavior = "hold";
        await editor.fill("保存状态应当跟随当前文档。");
        await expect(saveStatus).toContainText("未保存");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(saveStatus).toContainText("保存中");
        await expect.poll(() => Boolean(finishSave)).toBe(true);
        saveBehavior = "normal";
        finishSave?.();
        await expect(saveStatus).toContainText("已保存");

        saveBehavior = "fail";
        await editor.fill("保存失败后，也要保留最新文档并允许重试。");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(saveStatus).toContainText("保存失败", { timeout: 20_000 });
        const leaveErrorBounds = await page.getByRole("button", { name: "离开", exact: true }).boundingBox();
        const saveErrorBounds = await saveStatus.boundingBox();
        expect(leaveErrorBounds!.x + leaveErrorBounds!.width).toBeLessThanOrEqual(saveErrorBounds!.x + 1);
        await page.screenshot({ path: testInfo.outputPath("save-error.png") });
        saveBehavior = "normal";
        const retryButton = viewport.width < 640
          ? page.getByRole("button", { name: "保存", exact: true })
          : saveStatus.getByRole("button", { name: "重试", exact: true });
        await retryButton.click();
        await expect(saveStatus).toContainText("已保存");
        await expect(editor).toContainText("保存失败后，也要保留最新文档并允许重试。");
      }
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace.png") });
    expect(unexpectedRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { emptyResourcePackageDraft, type CourseResourcePackage, type ResourcePackageDraft, type ResourcePackageJobSnapshot } from "../src/lib/resource-package/types";

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
test.use({ baseURL });
const courseId = "e2e-resource-package";
const uploadId = "ab010000-1111-4111-8111-111111111111";
const fixedTime = "2026-09-12T00:00:00.000Z";

function courseFixture(): Course {
  return {
    id: courseId, version: 1, name: "待确认的教学资源包课堂", subject: "人工智能", grade: "本科一年级", hours: 3,
    summary: "", drivingQuestion: "", status: "draft", stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0,
    students: [], resources: [], groups: [], inviteCode: "E2EPKG", createdAt: fixedTime, updatedAt: fixedTime,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], teachingOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  } as Course;
}

function packageFixture(): CourseResourcePackage {
  const draft = emptyResourcePackageDraft();
  return {
    schemaVersion: 2, id: "resource-package-1", revision: 1,
    source: { id: uploadId, fileName: "中小学人工智能教育的教学理论与方法-完整资源包.zip", url: `/api/uploads/${uploadId}` }, documents: {},
    draft: {
      ...draft, parsingVersion: 2, courseName: "中小学人工智能教育的教学理论与方法", subject: "人工智能教育", grade: "本科一年级", drivingQuestion: "",
      learningObjectives: ["比较不同学习理论及其教学适用条件", "以学习证据评价人工智能教学活动"],
      expectedOutcome: "一份面向中小学生的人工智能课程教案，以及说明设计依据的个人汇报。",
      lessonCount: 3, minutesPerLesson: 45, totalMinutes: 135,
      knowledgePoints: ["学习理论", "教学目标", "教学方法", "教学活动", "学习评价", "人工智能教学实践"].map((name) => ({ name, description: `${name}的核心概念、适用边界与教学案例`, subPoints: ["基本概念", "案例分析"] })),
      stages: draft.stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index], requirements: "依据学习理论设计活动，以学生可观察的学习证据检验设计。", outputs: index === 2 ? "提交个人教案与设计依据" : "记录自己的学习证据", teacherActions: "提供必要的反馈", aiActions: "支持比较方案，核心判断由学生完成" })),
      evaluationCriteria: "目标与学习活动一致，教学理论运用正确，评价依据可核查。",
      reflectionQuestions: ["哪次修改让你的活动更适合学习者？", "你怎样验证 AI 伙伴建议的可靠性？"],
      finalDeliverables: [{ id: 'final', name: '个人终稿', format: 'document', requirements: '完整教案及10页PPT，标注图片来源', required: true }],
      reflectionQuestionSet: { id: 'questions', version: 1, questions: [{ id: 'reflection-1', prompt: '哪次修改让你的活动更适合学习者？', required: true }] },
      evaluationRubric: { id: 'rubric', version: 1, sourceWeights: { teacher: 60, ai: 40 }, dimensions: [{ id: 'theory', name: '理论适切性', description: '理论能够支持教学目标', weight: 30 }, { id: 'activity', name: '活动可行性', description: '活动具体可操作', weight: 40 }, { id: 'presentation', name: '呈现质量', description: '结构清楚、视觉规范', weight: 20 }, { id: 'collaboration', name: 'AI协作', description: '保留学生主体判断', weight: 10 }] },
    },
  };
}

async function mockGeneration(page: Page, withConflicts = false) {
  const course = courseFixture();
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const observedRequests: string[] = [];
  const writes: Array<{ path: string; body: unknown }> = [];
  let pack = packageFixture();
  if (withConflicts) pack = { ...pack, conflictVersion: 'issues-v1', conflicts: [{ id: 'real-groups', kind: 'organization', summary: '教案要求真人分组', reason: '本课堂采用个人与 AI 伙伴协作', suggestion: '全员提交个人作品，教师选择现场汇报学生', evidence: [{ documentRole: 'lessonPlan', locator: '第5段', quote: '建议每组约5人' }] }] };
  let packageJob: ResourcePackageJobSnapshot | null = null;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (secret && secret.length >= 32) {
    const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-package", displayName: "资源包验收教师" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("e2e-package-teacher").setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  await page.routeWebSocket((url) => !url.pathname.includes("_next"), (socket) => {
    socket.onMessage((message) => {
      try {
        const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
        if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
      } catch { /* Ignore dev HMR sockets and keep all sockets isolated. */ }
    });
  });
  // Every application endpoint is intercepted: this suite cannot write to the database.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    observedRequests.push(`${request.method()} ${path}`);
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/uploads") {
      expect(request.method()).toBe("POST");
      const multipart = request.postDataBuffer()?.toString("utf8") || "";
      expect(multipart).toContain('name="purpose"\r\n\r\ncourse-resource-package');
      expect(multipart).toContain('name="courseId"\r\n\r\ne2e-resource-package');
      writes.push({ path, body: { purpose: "course-resource-package" } });
      return json({ id: uploadId, fileName: pack.source.fileName });
    }
    const body = request.method() === "GET" ? {} : request.postDataJSON() ?? {};
    if (request.method() !== "GET") writes.push({ path, body });
    if (path === "/api/auth/me") return json({ user: { id: "e2e-package-teacher", role: "teacher", name: "资源包验收教师", displayName: "资源包验收教师" } });
    if (path === "/api/textbooks") return json({ textbooks: [] });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "资源包验收教师" }, hydrated: true, updatedAt: fixedTime });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: 1 });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/resource-package`) {
      if (request.method() === "POST") {
        expect(body).toEqual({ uploadId });
        packageJob = { id: "package-job-1", status: "running", progress: 35, message: "正在读取知识点与教案并转换启动课件" };
      } else if (request.method() === "PATCH") {
        expect(body.revision).toBe(pack.revision);
        if (body.action === 'adapt') {
          expect(body.conflictVersion).toBe(pack.conflictVersion);
          pack = { ...pack, draft: body.draft, adaptation: { schemaVersion: 1, conflictVersion: pack.conflictVersion!, sourceRevision: pack.revision, draftSignature: 'fixture-signature', authorizedBy: 'e2e-package-teacher', authorizedAt: fixedTime, changes: ['真人分组已适配为个人与 AI 伙伴协作'] } } as CourseResourcePackage;
          packageJob = { id: 'package-job-1', status: 'ready', progress: 100, message: '授课副本转换完成，请确认', package: pack };
          return json({ job: packageJob });
        }
        expect(body.action).toBe("confirm");
        pack = { ...pack, revision: pack.revision + 1, draft: body.draft as ResourcePackageDraft, confirmedAt: fixedTime };
        packageJob = { id: "package-job-1", status: "ready", progress: 100, message: "教学要求已确认", package: pack };
      } else if (packageJob?.status === "running") {
        packageJob = { id: "package-job-1", status: withConflicts && !pack.adaptation ? "blocked" : "ready", progress: 100, message: "已识别六类知识、135 分钟教案与项目启动 PPT", package: pack };
      }
      return json({ job: packageJob });
    }
    if (path === `/api/courses/${courseId}/design-generation`) return json({ backgroundEnabled: true, job: null });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No fixture for this endpoint" }) });
  });
  await page.goto(`/teacher/prepare/${courseId}/verify`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "解析并确认课程资源包" })).toBeVisible({ timeout: 30_000 }).catch(async (cause) => {
    throw new Error(`${String(cause)}\nBrowser errors: ${JSON.stringify(pageErrors)}\nAPI requests: ${JSON.stringify(observedRequests)}\nUnexpected API requests: ${JSON.stringify(unexpected)}\nPage: ${(await page.locator("body").innerText()).slice(0, 3000)}`);
  });
  return { writes, unexpected, pageErrors };
}

async function assertNoHorizontalOverflow(page: Page) {
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.viewport + 1);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`resource package confirmation and generation ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const fixture = await mockGeneration(page);
    const generate = page.getByRole("button", { name: "开始生成课程", exact: true });
    await expect(generate).toBeDisabled();
    await expect(page.getByLabel("上传课堂资源包")).toBeEnabled();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, info, "package-required");

    const zip = new JSZip();
    zip.file("资料/知识点.md", "browser upload fixture; parsing is mocked");
    zip.file("资料/教案.md", "browser upload fixture; parsing is mocked");
    zip.file("资料/项目启动.pptx", "browser upload fixture; conversion is mocked");
    await page.getByLabel("上传课堂资源包").setInputFiles({ name: packageFixture().source.fileName, mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
    await expect(page.getByRole("progressbar", { name: "资源包解析进度" })).toBeVisible();
    await expect(page.getByLabel("上传课堂资源包")).toBeDisabled();
    await expect(page.getByLabel("授课对象（专业、年级或学段，必填）")).toHaveValue("本科一年级");
    await expect(page.getByLabel("课程总分钟数（必填）")).toHaveValue("135");
    await expect(page.getByText(/知识与证据 · 6 个主题/)).toBeVisible();
    const confirm = page.getByRole("button", { name: "确认并保存教学要求", exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByLabel("项目学习驱动问题（必填）").fill("如何为真实学习者设计一节有证据支持的人工智能课程？");
    await page.locator("summary").filter({ hasText: "知识讲授" }).click();
    await page.getByLabel("知识讲授分钟数", { exact: true }).fill("40");
    await expect(page.getByText("五阶段时长之和必须等于课程总分钟数，请修正教案时间。", { exact: true })).toBeVisible();
    await expect(confirm).toBeDisabled();
    await page.getByLabel("知识讲授分钟数", { exact: true }).fill("30");
    await page.getByLabel("学科 / 课程领域").fill("人工智能教育与教学设计");
    await page.reload();
    await expect(page.getByLabel("学科 / 课程领域")).toHaveValue("人工智能教育与教学设计");
    await expect(generate).toBeDisabled();
    await confirm.click();
    await expect(page.getByText("教学要求已确认，可开始生成课堂", { exact: true })).toBeVisible();
    await expect(generate).toBeEnabled();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, info, "package-confirmed");
    await page.getByLabel("补充课程生成要求（可选）").fill("多用真实教学案例，配图突出核心概念之间的关系。");
    await page.getByRole("button", { name: "开启深度交互模式", exact: true }).click();
    await generate.click();
    await expect.poll(() => fixture.writes.filter((entry) => entry.path.endsWith("/design-generation")).length).toBe(1);
    expect(fixture.writes.find((entry) => entry.path.endsWith("/design-generation"))?.body).toMatchObject({
      resourcePackageId: "resource-package-1", resourcePackageRevision: 2,
      supplementalAnswers: { brief: "多用真实教学案例，配图突出核心概念之间的关系。" }, generationMode: "deep-interaction",
      options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false },
    });
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });
}

test('core conflict pauses confirmation and requires an explicit version-bound adaptation', async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await mockGeneration(page, true);
  const zip = new JSZip(); zip.file('课堂资料.txt', 'API parsing fixture');
  await page.getByLabel('上传课堂资源包').setInputFiles({ name: '教学资源包.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await expect(page.getByRole('region', { name: '资源包兼容性冲突' })).toBeVisible();
  await page.locator('summary').filter({ hasText: '教案要求真人分组' }).click();
  await expect(page.getByText('建议每组约5人', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始生成课程', exact: true })).toBeDisabled();
  const adapt = page.getByRole('button', { name: '按系统流程适配后继续', exact: true });
  await expect(adapt).toBeDisabled();
  await page.getByLabel('项目学习驱动问题（必填）').fill('如何用证据设计适合学习者的人工智能课程？');
  await expect(adapt).toBeEnabled();
  await adapt.click();
  await expect(page.getByText('已按教师授权统一适配 · 查看变更')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始生成课程', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '确认并保存教学要求', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始生成课程', exact: true })).toBeEnabled();
  expect(fixture.writes.filter((entry) => (entry.body as { action?: string })?.action === 'adapt')).toHaveLength(1);
  expect(fixture.pageErrors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

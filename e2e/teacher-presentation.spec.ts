import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { SignJWT } from "jose";
import { PDFDocument, rgb } from "pdf-lib";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { REFLECTION_SURVEY_QUESTIONS } from "../src/lib/reflection-survey";

// All API traffic and sockets are intercepted. This suite never creates users,
// writes classroom state, or requires a real teacher account in the database.
const courseId = "e2e-teacher-presentation";
const fixedTime = "2026-09-12T00:00:00.000Z";

function classroom(): Course {
  const students = Array.from({ length: 36 }, (_, index) => ({
    id: `student-${index}`, name: `私密学生${index + 1}`, joinedAt: fixedTime, stageProgress: {},
  }));
  return {
    id: courseId, version: 1, name: "校园节能方案设计：从数据观察到行动改进的跨学科项目课堂",
    subject: "科学", grade: "七年级", hours: 1, summary: "", drivingQuestion: "怎样改进校园能源使用？",
    status: "teaching", stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0,
    students, resources: [], groups: [], inviteCode: "E2ETST",
    content: {
      pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      teachingOutline: DEFAULT_STAGES.map((stage) => ({ id: stage.key, stageKey: stage.key, title: `${stage.label}学习任务`, teachingGoal: "依据观察和证据说明方案", studentActivity: "完成观察记录，并提交节能方案。" })),
    },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: fixedTime, pausedAt: fixedTime, activeStageKey: "launch", updatedAt: fixedTime,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 0 ? "active" : "pending" })),
    } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
}

async function samplePdf() {
  const document = await PDFDocument.create();
  for (let index = 1; index <= 2; index++) {
    const page = document.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(0.97, 0.98, 0.99), borderWidth: 8, borderColor: rgb(0.2, 0.3, 0.45) });
    page.drawText(`CLASSROOM PRESENTATION / PAGE ${index}`, { x: 48, y: 430, size: 34, color: rgb(0.2, 0.3, 0.45) });
    page.drawText(index === 1 ? "Observe energy use in our school." : "Use evidence to explain the proposed changes.", { x: 48, y: 330, size: 26 });
    page.drawRectangle({ x: 48, y: 48, width: 864, height: 200, color: index === 1 ? rgb(0.83, 0.91, 0.9) : rgb(0.91, 0.87, 0.73) });
  }
  return Buffer.from(await document.save());
}

async function mockClassroom(page: Page, options: { rejectFullscreen?: boolean; empty?: boolean; pdfResource?: boolean; activeShowcase?: boolean; waitingShowcase?: boolean; reflectionResponses?: boolean; customReflection?: boolean; mountain?: boolean } = {}) {
  let course = classroom();
  if (options.mountain) {
    course.students = Array.from({ length: 40 }, (_, index) => ({ id: `student-${index}`, name: `私密学生${index + 1}`, joinedAt: fixedTime, stageProgress: {} }));
    course.currentStageIndex = 1;
    course.aiLearningProgress = Object.fromEntries(course.students.map((student) => [student.id, {
      classroomId: courseId, studentId: student.id, currentSceneIndex: 5, totalScenes: 10,
      completedScenes: ["scene-1", "scene-2", "scene-3", "scene-4", "scene-5"],
      completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: fixedTime,
    }]));
  }
  if (options.reflectionResponses || options.customReflection) {
    course.reflections = course.students.slice(0, 3).map((student, index): NonNullable<Course["reflections"]>[number] => ({
      id: `reflection-${student.id}`, courseId, studentId: student.id, studentName: student.name,
      content: "旧文本不应进入逐题统计", createdAt: fixedTime, updatedAt: fixedTime,
      survey: { schemaVersion: 1, learningReflection: `学习原文${index + 1}：通过证据比较解决观察困难。`, systemReflection: `系统原文${index + 1}：系统导航帮助我找到协作工具。`, aiHelpfulness: index === 2 ? 5 : 4, systemUsability: 3, reuseIntention: index === 0 ? 1 : 5 },
    }));
    const source = (index: number, field: "learningReflection" | "systemReflection") => ({ studentId: `student-${index}`, fields: [field] });
    course.aiSupports = [{ id: "reflection-summary", courseId, kind: "reflection-class-summary", targetType: "course", targetId: courseId, updatedAt: fixedTime, createdAt: fixedTime, structuredPayload: {
      schemaVersion: 1, generatedAt: fixedTime, coveragePercent: 8, coverageBucket: 0, trigger: "manual", responseCount: 3, totalStudentCount: 36,
      sourceRevision: "fixture", sourceRefs: course.reflections.map((record) => ({ reflectionId: record.id, studentId: record.studentId, updatedAt: record.updatedAt })),
      courseSummary: "班级反思汇总", teachingRecommendations: ["仅供教师的建议"], studentSummaries: [],
      categories: [
        { key: "learning-gains", title: "学习收获", summary: "", terms: [{ label: "证据比较", sources: [source(0, "learningReflection"), source(1, "learningReflection")] }] },
        { key: "common-difficulties", title: "共同困难", summary: "", terms: [{ label: "证据比较", sources: [source(0, "learningReflection"), source(2, "learningReflection")] }] },
        { key: "ai-collaboration", title: "AI 协作", summary: "", terms: [{ label: "系统导航", sources: [source(0, options.customReflection ? "learningReflection" : "systemReflection"), source(2, options.customReflection ? "learningReflection" : "systemReflection")] }] },
        { key: "course-improvements", title: "改进方向", summary: "", terms: [] },
      ],
    } }] as Course["aiSupports"];
  }
  if (options.customReflection) {
    const questions = [{ id: "evidence", prompt: "这次项目中你如何比较证据？", required: true }, { id: "navigation", prompt: "下一次如何改进你的协作过程？", required: true }];
    course.content.stagePlan = {
      schemaVersion: 1, source: "resource-package", totalMinutes: 50, lessonCount: 1, minutesPerLesson: 50,
      stages: (["launch", "ai-learning", "make", "showcase", "reflection"] as const).map((key, index) => ({ key, title: DEFAULT_STAGES[index]!.label, durationMin: 10, requirements: "", outputs: "", teacherActions: "", aiActions: "" })),
      evaluationCriteria: "", reflectionQuestions: questions.map((question) => question.prompt), reflectionQuestionSet: { id: "custom-questions", version: 1, questions },
    };
    course.reflections = course.reflections!.map((record) => ({ ...record, courseReflection: {
      schemaVersion: 1, questionSetId: "custom-questions", questionSetVersion: 1, questions,
      answers: { evidence: record.survey!.learningReflection, navigation: record.survey!.systemReflection }, submittedAt: fixedTime,
    } }));
  }
  let assignedStudentId: string | undefined;
  const pdfBytes = options.pdfResource || options.activeShowcase || options.waitingShowcase ? await samplePdf() : undefined;
  if (options.pdfResource) course.resources = [{ id: "presentation-pdf", title: "校园能源观察与改进建议：两页课堂演示资料", stageKey: "launch", type: "PDF", size: "2 KB", url: "/api/uploads/e2e-presentation-pdf", displayMode: "slides", downloadedBy: [] }];
  if (options.empty) course.students = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  // Production's service can use a different secret from .env.local. Supply
  // OPENPBL_E2E_JWT_SECRET_FILE when reusing that server; never log its contents.
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (secret && secret.length >= 32) {
    const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-presentation", displayName: "大屏验收教师" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("e2e-presentation-teacher")
      .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  await page.routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) {
      // Development hydration waits for the HMR handshake; it carries no
      // classroom traffic. Continue mocking every application socket below.
      socket.connectToServer();
      return;
    }
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
      if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
    });
  });
  if (options.rejectFullscreen) {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = async () => { throw new DOMException("Fixture denies native fullscreen", "NotAllowedError"); };
    });
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === "GET" ? {} : request.postDataJSON() ?? {};
    if (request.method() !== "GET") writes.push({ path, body });
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (pdfBytes && (path === "/api/uploads/e2e-presentation-pdf" || path === `/api/courses/${courseId}/showcase/artifacts/e2e-artifact` || path.startsWith(`/api/courses/${courseId}/showcase/artifacts/artifact-student-`))) return route.fulfill({ status: 200, contentType: "application/pdf", body: pdfBytes });
    if (path === "/api/auth/me") return json({ user: { id: "e2e-presentation-teacher", role: "teacher", name: "大屏验收教师", displayName: "大屏验收教师" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "大屏验收教师" }, hydrated: true, updatedAt: course.updatedAt });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseVersion: course.version, resourceProjection: course.uiState?.resourceProjection ?? null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ enabled: false }) });
    }
    if (path === `/api/courses/${courseId}/actions`) {
      const action = body.action as { type: string; payload: { patch?: Partial<Course> } };
      if (action.type === "UPDATE_COURSE") course = { ...course, ...action.payload.patch, version: (course.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      return json({ ok: true, requestId: body.requestId, courseVersion: course.version, updatedAt: course.updatedAt });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation` && options.waitingShowcase) {
      if (request.method() === "POST") {
        if (body.action !== "assign" || typeof body.studentId !== "string") return route.fulfill({ status: 400, json: { message: "Fixture only allows queue assignment" } });
        assignedStudentId = body.studentId;
      }
      // The default server queue is ordered by ready time, not roster order.
      const order = [course.students[2]!, course.students[0]!, ...course.students.filter((_, index) => index !== 0 && index !== 2)];
      const queue = order.map((student, index) => ({
        studentId: student.id, studentName: student.name, groupId: `group-${student.id}`, position: index + 1,
        status: assignedStudentId === student.id ? "called" : index < 2 ? "waiting" : "not-ready",
        artifacts: index < 2 ? [{ kind: "pdf", versionId: `artifact-${student.id}`, title: `已提交成果${index + 1}`, sequence: 1, submittedAt: fixedTime, displayModes: ["slides"] }] : [],
      }));
      return json({
        courseId, stageKey: "showcase", presentingStudentId: assignedStudentId ?? null,
        presentingGroupId: assignedStudentId ? `group-${assignedStudentId}` : null,
        students: queue.map((item) => ({ studentId: item.studentId, name: item.studentName, groupId: item.groupId, isAssigned: item.studentId === assignedStudentId, artifacts: item.artifacts })),
        ownArtifacts: [], presentations: [], activePresentation: null, queue, minutesPerStudent: 5,
        currentQueueItem: queue.find((item) => item.status === "called") ?? null,
        nextQueueItem: queue.find((item) => item.status === "waiting") ?? null,
      });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation` && options.activeShowcase) {
      const artifact = { kind: "pdf", versionId: "e2e-artifact", title: "校园节能项目最终成果", sequence: 1, submittedAt: fixedTime, displayModes: ["slides", "continuous"] };
      const activePresentation = {
        id: "e2e-active", courseId, groupId: "", studentId: "student-0", studentName: "私密学生1",
        artifactKind: "pdf", artifactVersionId: artifact.versionId, artifactTitle: artifact.title, displayMode: "slides", status: "active", revision: 1,
        requestedAt: fixedTime, reviewedAt: fixedTime, startedAt: new Date().toISOString(), updatedAt: fixedTime,
        viewState: { page: 2, revision: 1, updatedAt: fixedTime },
      };
      const queue = course.students.map((student, index) => ({ studentId: student.id, studentName: student.name, position: index + 1, status: index === 0 ? "presenting" : "not-ready", presentationId: index === 0 ? activePresentation.id : undefined, artifacts: index === 0 ? [artifact] : [] }));
      return json({ courseId, stageKey: "showcase", presentingStudentId: "student-0", students: course.students.map((student, index) => ({ studentId: student.id, name: student.name, isAssigned: index === 0, artifacts: index === 0 ? [artifact] : [] })), ownArtifacts: [], presentations: [activePresentation], activePresentation, queue, currentQueueItem: queue[0], minutesPerStudent: 5 });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation`) return json({
      courseId, stageKey: "showcase", presentations: [], activePresentation: null, ownArtifacts: [], minutesPerStudent: 5,
      students: course.students.map((student) => ({ studentId: student.id, name: student.name, isAssigned: false, artifacts: [] })),
      queue: course.students.map((student, index) => ({ studentId: student.id, studentName: student.name, position: index + 1, status: "not-ready", artifacts: [] })),
    });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "No fixture for this endpoint" }) });
  });
  await page.goto(`/teacher/teach/${courseId}/classroom`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible().catch((cause) => {
    throw new Error(`Classroom fixture did not hydrate: ${JSON.stringify({ errors, unexpected })}`, { cause });
  });
  return { writes, unexpected, errors, course: () => course };
}

async function enterFullscreen(page: Page) {
  await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "授课展示", exact: true })).toHaveAttribute("aria-pressed", "true");
}

async function assertNoPageOverflow(page: Page, mode: "classroom" | "reflection" = "classroom") {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  // The presentation's content area may scroll; the fixed outer frame must fit.
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
  const controls = mode === "reflection"
    ? ["退出全屏", "题目目录", "课堂操作", "工具"]
    : ["退出全屏", "授课展示", "班级学情", "课堂操作", "工具", "教学建议", "结束课堂"];
  for (const name of controls) {
    const control = page.getByRole("button", { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    const box = await control.boundingBox();
    expect(box?.height, `${name} click target`).toBeGreaterThanOrEqual(40);
  }
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

async function inspectClassroomTools(page: Page) {
  for (const name of ["学生邀请码", "在线学生"]) {
    await page.getByRole("button", { name: "工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "课堂工具", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("link", { name: "查看课程" })).toHaveAttribute("target", "_blank");
    await tools.getByRole("button", { name, exact: true }).click();
    const detail = page.getByRole("dialog", { name, exact: true });
    await expect(detail).toBeVisible();
    if (name === "学生邀请码") await expect(detail.getByRole("button", { name: "复制", exact: true })).toBeInViewport({ ratio: 1 });
    else await expect(detail.getByText("私密学生1", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "教学建议", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "教学建议", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function assertWorkspaceFrame(page: Page) {
  const workspace = page.locator("section.classroom-stage[data-details='true']");
  await expect(workspace).toBeVisible();
  const appearance = await workspace.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
  });
  expect(appearance.background).toBe("rgba(0, 0, 0, 0)");
  expect(appearance.border).toEqual(["0px", "0px", "0px", "0px"]);
  expect(appearance.shadow).toBe("none");
  const layout = await workspace.evaluate((node: HTMLElement) => {
    const footer = document.querySelector(".teacher-presentation footer")!;
    const footerBounds = footer.getBoundingClientRect();
    let scrollHost: HTMLElement | undefined;
    for (let candidate: HTMLElement | null = node; candidate; candidate = candidate.parentElement) {
      const style = getComputedStyle(candidate);
      if (/(auto|scroll)/.test(style.overflowY) && candidate.scrollHeight > candidate.clientHeight + 1) { scrollHost = candidate; break; }
    }
    const bounds = (scrollHost ?? node).getBoundingClientRect();
    let scrolled = false;
    if (scrollHost) {
      const original = scrollHost.scrollTop;
      scrollHost.scrollTop = scrollHost.scrollHeight;
      scrolled = scrollHost.scrollTop > 0;
      scrollHost.scrollTop = original;
    }
    return { bottom: bounds.bottom, footerTop: footerBounds.top, needsScroll: Boolean(scrollHost), scrolled };
  });
  expect(layout.bottom).toBeLessThanOrEqual(layout.footerTop + 1);
  if (layout.needsScroll) expect(layout.scrolled).toBe(true);
  const returnButton = page.locator(".teacher-presentation footer").getByRole("button", { name: /^返回(展示|汇总)$/ });
  await expect(returnButton).toBeInViewport({ ratio: 1 });
  // Real hit testing catches a workspace child painting over the fixed footer.
  expect(await returnButton.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === node || node.contains(hit);
  })).toBe(true);
}

async function enterReflection(page: Page) {
  await enterFullscreen(page);
  await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("4");
  await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
  await expect(page.getByRole("region", { name: "反思问卷大屏", exact: true })).toBeVisible();
}

async function assertReflectionCloudFits(page: Page) {
  const canvas = page.getByLabel("词云画布", { exact: true });
  await canvas.scrollIntoViewIfNeeded();
  // Fractional CSS pixels at narrow widths can leave a subpixel SVG edge
  // outside the scrollport. Word bounds below still enforce readable glyphs.
  await expect(canvas).toBeInViewport({ ratio: 0.995 });
  const bounds = await canvas.evaluate((node) => {
    const frame = node.getBoundingClientRect();
    return { width: frame.width, height: frame.height, clipped: [...node.querySelectorAll("text")].filter((text) => {
      const word = text.getBoundingClientRect();
      return word.left < frame.left - 2 || word.right > frame.right + 2 || word.top < frame.top - 2 || word.bottom > frame.bottom + 2;
    }).map((text) => text.textContent) };
  });
  expect(bounds.width).toBeGreaterThan(150);
  expect(bounds.height).toBeGreaterThan(80);
  expect(bounds.clipped).toEqual([]);
  for (const control of [
    page.getByRole("button", { name: "上一道反思题", exact: true }),
    page.getByRole("combobox", { name: "选择反思题目" }),
    page.getByRole("button", { name: "下一道反思题", exact: true }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 0.98 });
  }
  await assertNoPageOverflow(page, "reflection");
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
  test(`reflection questions show grounded clouds and per-option distributions ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { reflectionResponses: true });
    await enterReflection(page);
    const board = page.getByRole("region", { name: "反思问卷大屏", exact: true });
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection, exact: true })).toBeVisible();
    const learningTerm = page.getByRole("button", { name: "证据比较，3 人提及", exact: true });
    await expect(learningTerm).toBeVisible();
    await expect(page.getByRole("button", { name: /系统导航，/ })).toHaveCount(0);
    await expect(board).not.toContainText("私密学生");
    await expect(board).not.toContainText("学习原文");
    await assertReflectionCloudFits(page);
    await screenshot(page, info, "reflection-learning-cloud");
    await learningTerm.click();
    const evidence = page.getByRole("dialog", { name: "主题“证据比较”的回答 · 3 人", exact: true });
    await expect(evidence.getByText("私密学生1", { exact: true })).toBeVisible();
    await expect(evidence).toContainText("学习原文1");
    await expect(evidence).not.toContainText("系统原文");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemReflection, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "系统导航，2 人提及", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /证据比较，/ })).toHaveCount(0);
    await assertReflectionCloudFits(page);
    await screenshot(page, info, "reflection-system-cloud");
    await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.aiHelpfulness, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "同意，2 人，67%", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "非常同意，1 人，33%", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "非常不同意，0 人，0%", exact: true })).toBeVisible();
    await expect(board).not.toContainText("私密学生");
    await screenshot(page, info, "reflection-scale-distribution");
    await page.getByRole("button", { name: "同意，2 人，67%", exact: true }).click();
    const selected = page.getByRole("dialog", { name: "选择“同意”的回答 · 2 人", exact: true });
    await expect(selected).toContainText("私密学生1");
    await expect(selected).toContainText("私密学生2");
    await expect(selected).not.toContainText("私密学生3");
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("3");
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemUsability, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "不确定，3 人，100%", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "题目目录", exact: true }).click();
    await page.getByRole("navigation", { name: "反思题目目录" }).getByRole("button", { name: new RegExp(REFLECTION_SURVEY_QUESTIONS.reuseIntention) }).click();
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.reuseIntention, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "非常同意，2 人，67%", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "下一道反思题", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "上一道反思题", exact: true }).click();
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemUsability, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看本题回答", exact: true }).click();
    const allAnswers = page.getByRole("dialog", { name: "本题回答 · 3 人", exact: true });
    await expect(allAnswers).toContainText("私密学生1");
    await expect(allAnswers).toContainText("私密学生3");
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("0");
    await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "证据比较，3 人提及", exact: true })).toBeVisible();
    await expect(board).not.toContainText("私密学生");
    await assertReflectionCloudFits(page);
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await expect(page.getByRole("button", { name: "返回展示", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await expect(board).toBeVisible();
    expect(fixture.course().currentStageIndex).toBe(4);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.body.action).toMatchObject({ type: "UPDATE_COURSE", payload: { patch: { currentStageIndex: 4 } } });
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("empty reflection questions keep all zero choices and never fabricate a cloud", async ({ page }) => {
  const fixture = await mockClassroom(page);
  await enterReflection(page);
  await expect(page.getByText("本题暂未收到回答", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "更新词云", exact: true })).toBeDisabled();
  await expect(page.getByLabel("词云画布", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("2");
  await expect(page.getByRole("button", { name: /，0 人，0%$/ })).toHaveCount(5);
  await page.getByRole("button", { name: "查看本题回答", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "本题回答 · 0 人", exact: true })).toContainText("暂无符合条件的回答");
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("custom course reflection questions ground each cloud in that question's original answer", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await mockClassroom(page, { customReflection: true });
  await enterReflection(page);
  await expect(page.getByRole("heading", { name: "这次项目中你如何比较证据？", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "证据比较，3 人提及", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /系统导航，/ })).toHaveCount(0);
  await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
  await expect(page.getByRole("heading", { name: "下一次如何改进你的协作过程？", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "系统导航，2 人提及", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("系统原文1");
  await expect(dialog).not.toContainText("学习原文");
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1024, height: 576 }, { width: 1920, height: 1080 }]) {
  test(`footer starts the first ready showcase student without approval ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { waitingShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    const commonActions = page.getByRole("group", { name: "当前阶段常用操作", exact: true });
    const start = commonActions.getByRole("button", { name: "开始汇报", exact: true });
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport({ ratio: 1 });
    expect(fixture.writes.filter(({ path }) => path.endsWith("/showcase/presentation"))).toEqual([]);
    await start.click();
    await expect.poll(() => fixture.writes.filter(({ path }) => path.endsWith("/showcase/presentation")).map(({ body }) => body)).toEqual([
      { action: "assign", groupId: "group-student-2", studentId: "student-2" },
    ]);
    await expect(commonActions.getByRole("button", { name: "教师发起投屏", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "选择学生汇报材料" })).toBeVisible();
    await expect(page.getByRole("button", { name: "批准并开始", exact: true })).toHaveCount(0);
    await screenshot(page, info, "footer-showcase-called");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }]) {
  test(`ordinary showcase material controls do not overlap the preview ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { waitingShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    const fullscreenRail = page.getByTestId("teacher-showcase-management");
    await expect(fullscreenRail.getByRole("heading", { name: "汇报队列" })).toBeVisible();
    const fullscreenLayout = await page.getByRole("button", { name: "选择学生汇报材料" }).evaluate((node) => {
      const main = node.closest("main")?.getBoundingClientRect();
      const preview = node.closest("main")?.querySelector('[class*="preview"]')?.getBoundingClientRect();
      const rail = document.querySelector('[data-testid="teacher-showcase-management"]')?.getBoundingClientRect();
      const stage = node.closest("section.classroom-stage")?.getBoundingClientRect();
      return { mainRight: main?.right ?? 0, mainBottom: main?.bottom ?? 0, previewBottom: preview?.bottom ?? 0, railLeft: rail?.left ?? 0, railTop: rail?.top ?? 0, stageBottom: stage?.bottom ?? 0 };
    });
    if (viewport.width > 1100) {
      expect(fullscreenLayout.railLeft).toBeGreaterThan(fullscreenLayout.mainRight);
      expect(fullscreenLayout.stageBottom - fullscreenLayout.previewBottom).toBeLessThan(4);
    } else {
      expect(fullscreenLayout.railTop).toBeGreaterThanOrEqual(fullscreenLayout.mainBottom);
    }
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    const selector = page.getByRole("button", { name: "选择学生汇报材料" });
    await expect(selector).toBeVisible();
    await expect(page.locator('canvas[aria-label="PDF 第 1 页"]').first()).toBeVisible();
    const geometry = await selector.evaluate((node) => {
      const toolbar = node.closest("[class*=toolbar]");
      const preview = toolbar?.nextElementSibling;
      const controls = toolbar?.getBoundingClientRect();
      const body = preview?.getBoundingClientRect();
      const action = preview?.nextElementSibling?.getBoundingClientRect();
      const footer = document.querySelector(".pbl-safe-bottom.fixed")?.getBoundingClientRect();
      const stage = node.closest("section.classroom-stage")?.getBoundingClientRect();
      return { controlBottom: controls?.bottom ?? 0, previewTop: body?.top ?? 0, previewBottom: body?.bottom ?? 0, previewHeight: body?.height ?? 0, previewRight: body?.right ?? 0, actionBottom: action?.bottom ?? 0, footerTop: footer?.top ?? 0, stageTop: stage?.top ?? 0, viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.previewTop).toBeGreaterThanOrEqual(geometry.controlBottom - 1);
    expect(geometry.previewBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
    expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
    expect(geometry.previewHeight / (geometry.footerTop - geometry.stageTop)).toBeGreaterThanOrEqual(.65);
    expect(geometry.previewRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    await expect(page.getByRole("button", { name: "开始汇报", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("combobox", { name: "选择查看材料的学生" }).selectOption("student-0");
    await page.getByRole("button", { name: "逐页演示" }).click();
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await enterFullscreen(page);
    await expect(page.getByRole("combobox", { name: "选择查看材料的学生" })).toHaveValue("student-0");
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    if (viewport.width === 1366) {
      await page.getByRole("button", { name: "显示班级概览" }).click();
      await expect(page.getByTestId("teacher-showcase-management").getByRole("heading", { name: "汇报队列" })).toBeVisible();
      const compactGeometry = await selector.evaluate((node) => {
        const preview = node.closest("[class*=toolbar]")?.nextElementSibling?.getBoundingClientRect();
        const footer = document.querySelector(".pbl-safe-bottom.fixed")?.getBoundingClientRect();
        return { previewBottom: preview?.bottom ?? 0, footerTop: footer?.top ?? 0, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      expect(compactGeometry.previewBottom).toBeLessThanOrEqual(compactGeometry.footerTop + 1);
      expect(compactGeometry.scrollWidth).toBeLessThanOrEqual(compactGeometry.viewportWidth + 1);
      await page.getByRole("button", { name: "收起班级概览" }).click();
    }
    await screenshot(page, info, "showcase-ordinary-workspace");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("all five classroom workspaces stay unframed and clear of the footer at low height", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const fixture = await mockClassroom(page);
  await enterFullscreen(page);
  for (let index = 0; index < DEFAULT_STAGES.length; index++) {
    if (index > 0) {
      await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption(String(index));
      await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    }
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await assertWorkspaceFrame(page);
    await screenshot(page, info, `workspace-${index}`);
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function assertCanvasFits(page: Page, label: string) {
  const canvas = page.locator(`canvas[aria-label="${label}"]`).filter({ visible: true });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(0);
  const geometry = await canvas.evaluate((node: HTMLCanvasElement) => {
    const bounds = node.getBoundingClientRect();
    const clipping: string[] = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
      const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
      if ((clipsX && (bounds.left < rect.left - 2 || bounds.right > rect.right + 2)) || (clipsY && (bounds.top < rect.top - 2 || bounds.bottom > rect.bottom + 2))) clipping.push(ancestor.className);
    }
    return { width: bounds.width, height: bounds.height, renderedRatio: bounds.width / bounds.height, sourceRatio: node.width / node.height, clipping };
  });
  expect(geometry.width).toBeGreaterThan(150);
  expect(geometry.height).toBeGreaterThan(80);
  expect(geometry.renderedRatio).toBeCloseTo(geometry.sourceRatio, 1);
  expect(geometry.clipping).toEqual([]);
  await expect(canvas).toBeInViewport({ ratio: 1 });
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1920, height: 1080 }]) {
  test(`PDF slides remain visible and retain page across views ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { pdfResource: true });
    await enterFullscreen(page);
    await assertCanvasFits(page, "PPT 第 1 页");
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "pdf-first-page");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await assertCanvasFits(page, "PPT 第 2 页");
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    await page.getByRole("button", { name: "授课展示", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await assertCanvasFits(page, "PPT 第 2 页");
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "pdf-preserved-second-page");
    await assertNoPageOverflow(page);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  test(`approved showcase PDF fits the presentation area ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { activeShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    await assertCanvasFits(page, "PDF 第 2 页");
    if (viewport.width > 1100) {
      const rail = page.getByTestId("teacher-showcase-management");
      await expect(rail.getByRole("heading", { name: "汇报队列" })).toBeVisible();
      const geometry = await page.getByRole("region", { name: "校园节能项目最终成果", exact: true }).evaluate((node) => {
        const material = node.getBoundingClientRect();
        const rail = document.querySelector('[data-testid="teacher-showcase-management"]')?.getBoundingClientRect();
        const stage = node.closest("section.classroom-stage")?.getBoundingClientRect();
        return { materialRight: material.right, materialBottom: material.bottom, railLeft: rail?.left ?? 0, railBottom: rail?.bottom ?? 0, stageBottom: stage?.bottom ?? 0 };
      });
      expect(geometry.railLeft).toBeGreaterThan(geometry.materialRight);
      expect(geometry.stageBottom - geometry.materialBottom).toBeLessThan(4);
      expect(geometry.stageBottom - geometry.railBottom).toBeLessThan(4);
      const queueSpace = await rail.evaluate((node) => {
        const body = node.children[1] as HTMLElement;
        return { bodyBottom: body.getBoundingClientRect().bottom, railBottom: node.getBoundingClientRect().bottom, visibleHeight: body.clientHeight, contentHeight: body.scrollHeight };
      });
      expect(queueSpace.railBottom - queueSpace.bodyBottom).toBeLessThan(2);
      expect(queueSpace.contentHeight).toBeGreaterThan(queueSpace.visibleHeight);
    }
    await expect(page.getByText("2 / 2", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("region", { name: "校园节能项目最终成果", exact: true }).getByRole("button", { name: "结束汇报", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "当前阶段常用操作", exact: true }).getByRole("button", { name: "结束汇报", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("region", { name: "校园节能项目最终成果", exact: true }).getByRole("button", { name: "上一页" }).click();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByRole("region", { name: "校园节能项目最终成果", exact: true }).getByRole("button", { name: "最小化" }).click();
    await page.getByRole("button", { name: "恢复汇报投屏" }).click();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await screenshot(page, info, "showcase-approved-pdf");
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    await expect(page.getByRole("region", { name: "班级学情大屏" })).not.toContainText("私密学生");
    await page.getByRole("button", { name: "授课展示", exact: true }).click();
    await assertCanvasFits(page, "PDF 第 2 页");
    await assertNoPageOverflow(page);
    expect(fixture.writes.every(({ path }) => path.endsWith("/actions"))).toBe(true);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
  { width: 1024, height: 768 }, { width: 1024, height: 576 }, { width: 390, height: 844 },
]) {
  test(`projection layout ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    await enterFullscreen(page);
    await assertNoPageOverflow(page);
    await screenshot(page, info, "teaching");
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    const analytics = page.getByRole("region", { name: "班级学情大屏" });
    await expect(analytics).toBeVisible();
    await expect(analytics).not.toContainText("私密学生");
    await assertNoPageOverflow(page);
    await screenshot(page, info, "analytics");
    await inspectClassroomTools(page);
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 576 }, { width: 390, height: 844 }]) {
  test(`AI learning mountain keeps 40 nearby students distinct ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { mountain: true });
    await enterFullscreen(page);
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    const mountain = page.getByRole("region", { name: "班级学习山形图" });
    await expect(mountain).toBeVisible();
    const leaderNames = mountain.locator("span").filter({ hasText: "领先学生" }).first().locator("strong");
    await expect(leaderNames).toContainText("私密学生1、私密学生10、私密学生11");
    expect(await leaderNames.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
    const bin = mountain.getByRole("button", { name: "50–59%，40人，查看名单" });
    await expect(bin.locator("i")).toHaveCount(40);
    const boxes = await bin.locator("i").evaluateAll((dots) => dots.map((dot) => {
      const rect = dot.getBoundingClientRect();
      return `${rect.x},${rect.y},${rect.width},${rect.height}`;
    }));
    expect(new Set(boxes).size).toBe(40);
    await bin.click();
    await expect(mountain.getByRole("region", { name: "50–59%学生名单" }).locator("li")).toHaveCount(40);
    await assertNoPageOverflow(page);
    await screenshot(page, info, "learning-mountain");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("five stages retain controls, hide details on view/stage changes, and preserve save semantics", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await mockClassroom(page);
  await enterFullscreen(page);
  for (let index = 0; index < DEFAULT_STAGES.length; index++) {
    if (index > 0) {
      await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption(String(index));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /进入“/ }).click();
    }
    await expect(page.getByRole("heading", { name: DEFAULT_STAGES[index]!.label, exact: true }).first()).toBeVisible();
    if (index === 4) {
      const reflection = page.getByRole("region", { name: /^(反思问卷大屏|班级学情大屏)$/ });
      await expect(reflection).toBeVisible();
      await screenshot(page, info, "stage-4-reflection");
      await page.getByRole("button", { name: "课堂操作", exact: true }).click();
      await assertWorkspaceFrame(page);
      await page.getByRole("button", { name: /^返回(展示|汇总)$/ }).click();
      await expect(reflection).toBeVisible();
      await assertNoPageOverflow(page, "reflection");
      continue;
    }
    await page.getByRole("button", { name: "授课展示", exact: true }).click();
    await screenshot(page, info, `stage-${index}-teaching`);
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await expect(page.getByRole("button", { name: "返回展示", exact: true })).toBeVisible();
    await assertWorkspaceFrame(page);
    await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    await expect(page.getByRole("region", { name: "班级学情大屏" })).not.toContainText("私密学生");
    await page.getByRole("button", { name: "查看明细", exact: true }).click();
    await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "授课展示", exact: true }).click();
    await page.getByRole("button", { name: "班级学情", exact: true }).click();
    await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toHaveCount(0);
    await assertNoPageOverflow(page);
    await screenshot(page, info, `stage-${index}-analytics`);
  }
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await page.getByRole("dialog", { name: "课堂工具" }).getByRole("button", { name: "课堂计时" }).click();
  const timer = page.getByRole("dialog", { name: "课堂计时" });
  await expect(timer).toBeVisible();
  await timer.getByRole("button", { name: "继续", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.status).toBe("running");
  await timer.getByRole("button", { name: "暂停", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.status).toBe("paused");
  const adjustment = fixture.course().uiState!.classroomTiming!.stages[4]!.adjustmentSec;
  await timer.getByRole("button", { name: "+2 分", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.adjustmentSec).toBe(adjustment + 120);
  await timer.getByRole("button", { name: "-2 分", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.adjustmentSec).toBe(adjustment);
  await timer.getByRole("button", { name: "重计", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.elapsedSec).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "结束课堂", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "继续授课", exact: true }).click();
  expect(fixture.course().currentStageIndex).toBe(4);
  expect(fixture.writes.every(({ path }) => path.endsWith("/actions"))).toBe(true);
  expect(fixture.writes.every(({ body }) => (body.action as { type: string }).type === "UPDATE_COURSE")).toBe(true);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("fullscreen denial falls back to an immersive window and Escape restores the workspace", async ({ page }) => {
  const fixture = await mockClassroom(page, { rejectFullscreen: true, empty: true });
  await enterFullscreen(page);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await page.getByRole("button", { name: "班级学情", exact: true }).click();
  await expect(page.getByText("暂无学生加入课堂", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

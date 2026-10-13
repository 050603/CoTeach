import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { SignJWT } from "jose";
import { PDFDocument, rgb } from "pdf-lib";
import { readFileSync } from "node:fs";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";

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

async function mockClassroom(page: Page, options: { rejectFullscreen?: boolean; empty?: boolean; pdfResource?: boolean; activeShowcase?: boolean; waitingShowcase?: boolean; posttestResponses?: boolean; mountain?: boolean } = {}) {
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
  course.platformContext = { offeringId: "presentation-offering", activityId: "presentation-activity", templateId: "template", templateVersionId: "version" };
  const questionnaire = {
    pretest: [{ id: "pre-evidence", type: "short-answer", prompt: "观察开始前，你会记录什么？" }],
    posttest: [
      { id: "comparison", type: "single-choice", prompt: "哪种记录更适合比较校园能源使用？", options: ["统一观察时长并记录数量", "只凭个人印象判断"], correctAnswer: "统一观察时长并记录数量", group: { id: "evidence", title: "观察与证据", instruction: "根据本次项目的记录作答。" } },
      { id: "explanation", type: "short-answer", prompt: "请结合具体观察记录说明你下一步如何验证节能方案。" },
    ],
  };
  const submissions = options.posttestResponses ? course.students.slice(0, 3).flatMap((student, index) => ([
    { id: `pre-${student.id}`, phase: "pretest", variant: "none", student: { id: student.id, displayName: student.name, username: student.id }, submittedAt: fixedTime, questionnaire, answers: { "pre-evidence": `前测原文${index + 1}：先记录观察地点和时间。` }, objectiveScore: 0, objectiveTotal: 0 },
    { id: `post-${student.id}`, phase: "posttest", variant: "none", student: { id: student.id, displayName: student.name, username: student.id }, submittedAt: fixedTime, questionnaire, answers: { comparison: "统一观察时长并记录数量", explanation: `后测原文${index + 1}：对比同一时段的用电数据，核验节能方案。` }, objectiveScore: 1, objectiveTotal: 1 },
  ])) : [];
  const resultReads: string[] = [];
  const exportCursors: Array<string | null> = [];
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
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
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
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) {
      resultReads.push(request.url());
      const studentRows = course.students.map((student, index) => ({ student: { id: student.id, displayName: student.name },
        status: options.posttestResponses && index < 3 ? "submitted" : options.posttestResponses && index < 5 ? "in-progress" : "not-started",
        submittedAt: options.posttestResponses && index < 3 ? fixedTime : null }));
      return json({ enabled: true, status: "teaching", enrollmentCount: course.students.length, participantCount: course.students.length,
        pretestCount: options.posttestResponses ? 3 : 0, posttestCount: options.posttestResponses ? 3 : 0,
        posttestDraftCount: options.posttestResponses ? 2 : 0, posttestOpenedAt: fixedTime,
        studentRows, variantCounts: { aPreBPost: 0, bPreAPost: 0 }, submissions });
    }
    if (path === "/api/platform/offerings/presentation-offering/research-export") {
      const query = new URL(request.url()).searchParams;
      exportCursors.push(query.get("cursor"));
      return json({ rows: query.has("cursor") ? submissions.slice(3) : submissions.slice(0, 3), nextCursor: query.has("cursor") ? null : "page-2" });
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
  return { writes, unexpected, errors, resultReads, exportCursors, submissions, course: () => course };
}

async function enterFullscreen(page: Page) {
  await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "授课展示", exact: true })).toHaveAttribute("aria-pressed", "true");
}

async function assertNoPageOverflow(page: Page, mode: "classroom" | "posttest" = "classroom") {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  // The presentation's content area may scroll; the fixed outer frame must fit.
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
  const controls = mode === "posttest"
    ? ["退出全屏", "课堂操作", "工具", "教学建议", "结束课堂"]
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

async function enterPosttest(page: Page) {
  await enterFullscreen(page);
  await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("4");
  await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
  await expect(page.getByRole("region", { name: "后测进度", exact: true })).toBeVisible();
}

async function assertPosttestCounts(page: Page, counts: [number, number, number]) {
  const statistics = page.getByLabel("后测人数统计", { exact: true });
  for (const [index, status] of ["未开始", "作答中", "已提交"].entries()) {
    const card = statistics.locator(":scope > div").filter({ hasText: status });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeInViewport({ ratio: 0.98 });
    await expect(card.locator("strong")).toHaveText(String(counts[index]));
  }
  const progress = page.getByRole("progressbar", { name: "后测提交进度", exact: true });
  await expect(progress).toHaveAttribute("aria-valuenow", String(counts[2]));
  await expect(progress).toHaveAttribute("aria-valuemax", String(counts.reduce((sum, count) => sum + count, 0)));
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
  test(`posttest progress protects projected answers and keeps teacher details usable ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { posttestResponses: true });
    await enterPosttest(page);
    const board = page.getByRole("region", { name: "后测进度", exact: true });
    await assertPosttestCounts(page, [31, 2, 3]);
    await expect(board).toContainText("3/36 人已提交正式后测。草稿不计入提交人数。");
    await expect(board).not.toContainText("私密学生");
    await expect(board).not.toContainText("后测原文");
    await assertNoPageOverflow(page, "posttest");
    await screenshot(page, info, "posttest-projected-progress");

    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await assertWorkspaceFrame(page);
    await expect(board.getByRole("link", { name: "实验配置", exact: true })).toHaveAttribute("href", "/teacher/classes/presentation-offering/activities/presentation-activity/experiment");
    const student = board.locator("#posttest-student-student-0");
    await student.locator("summary").click();
    const pretest = student.getByRole("region", { name: "前测正式答案", exact: true });
    const posttest = student.getByRole("region", { name: "后测正式答案", exact: true });
    await expect(pretest).toContainText("前测原文1");
    await expect(pretest).not.toContainText("后测原文");
    await expect(posttest).toContainText("后测原文1");
    await expect(posttest).not.toContainText("前测原文");
    await expect(posttest).toContainText("参考答案：统一观察时长并记录数量");
    await expect(posttest).toContainText("客观题 1/1");
    const answer = posttest.getByText("学生作答：后测原文1：对比同一时段的用电数据，核验节能方案。", { exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "posttest-formal-answers");
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await expect(board).not.toContainText("私密学生");
    await expect(board.getByRole("region", { name: "后测正式答案" })).toHaveCount(0);
    await assertPosttestCounts(page, [31, 2, 3]);
    await assertNoPageOverflow(page, "posttest");
    expect(fixture.course().currentStageIndex).toBe(4);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.body.action).toMatchObject({ type: "UPDATE_COURSE", payload: { patch: { currentStageIndex: 4 } } });
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("empty posttest results show no submitted students or invented formal answers", async ({ page }) => {
  const fixture = await mockClassroom(page);
  await enterPosttest(page);
  await assertPosttestCounts(page, [36, 0, 0]);
  await expect(page.getByRole("region", { name: "后测进度" })).toContainText("0/36 人已提交正式后测。");
  await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  const board = page.getByRole("region", { name: "后测进度", exact: true });
  await expect(board.locator('[id^="posttest-student-"]')).toHaveCount(36);
  await expect(board.locator("details")).toHaveCount(0);
  await expect(board.getByRole("region", { name: /正式答案$/ })).toHaveCount(0);
  await expect(board.locator("#posttest-student-student-0")).toContainText("未开始");
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("posttest refresh and paginated export preserve each student's formal pretest and posttest", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const fixture = await mockClassroom(page, { posttestResponses: true });
  await enterPosttest(page);
  await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  const reads = fixture.resultReads.length;
  await page.getByRole("button", { name: "刷新进度", exact: true }).click();
  await expect.poll(() => fixture.resultReads.length).toBeGreaterThan(reads);
  await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeEnabled();
  const board = page.getByRole("region", { name: "后测进度", exact: true });
  await expect(board.locator("#posttest-student-student-3")).toContainText("作答中");
  await expect(board.locator("#posttest-student-student-3 details")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出实验数据", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("classroom-experiments-presentation-offering.json");
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const exported = JSON.parse(readFileSync(path, "utf8"));
  expect(exported.rows).toEqual(fixture.submissions);
  expect(exported.rows).toHaveLength(6);
  expect(fixture.exportCursors).toEqual([null, "page-2"]);
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
  test(`AI learning mountain keeps 40 students accessible in the compact chart ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
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
    await expect(bin).toContainText("40 人");
    await expect(mountain.locator("svg path").last()).toHaveAttribute("d", / C /);
    await bin.hover();
    await expect(mountain.locator("svg rect")).toHaveCount(1);
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
      const posttest = page.getByRole("region", { name: "后测进度", exact: true });
      await expect(posttest).toBeVisible();
      await screenshot(page, info, "stage-4-posttest");
      await page.getByRole("button", { name: "课堂操作", exact: true }).click();
      await assertWorkspaceFrame(page);
      await page.getByRole("button", { name: /^返回(展示|汇总)$/ }).click();
      await expect(posttest).toBeVisible();
      await assertNoPageOverflow(page, "posttest");
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

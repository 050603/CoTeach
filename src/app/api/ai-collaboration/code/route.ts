import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  buildCodeCollaborationPrompts,
  buildCodeTaskStarterPrompts,
  detectProtectedCodeWorkRequest,
  isCodeCollaborationIntent,
  normalizeCodeCollaborationResponse,
  normalizeCodeTaskStarters,
  type CodeCollaborationIntent,
  type CodeCollaborationResponse,
  type CodeRunContext,
  type CodeSelection,
} from "@/lib/ai-collaboration/code-policy";
import type {
  CodeAiComment,
  CodeAiCommentThread,
} from "@/lib/ai-collaboration/code-comment-types";
import {
  parseCodeArtifact,
  type CodeArtifactLanguage,
} from "@/lib/ai-collaboration/code-artifact";
import { appendAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import {
  activeConversationId,
  modelConversationHistory,
  visibleConversationMessages,
} from "@/lib/ai-collaboration/conversation-window";
import {
  companionLimiter,
  codeSuggestionLimiter,
  rateLimitKey,
  rateLimitedResponse,
} from "@/lib/auth/rate-limit";
import {
  isAuthConfigured,
  readAuthFromRequest,
  type StudentClaims,
} from "@/lib/auth/session";
import {
  appendCompanionMessages,
  companionMessage,
  getCompanionThread,
  softDeleteCompanionMessage,
} from "@/lib/companion/server-store";
import { callLLM, parseLLMJson } from "@/lib/llm/client";
import {
  LlmCallFailedError,
  LlmJsonModeUnsupportedError,
  LlmNotConfiguredError,
  LlmRateLimitError,
  LlmTimeoutError,
} from "@/lib/llm/errors";
import { getCourse } from "@/lib/session/server-store";
import type { CompanionMessage, Course, Student } from "@/lib/session/types";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COLLABORATION_STAGE_KEYS = new Set(["proposal", "make"]);
const THREAD_PREFIX = "ai-code-collaboration";
const COMMENT_THREAD_PREFIX = "ai-code-comments";
const COMMENT_META_PREFIX = "OPENPBL_CODE_COMMENT_META:";
const COMMENT_READ_PREFIX = "OPENPBL_CODE_COMMENT_READ:";
const COMMENT_RESOLVED_PREFIX = "OPENPBL_CODE_COMMENT_RESOLVED:";
const CODE_COMMENT_REVIEW_VERSION = 2;
const MAX_ARTIFACT_LENGTH = 120_000;
const TRANSIENT_RETRIES = 2;

async function recordInteractionEvents(
  events: Parameters<typeof appendAiInteractionEvents>[0],
): Promise<void> {
  try {
    await appendAiInteractionEvents(events);
  } catch (error) {
    console.error("[ai-code-collaboration] audit event write failed", error);
  }
}

type CodeCollaborationRequest = {
  courseId?: unknown;
  studentId?: unknown;
  stageKey?: unknown;
  language?: unknown;
  action?: unknown;
  intent?: unknown;
  message?: unknown;
  artifact?: unknown;
  selection?: unknown;
  run?: unknown;
  conversationId?: unknown;
  commentThreadId?: unknown;
  mode?: unknown;
};

type CodeCommentMeta = Omit<CodeAiCommentThread, "comments" | "readAt" | "resolvedAt">;

function clean(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maxLength)
    : "";
}

function parseLanguage(value: unknown): CodeArtifactLanguage | undefined {
  return value === "python" || value === "c" ? value : undefined;
}

function parseSelection(value: unknown, language: CodeArtifactLanguage): CodeSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const filePath = clean(record.filePath, 240);
  const text = clean(record.text, 16_000);
  const startLine = Number(record.startLine);
  const startColumn = Number(record.startColumn);
  const endLine = Number(record.endLine);
  const endColumn = Number(record.endColumn);
  const extensionAllowed = language === "python"
    ? filePath.toLowerCase().endsWith(".py")
    : /\.(?:c|h)$/i.test(filePath);
  if (
    !filePath
    || !text
    || !extensionAllowed
    || ![startLine, startColumn, endLine, endColumn].every((item) => Number.isInteger(item) && item > 0)
  ) return undefined;
  return { filePath, text, startLine, startColumn, endLine, endColumn };
}

function parseRunContext(value: unknown): CodeRunContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const status = clean(record.status, 20);
  if (status !== "idle" && status !== "success" && status !== "failed" && status !== "timeout") {
    return undefined;
  }
  const phase = record.phase === "compile" || record.phase === "run" ? record.phase : undefined;
  const rawExitCode = record.exitCode;
  const exitCode = rawExitCode === null
    ? null
    : Number.isInteger(Number(rawExitCode))
      ? Number(rawExitCode)
      : undefined;
  return {
    status,
    phase,
    exitCode,
    stdout: clean(record.stdout, 12_000),
    stderr: clean(record.stderr, 16_000),
  };
}

function threadKey(stageKey: string, language: CodeArtifactLanguage): string {
  return `${THREAD_PREFIX}:${stageKey}:${language}`;
}

function commentThreadKey(stageKey: string, language: CodeArtifactLanguage): string {
  return `${COMMENT_THREAD_PREFIX}:${stageKey}:${language}`;
}

function encodeCodeCommentMeta(meta: CodeCommentMeta): string {
  return `${COMMENT_META_PREFIX}${JSON.stringify(meta)}`;
}

function parseCodeCommentMeta(message: CompanionMessage): CodeCommentMeta | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_META_PREFIX)) return null;
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_META_PREFIX.length)) as Record<string, unknown>;
    const id = clean(raw.id, 160);
    const filePath = clean(raw.filePath, 240);
    const title = clean(raw.title, 100);
    const quotedCode = clean(raw.quotedCode, 2_000);
    const createdAt = clean(raw.createdAt, 80) || message.createdAt;
    const startLine = Number(raw.startLine);
    const endLine = Number(raw.endLine);
    const reviewVersion = Number(raw.reviewVersion);
    const severity = raw.severity === "error" || raw.severity === "warning" ? raw.severity : "notice";
    if (!id || !filePath || !title || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) return null;
    return {
      id,
      filePath,
      startLine,
      endLine,
      severity,
      title,
      quotedCode,
      createdAt,
      reviewVersion: Number.isInteger(reviewVersion) && reviewVersion > 0 ? reviewVersion : undefined,
    };
  } catch {
    return null;
  }
}

function parseThreadTimestamp(message: CompanionMessage, prefix: string): { id: string; at: string } | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(prefix)) return null;
  try {
    const raw = JSON.parse(message.content.slice(prefix.length)) as Record<string, unknown>;
    const id = clean(raw.id, 160);
    const at = clean(raw.at, 80) || message.createdAt;
    return id ? { id, at } : null;
  } catch {
    return null;
  }
}

function latestTimestamp(items: Array<{ id: string; at: string }>, id: string): string | undefined {
  return items
    .filter((item) => item.id === id)
    .map((item) => item.at)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function codeCommentThreads(messages: CompanionMessage[]): CodeAiCommentThread[] {
  const metas = messages.map(parseCodeCommentMeta).filter((item): item is CodeCommentMeta => Boolean(item));
  const reads = messages.map((message) => parseThreadTimestamp(message, COMMENT_READ_PREFIX)).filter((item): item is { id: string; at: string } => Boolean(item));
  const resolutions = messages.map((message) => parseThreadTimestamp(message, COMMENT_RESOLVED_PREFIX)).filter((item): item is { id: string; at: string } => Boolean(item));
  return metas.map((meta) => ({
    ...meta,
    readAt: latestTimestamp(reads, meta.id),
    resolvedAt: latestTimestamp(resolutions, meta.id),
    comments: messages
      .filter((message) => message.conversationId === meta.id
        && (message.role === "student" || message.role === "agent")
        && !message.hiddenFromStudentAt)
      .map((message): CodeAiComment => ({
        id: message.id,
        role: message.role === "student" ? "student" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })),
  })).filter((thread) => thread.comments.length > 0);
}

function threadSelection(thread: CodeAiCommentThread, artifact: ReturnType<typeof parseCodeArtifact>): CodeSelection | undefined {
  if (!artifact) return undefined;
  const file = artifact.files.find((item) => item.path === thread.filePath);
  if (!file) return undefined;
  const lines = file.content.split("\n");
  const startLine = Math.max(1, Math.min(lines.length, thread.startLine));
  const endLine = Math.max(startLine, Math.min(lines.length, thread.endLine));
  return {
    filePath: file.path,
    startLine,
    startColumn: 1,
    endLine,
    endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
    text: thread.quotedCode || lines.slice(startLine - 1, endLine).join("\n"),
  };
}

async function authenticateStudent(
  request: Request,
  courseId: string,
  requestedStudentId: string,
): Promise<{ claims: StudentClaims | null; studentId: string } | Response> {
  if (!isAuthConfigured()) {
    if (!requestedStudentId) return Response.json({ error: "MISSING_STUDENT_ID" }, { status: 400 });
    return { claims: null, studentId: requestedStudentId };
  }
  const claims = await readAuthFromRequest(request, "student");
  if (!claims || claims.role !== "student") {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (claims.courseId !== courseId) {
    return Response.json({ error: "STUDENT_SCOPE_MISMATCH" }, { status: 403 });
  }
  if (!(await canAccessLegacyCourse(claims, courseId, "write"))) {
    return Response.json({ error: "COURSE_LOCKED" }, { status: 403 });
  }
  return { claims, studentId: claims.studentId };
}

async function loadScope(input: {
  request: Request;
  courseId: string;
  requestedStudentId: string;
  stageKey: string;
}): Promise<{ course: Course; student: Student } | Response> {
  if (!COLLABORATION_STAGE_KEYS.has(input.stageKey)) {
    return Response.json({ error: "STAGE_NOT_SUPPORTED", message: "代码协作目前仅支持方案与制作阶段。" }, { status: 400 });
  }
  const authentication = await authenticateStudent(input.request, input.courseId, input.requestedStudentId);
  if (authentication instanceof Response) return authentication;
  const course = await getCourse(input.courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const student = course.students.find((item) => item.id === authentication.studentId);
  if (!student) return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  if (course.stages[course.currentStageIndex]?.key !== input.stageKey) {
    return Response.json({ error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入。" }, { status: 409 });
  }
  return { course, student };
}

async function callCodeModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await callLLM(messages, {
      jsonMode: true,
      abortSignal: signal,
      maxTransientRetries: TRANSIENT_RETRIES,
    });
  } catch (error) {
    if (!(error instanceof LlmJsonModeUnsupportedError)) throw error;
    return callLLM(messages, {
      jsonMode: false,
      abortSignal: signal,
      maxTransientRetries: TRANSIENT_RETRIES,
    });
  }
}

function failureResponse(error: unknown): Response {
  if (error instanceof LlmRateLimitError) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return Response.json(
      { error: "AI_RATE_LIMITED", message: `AI 组员当前请求较多，请在 ${seconds} 秒后重试。本次没有修改代码。` },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
  }
  if (error instanceof LlmTimeoutError) {
    return Response.json({ error: "AI_TIMEOUT", message: "AI 组员本次思考超时，请重试。本次没有修改代码。" }, { status: 504 });
  }
  if (error instanceof LlmNotConfiguredError) {
    return Response.json({ error: "AI_NOT_CONFIGURED", message: "AI 服务尚未配置，请联系教师或管理员。" }, { status: 503 });
  }
  if (error instanceof LlmCallFailedError) {
    return Response.json({ error: "AI_UPSTREAM_FAILED", message: "AI 服务刚才出现短暂波动，请重新发送。本次没有修改代码。" }, { status: error.status === 429 ? 429 : 503 });
  }
  return Response.json({ error: "AI_FAILED", message: "AI 组员暂时无法回应，请稍后重试。本次没有修改代码。" }, { status: 503 });
}

function assistantRecord(result: CodeCollaborationResponse): string {
  // The student sees this thread again after refresh, so persist the same
  // natural response shown in the live UI. Structured change metadata is
  // returned separately and must not leak into the conversational voice.
  return result.message;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = clean(url.searchParams.get("courseId"), 120);
  const studentId = clean(url.searchParams.get("studentId"), 120);
  const stageKey = clean(url.searchParams.get("stageKey"), 80);
  const language = parseLanguage(url.searchParams.get("language"));
  if (!courseId || !stageKey || !language) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadScope({ request, courseId, requestedStudentId: studentId, stageKey });
  if (scope instanceof Response) return scope;
  const thread = await getCompanionThread(courseId, scope.student.id, threadKey(stageKey, language));
  const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
  const conversationId = activeConversationId(thread?.messages ?? []);
  return Response.json({
    conversationId,
    messages: visibleConversationMessages(thread?.messages ?? [], conversationId).slice(-40),
    commentThreads: codeCommentThreads(commentStore?.messages ?? []),
  });
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = clean(url.searchParams.get("courseId"), 120);
  const requestedStudentId = clean(url.searchParams.get("studentId"), 120);
  const stageKey = clean(url.searchParams.get("stageKey"), 80);
  const language = parseLanguage(url.searchParams.get("language"));
  const messageId = clean(url.searchParams.get("messageId"), 160);
  const conversationId = clean(url.searchParams.get("conversationId"), 160);
  if (!courseId || !stageKey || !language || !messageId || !conversationId) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadScope({ request, courseId, requestedStudentId, stageKey });
  if (scope instanceof Response) return scope;
  const key = threadKey(stageKey, language);
  const thread = await getCompanionThread(courseId, scope.student.id, key);
  if (conversationId !== activeConversationId(thread?.messages ?? [])) {
    return Response.json({ error: "CONVERSATION_CHANGED", message: "当前对话已经变化，请刷新后重试。" }, { status: 409 });
  }
  const changed = await softDeleteCompanionMessage({
    courseId,
    studentId: scope.student.id,
    stageKey: key,
    messageId,
    conversationId,
  });
  return Response.json({ ok: true, changed });
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: CodeCollaborationRequest;
  try {
    body = await request.json() as CodeCollaborationRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const courseId = clean(body.courseId, 120);
  const requestedStudentId = clean(body.studentId, 120);
  const stageKey = clean(body.stageKey, 80);
  const language = parseLanguage(body.language);
  const action = clean(body.action, 80);
  const message = clean(body.message, 1_600);
  const commentThreadId = clean(body.commentThreadId, 160);
  const mode = body.mode === "task" ? "task" : "discuss";
  const intent = isCodeCollaborationIntent(body.intent) ? body.intent : undefined;
  if (!courseId || !stageKey || !language || (!action && (!intent || (intent !== "proactive-review" && !message)))) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const scope = await loadScope({ request, courseId, requestedStudentId, stageKey });
  if (scope instanceof Response) return scope;
  const key = threadKey(stageKey, language);
  const thread = await getCompanionThread(courseId, scope.student.id, key);
  const currentConversationId = activeConversationId(thread?.messages ?? []);

  if (action === "reset-conversation") {
    const conversationId = `code-conversation-${randomUUID()}`;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: key,
      messages: [companionMessage({
        role: "system-trigger",
        content: "学生在代码协作空间开始了新对话；此前记录保留用于学习过程分析。",
        visibility: "teacher-only",
        triggerKind: "conversation-reset",
        conversationId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, conversationId, messages: [] });
  }
  const serializedArtifact = typeof body.artifact === "string"
    ? body.artifact
    : JSON.stringify(body.artifact ?? null);
  if (serializedArtifact.length > MAX_ARTIFACT_LENGTH) {
    return Response.json({ error: "ARTIFACT_TOO_LARGE", message: "当前代码项目过大，请减少单次协作范围后重试。" }, { status: 413 });
  }
  const artifact = parseCodeArtifact(serializedArtifact, language);
  if (!artifact || artifact.files.length > 16) {
    return Response.json({ error: "INVALID_ARTIFACT" }, { status: 400 });
  }
  const selection = parseSelection(body.selection, language);
  const run = parseRunContext(body.run);

  if (action === "read-code-comment" || action === "resolve-code-comment") {
    if (!commentThreadId) return Response.json({ error: "INVALID_COMMENT_THREAD" }, { status: 400 });
    const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
    const existing = codeCommentThreads(commentStore?.messages ?? []).find((item) => item.id === commentThreadId);
    if (!existing) return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    const at = new Date().toISOString();
    const prefix = action === "resolve-code-comment" ? COMMENT_RESOLVED_PREFIX : COMMENT_READ_PREFIX;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: commentThreadKey(stageKey, language),
      messages: [companionMessage({
        role: "system-trigger",
        content: `${prefix}${JSON.stringify({ id: commentThreadId, at })}`,
        visibility: "teacher-only",
        triggerKind: action === "resolve-code-comment" ? "document-saved" : "document-comment-read",
        conversationId: commentThreadId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, at });
  }

  if (action === "code-task-starters") {
    const starterLimit = codeSuggestionLimiter.check(rateLimitKey(request, scope.student.id));
    if (!starterLimit.allowed) return rateLimitedResponse(starterLimit.retryAfterMs);
    const prompts = buildCodeTaskStarterPrompts({
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      artifact,
      run,
      mode,
    });
    try {
      const raw = await callCodeModel([
        { role: "system", content: prompts.system },
        { role: "user", content: prompts.user },
      ], request.signal);
      return Response.json({ starters: normalizeCodeTaskStarters(parseLLMJson(raw)) });
    } catch (error) {
      if (request.signal.aborted) return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      return failureResponse(error);
    }
  }

  const limit = companionLimiter.check(rateLimitKey(request, scope.student.id));
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  if (action === "reply-code-comment") {
    if (!commentThreadId || !message) return Response.json({ error: "INVALID_COMMENT_REPLY" }, { status: 400 });
    const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
    const existing = codeCommentThreads(commentStore?.messages ?? []).find((item) => item.id === commentThreadId);
    if (!existing) return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    const replyIntent: CodeCollaborationIntent = /(?:改|修复|删除|删掉|新增|补上|替换|调整|写入|应用|处理掉)/.test(message)
      ? "edit"
      : "discuss";
    const protectedBoundary = detectProtectedCodeWorkRequest(message);
    const prompts = buildCodeCollaborationPrompts({
      course: scope.course,
      studentId: scope.student.id,
      studentName: scope.student.name,
      stageKey,
      intent: replyIntent,
      request: message,
      artifact,
      selection: threadSelection(existing, artifact),
      run,
      history: existing.comments.slice(-8).map((item) => ({
        role: item.role === "student" ? "user" : "assistant",
        content: item.content,
      })),
      protectedBoundary,
    });
    try {
      const raw = await callCodeModel([
        { role: "system", content: prompts.system },
        { role: "user", content: prompts.user },
      ], request.signal);
      const result = normalizeCodeCollaborationResponse({
        raw: parseLLMJson(raw) as Record<string, unknown>,
        artifact,
        intent: replyIntent,
        protectedBoundary,
      });
      const studentMessage = companionMessage({
        role: "student",
        content: message,
        visibility: "student-and-teacher",
        conversationId: commentThreadId,
        authorId: scope.student.id,
        authorName: scope.student.name,
      });
      const agentMessage = companionMessage({
        role: "agent",
        content: result.message,
        visibility: "student-and-teacher",
        conversationId: commentThreadId,
        companionId: "critic",
        authorName: "AI 组员",
      });
      await appendCompanionMessages({
        courseId,
        studentId: scope.student.id,
        stageKey: commentThreadKey(stageKey, language),
        messages: [studentMessage, agentMessage],
      });
      await recordInteractionEvents([
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "request",
          actorRole: "student",
          actorId: scope.student.id,
          content: message,
          payload: { intent: replyIntent, language, targetText: existing.quotedCode },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "policy",
          actorRole: "system",
          content: protectedBoundary ? `命中代码协作边界：${protectedBoundary}` : "本轮未命中强制代码协作边界。",
          payload: { ...(protectedBoundary ? { protectedCapability: protectedBoundary } : {}), outcome: result.kind },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: "response",
          actorRole: "ai",
          content: result.message,
          payload: { kind: result.kind, language },
          requestId,
        },
      ]);
      return Response.json({
        commentThread: {
          ...existing,
          comments: [
            ...existing.comments,
            { id: studentMessage.id, role: "student", content: studentMessage.content, createdAt: studentMessage.createdAt },
            { id: agentMessage.id, role: "assistant", content: agentMessage.content, createdAt: agentMessage.createdAt },
          ],
        } satisfies CodeAiCommentThread,
        result,
      });
    } catch (error) {
      if (request.signal.aborted) return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      return failureResponse(error);
    }
  }

  if (!intent) return Response.json({ error: "INVALID_INTENT" }, { status: 400 });
  const protectedBoundary = intent === "proactive-review" ? undefined : detectProtectedCodeWorkRequest(message);

  const prompts = buildCodeCollaborationPrompts({
    course: scope.course,
    studentId: scope.student.id,
    studentName: scope.student.name,
    stageKey,
    intent,
    request: message,
    artifact,
    selection,
    run,
    history: intent === "proactive-review"
      ? []
      : modelConversationHistory(thread?.messages ?? [], currentConversationId),
    protectedBoundary,
  });
  try {
    const raw = await callCodeModel([
      { role: "system", content: prompts.system },
      { role: "user", content: prompts.user },
    ], request.signal);
    const result = normalizeCodeCollaborationResponse({
      raw: parseLLMJson(raw) as Record<string, unknown>,
      artifact,
      intent,
      protectedBoundary,
    });
    if (intent === "proactive-review") {
      const commentStore = await getCompanionThread(courseId, scope.student.id, commentThreadKey(stageKey, language));
      const existingThreads = codeCommentThreads(commentStore?.messages ?? []);
      const existingFingerprints = new Set(existingThreads.filter((item) => !item.resolvedAt).map((item) => [
        item.filePath,
        item.startLine,
        item.endLine,
        item.title,
        item.quotedCode,
      ].join(":")));
      const commentThreads: CodeAiCommentThread[] = [];
      const messages: CompanionMessage[] = [];
      result.findings.forEach((finding) => {
        const fingerprint = [
          finding.filePath,
          finding.startLine,
          finding.endLine,
          finding.title,
          finding.quotedCode,
        ].join(":");
        if (existingFingerprints.has(fingerprint)) return;
        existingFingerprints.add(fingerprint);
        const id = `code-comment-${randomUUID()}`;
        const createdAt = new Date().toISOString();
        const meta: CodeCommentMeta = {
          id,
          filePath: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          severity: finding.severity,
          title: finding.title,
          quotedCode: finding.quotedCode,
          createdAt,
          reviewVersion: CODE_COMMENT_REVIEW_VERSION,
        };
        const metaMessage = companionMessage({
          role: "system-trigger",
          content: encodeCodeCommentMeta(meta),
          visibility: "teacher-only",
          triggerKind: "document-saved",
          conversationId: id,
          authorName: "系统",
        });
        const agentMessage = companionMessage({
          role: "agent",
          content: finding.message,
          visibility: "student-and-teacher",
          companionId: "critic",
          conversationId: id,
          authorName: "AI 组员",
        });
        messages.push(metaMessage, agentMessage);
        commentThreads.push({
          ...meta,
          comments: [{
            id: agentMessage.id,
            role: "assistant",
            content: agentMessage.content,
            createdAt: agentMessage.createdAt,
          }],
        });
      });
      if (messages.length) {
        await appendCompanionMessages({
          courseId,
          studentId: scope.student.id,
          stageKey: commentThreadKey(stageKey, language),
          messages,
        });
        await recordInteractionEvents(commentThreads.map((thread) => ({
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: thread.id,
          source: "proactive-comment" as const,
          eventType: "comment" as const,
          actorRole: "ai" as const,
          content: thread.comments[0]?.content ?? "AI 组员发起了代码批注。",
          payload: {
            commentThreadId: thread.id,
            filePath: thread.filePath,
            startLine: thread.startLine,
            endLine: thread.endLine,
            issueType: thread.title,
            targetText: thread.quotedCode,
            initialComment: true,
          },
          requestId,
        })));
      }
      return Response.json({ result, commentThreads });
    }

    const userMessage = companionMessage({
      role: "student",
      content: message,
      visibility: "student-and-teacher",
      conversationId: currentConversationId,
      authorName: scope.student.name,
    });
    const agentMessage = companionMessage({
      role: "agent",
      content: assistantRecord(result),
      visibility: "student-and-teacher",
      conversationId: currentConversationId,
      companionId: intent === "review" ? "critic" : intent === "delegate" ? "knowledge" : "planner",
      authorName: "AI 组员",
    });
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: key,
      messages: [userMessage, agentMessage],
    });
    const source = selection ? "selection" as const : "sidebar" as const;
    await recordInteractionEvents([
      {
        courseId,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "request",
        actorRole: "student",
        actorId: scope.student.id,
        content: message,
        payload: { intent, language, selection: selection ?? null },
        requestId,
      },
      {
        courseId,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "policy",
        actorRole: "system",
        content: protectedBoundary ? `命中代码协作边界：${protectedBoundary}` : "本轮未命中强制代码协作边界。",
        payload: { ...(protectedBoundary ? { protectedCapability: protectedBoundary } : {}), outcome: result.kind },
        requestId,
      },
      {
        courseId,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "response",
        actorRole: "ai",
        content: assistantRecord(result),
        payload: { kind: result.kind, language },
        requestId,
      },
    ]);
    return Response.json({
      result,
      conversationId: currentConversationId,
      messages: [userMessage, agentMessage],
    });
  } catch (error) {
    if (request.signal.aborted) return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
    return failureResponse(error);
  }
}

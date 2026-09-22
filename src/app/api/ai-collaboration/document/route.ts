import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  buildDocumentCollaborationPrompts,
  documentHtmlToPlainText,
  evaluateAiWorkPolicy,
  isDocumentCollaborationIntent,
  normalizeDocumentCollaborationResponse,
  protectedBoundaryForPolicy,
  type DocumentCollaborationIntent,
  type DocumentCollaborationResponse,
  type AiWorkPolicyDecision,
} from "@/lib/ai-collaboration/document-policy";
import { appendAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import {
  buildBatchProactiveDocumentCommentPrompts,
  buildDocumentCommentReplyPrompts,
  buildProactiveDocumentCommentPrompts,
  areDocumentCommentIssuesEquivalent,
  documentParagraphVersionFingerprint,
  isReviewableDocumentParagraph,
  normalizeBatchProactiveDocumentComments,
  normalizeDocumentCommentReply,
  normalizeProactiveDocumentComment,
  DOCUMENT_COMMENT_REVIEW_VERSION,
} from "@/lib/ai-collaboration/document-comment-policy";
import type {
  DocumentAiComment,
  DocumentAiCommentThread,
} from "@/lib/ai-collaboration/document-comment-types";
import {
  assessmentToBoundaryResponse,
  buildDelegatedWorkAssessmentPrompts,
  buildDelegatedWorkExecutionPrompts,
  buildDelegatedWorkStarterReviewPrompts,
  buildDelegatedWorkStarterPrompts,
  normalizeDelegatedWorkAssessment,
  normalizeDelegatedWorkDelivery,
  normalizeDelegatedWorkStarters,
  researchTemporarilyUnavailableResponse,
  unavailableResearchResponse,
} from "@/lib/ai-collaboration/delegated-work-policy";
import {
  activeConversationId,
  modelConversationHistory,
  visibleConversationMessages,
} from "@/lib/ai-collaboration/conversation-window";
import {
  companionLimiter,
  getClientIp,
  rateLimitKey,
  rateLimitedResponse,
} from "@/lib/auth/rate-limit";
import {
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
import { authenticateLegacyAiStudent } from "@/lib/ai-collaboration/legacy-scope";
import type { AiCompanionId } from "@/lib/ai-companions";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { CompanionMessage, Course, Student } from "@/lib/session/types";
import { resolveClassroomWebSearchConfig } from "@openmaic/lib/server/web-search-config";
import { formatSearchResultsAsContext, searchWeb } from "@openmaic/lib/web-search";
import {
  collaborationWorkspaceInstruction,
  normalizeCollaborationWorkspaceKind,
  type CollaborationWorkspaceKind,
} from "@/lib/ai-collaboration/workspace-kind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COLLABORATION_STAGE_KEYS = new Set(["proposal", "make"]);
const MAX_DOCUMENT_HTML_LENGTH = 120_000;
const THREAD_PREFIX = "ai-collaboration";
const COMMENT_THREAD_PREFIX = "ai-collaboration-comments";
const COMMENT_META_PREFIX = "OPENPBL_DOCUMENT_COMMENT_META:";
const COMMENT_READ_PREFIX = "OPENPBL_DOCUMENT_COMMENT_READ:";
const COMMENT_SUGGESTION_PREFIX = "OPENPBL_DOCUMENT_COMMENT_SUGGESTION:";
const COMMENT_REVIEW_PREFIX = "OPENPBL_DOCUMENT_COMMENT_REVIEW:";
const COLLABORATION_TRANSIENT_RETRIES = 2;

async function recordInteractionEvents(
  events: Parameters<typeof appendAiInteractionEvents>[0],
  workspaceKind?: CollaborationWorkspaceKind,
): Promise<void> {
  try {
    await appendAiInteractionEvents(workspaceKind
      ? events.map((event) => ({
          ...event,
          payload: { ...(event.payload ?? {}), workspaceKind },
        }))
      : events);
  } catch (error) {
    // Collaboration remains usable if an audit replica is temporarily down;
    // the error is visible in server logs and can be retried by reconciliation.
    console.error("[ai-collaboration] audit event write failed", error);
  }
}

type DocumentCollaborationRequest = {
  courseId?: unknown;
  studentId?: unknown;
  stageKey?: unknown;
  intent?: unknown;
  message?: unknown;
  documentHtml?: unknown;
  selectedText?: unknown;
  history?: unknown;
  proactive?: unknown;
  action?: unknown;
  conversationId?: unknown;
  revisionOf?: unknown;
  commentThreadId?: unknown;
  targetText?: unknown;
  blockIndex?: unknown;
  blockId?: unknown;
  paragraphs?: unknown;
  contributionId?: unknown;
  workspaceKind?: unknown;
};

type ProactiveParagraph = {
  candidateId: string;
  blockId?: string;
  blockIndex: number;
  targetText: string;
};

function parseProactiveParagraphs(value: unknown): ProactiveParagraph[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 40).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const blockId = boundedString(record.blockId, 160) || undefined;
    const blockIndex = Number(record.blockIndex);
    const targetText = boundedString(record.targetText, 3_000);
    const candidateId = boundedString(record.candidateId, 160)
      || blockId
      || `paragraph-${blockIndex}-${index}`;
    if (
      !candidateId
      || seen.has(candidateId)
      || !Number.isInteger(blockIndex)
      || blockIndex < 0
      || !isReviewableDocumentParagraph(targetText)
    ) return [];
    seen.add(candidateId);
    return [{ candidateId, blockId, blockIndex, targetText }];
  });
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function collaborationThreadKey(
  stageKey: string,
  workspaceKind: CollaborationWorkspaceKind = "document",
): string {
  return workspaceKind === "external-artifact"
    ? `${THREAD_PREFIX}:external-artifact:${stageKey}`
    : `${THREAD_PREFIX}:${stageKey}`;
}

function documentCommentThreadKey(
  stageKey: string,
  workspaceKind: CollaborationWorkspaceKind = "document",
): string {
  return workspaceKind === "external-artifact"
    ? `${COMMENT_THREAD_PREFIX}:external-artifact:${stageKey}`
    : `${COMMENT_THREAD_PREFIX}:${stageKey}`;
}

function withWorkspaceInstruction(
  system: string,
  workspaceKind: CollaborationWorkspaceKind,
): string {
  const instruction = collaborationWorkspaceInstruction(workspaceKind);
  return instruction ? `${system}\n\n${instruction}` : system;
}

type DocumentCommentMeta = {
  id: string;
  blockId?: string;
  blockIndex: number;
  blockText?: string;
  targetText: string;
  issueType?: string;
  createdAt: string;
  reviewVersion?: number;
};

type DocumentReviewCheckpoint = {
  fingerprint: string;
  blockId?: string;
  blockIndex: number;
  reviewedAt: string;
  reviewVersion: number;
};

function encodeDocumentReviewCheckpoint(checkpoint: DocumentReviewCheckpoint): string {
  return `${COMMENT_REVIEW_PREFIX}${JSON.stringify(checkpoint)}`;
}

function parseDocumentReviewCheckpoint(message: CompanionMessage): DocumentReviewCheckpoint | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_REVIEW_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_REVIEW_PREFIX.length)) as Record<string, unknown>;
    const fingerprint = boundedString(raw.fingerprint, 120);
    const blockId = boundedString(raw.blockId, 160) || undefined;
    const blockIndex = Number(raw.blockIndex);
    const reviewedAt = boundedString(raw.reviewedAt, 80) || message.createdAt;
    const reviewVersion = Number(raw.reviewVersion);
    if (
      !fingerprint
      || !Number.isInteger(blockIndex)
      || blockIndex < 0
      || !Number.isInteger(reviewVersion)
      || reviewVersion < 1
    ) return null;
    return { fingerprint, blockId, blockIndex, reviewedAt, reviewVersion };
  } catch {
    return null;
  }
}

function documentReviewedParagraphFingerprints(messages: CompanionMessage[]): string[] {
  const fingerprints = new Set(messages
    .map(parseDocumentReviewCheckpoint)
    .filter((checkpoint): checkpoint is DocumentReviewCheckpoint =>
      Boolean(checkpoint && checkpoint.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION)
    )
    .map((checkpoint) => checkpoint.fingerprint));

  documentCommentThreads(messages)
    .filter((thread) =>
      thread.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION
      && Boolean(thread.blockText)
    )
    .forEach((thread) => {
      fingerprints.add(documentParagraphVersionFingerprint(thread.blockText ?? ""));
    });
  return [...fingerprints];
}

function encodeDocumentCommentMeta(meta: DocumentCommentMeta): string {
  return `${COMMENT_META_PREFIX}${JSON.stringify(meta)}`;
}

function parseDocumentCommentMeta(message: CompanionMessage): DocumentCommentMeta | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_META_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_META_PREFIX.length)) as Record<string, unknown>;
    const id = boundedString(raw.id, 160);
    const blockId = boundedString(raw.blockId, 160) || undefined;
    const blockText = boundedString(raw.blockText, 3_000) || undefined;
    const targetText = boundedString(raw.targetText, 3_000);
    const issueType = boundedString(raw.issueType, 40) || undefined;
    const blockIndex = Number(raw.blockIndex);
    const createdAt = boundedString(raw.createdAt, 80) || message.createdAt;
    const reviewVersion = Number(raw.reviewVersion);
    if (!id || !targetText || !Number.isInteger(blockIndex) || blockIndex < 0) return null;
    return {
      id,
      blockId,
      blockText,
      targetText,
      issueType,
      blockIndex,
      createdAt,
      reviewVersion: Number.isInteger(reviewVersion) && reviewVersion > 0
        ? reviewVersion
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseDocumentCommentRead(message: CompanionMessage): { id: string; readAt: string } | null {
  if (message.role !== "system-trigger" || !message.content.startsWith(COMMENT_READ_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.content.slice(COMMENT_READ_PREFIX.length)) as Record<string, unknown>;
    const id = boundedString(raw.id, 160);
    const readAt = boundedString(raw.readAt, 80) || message.createdAt;
    return id ? { id, readAt } : null;
  } catch {
    return null;
  }
}

function documentCommentThreads(messages: CompanionMessage[]): DocumentAiCommentThread[] {
  const metas = messages.map(parseDocumentCommentMeta).filter((meta): meta is DocumentCommentMeta => !!meta);
  const reads = messages.map(parseDocumentCommentRead).filter((read): read is { id: string; readAt: string } => !!read);
  return metas.map((meta) => {
    const readAt = reads
      .filter((read) => read.id === meta.id)
      .map((read) => read.readAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    return {
      ...meta,
      readAt,
      comments: messages
      .filter((message) =>
        message.conversationId === meta.id
        && (message.role === "student" || message.role === "agent")
        && !message.hiddenFromStudentAt
      )
      .map((message): DocumentAiComment => ({
        id: message.id,
        role: message.role === "student" ? "student" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })),
    };
  }).filter((thread) => thread.comments.length > 0);
}

function companionForIntent(intent: DocumentCollaborationIntent): AiCompanionId {
  if (intent === "delegate") return "knowledge";
  if (intent === "check") return "critic";
  if (intent === "summarize" || intent === "organize" || intent === "edit") {
    return "recorder";
  }
  return "planner";
}

type DelegatedWorkRevision = { title: string; content: string };

function parseDelegatedWorkRevision(value: unknown): DelegatedWorkRevision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = boundedString(record.title, 120);
  const content = boundedString(record.content, 8_000);
  return title && content ? { title, content } : undefined;
}

function assistantRecordForResult(result: DocumentCollaborationResponse): string {
  if (result.deliverable) {
    const sources = result.deliverable.sources.length
      ? `\n来源：${result.deliverable.sources.map((source) => `${source.title} ${source.url}`).join("；")}`
      : "";
    const actions = result.deliverable.documentActions
      .map((action) => action.description)
      .join("；");
    return `${result.message}\n组员交付「${result.deliverable.title}」：\n${result.deliverable.content}\n文档操作计划：${actions}${sources}`;
  }
  return [
    result.message,
    result.suggestion
      ? `修改建议「${result.suggestion.title}」：${result.suggestion.replacement}`
      : undefined,
  ].filter(Boolean).join("\n");
}

async function executeDelegatedWork(input: {
  course: Course;
  student: Student;
  stageKey: string;
  request: string;
  documentText: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  signal: AbortSignal;
  revisionOf?: DelegatedWorkRevision;
  workspaceKind: CollaborationWorkspaceKind;
}): Promise<DocumentCollaborationResponse> {
  const assessmentPrompts = buildDelegatedWorkAssessmentPrompts({
    course: input.course,
    studentId: input.student.id,
    studentName: input.student.name,
    stageKey: input.stageKey,
    request: input.request,
    documentText: input.documentText,
    history: input.history,
    revisionOf: input.revisionOf,
  });
  const assessmentRaw = await callDelegatedWorkModel([
    { role: "system", content: withWorkspaceInstruction(assessmentPrompts.system, input.workspaceKind) },
    { role: "user", content: assessmentPrompts.user },
  ], input.signal);
  const assessment = normalizeDelegatedWorkAssessment(
    parseLLMJson(assessmentRaw) as Record<string, unknown>,
  );
  if (assessment.decision !== "accepted") {
    return assessmentToBoundaryResponse(assessment);
  }

  let researchContext = "";
  let sources: Array<{ title: string; url: string; note: string }> = [];
  let researchMode: "web" | "model" | "none" = "model";
  if (assessment.needsWebResearch) {
    const courseMode = normalizePblCourseConfig(input.course.pblConfig).resourceInquiryMode;
    const searchConfig = courseMode === "web-search"
      ? resolveClassroomWebSearchConfig({})
      : undefined;
    if (!searchConfig || !assessment.searchQuery) {
      return unavailableResearchResponse(assessment);
    }
    let searchResult: Awaited<ReturnType<typeof searchWeb>>;
    try {
      searchResult = await searchWeb({
        ...searchConfig,
        query: assessment.searchQuery,
        maxResults: 6,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return researchTemporarilyUnavailableResponse(assessment);
    }
    if (!searchResult.sources.length) {
      return researchTemporarilyUnavailableResponse(assessment);
    }
    researchContext = formatSearchResultsAsContext(searchResult);
    sources = searchResult.sources.slice(0, 8).map((source) => ({
      title: boundedString(source.title, 180) || "资料来源",
      url: boundedString(source.url, 800),
      note: boundedString(source.content, 320),
    })).filter((source) => /^https?:\/\//i.test(source.url));
    researchMode = "web";
  }

  const executionPrompts = buildDelegatedWorkExecutionPrompts({
    course: input.course,
    studentId: input.student.id,
    stageKey: input.stageKey,
    request: input.request,
    documentText: input.documentText,
    assessment,
    history: input.history,
    researchContext,
    revisionOf: input.revisionOf,
  });
  const deliveryRaw = await callDelegatedWorkModel([
    { role: "system", content: withWorkspaceInstruction(executionPrompts.system, input.workspaceKind) },
    { role: "user", content: executionPrompts.user },
  ], input.signal);
  return normalizeDelegatedWorkDelivery({
    raw: parseLLMJson(deliveryRaw) as Record<string, unknown>,
    assessment,
    sources,
    researchMode,
  });
}

function collaborationFailureResponse(
  error: unknown,
  intent?: DocumentCollaborationIntent,
): Response {
  if (error instanceof LlmRateLimitError) {
    const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return Response.json(
      {
        error: "AI_COLLABORATION_RATE_LIMITED",
        message: `AI 服务当前请求较多，请在 ${retryAfterSeconds} 秒后重试。本次没有修改文档。`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }
  if (error instanceof LlmTimeoutError) {
    return Response.json(
      {
        error: "AI_COLLABORATION_TIMEOUT",
        message: "AI 组员本次思考超时，请重新发送任务。本次没有修改文档。",
      },
      { status: 504 },
    );
  }
  if (error instanceof LlmNotConfiguredError) {
    return Response.json(
      {
        error: "AI_COLLABORATION_NOT_CONFIGURED",
        message: "AI 服务尚未配置，请联系教师或系统管理员。本次没有修改文档。",
      },
      { status: 503 },
    );
  }
  if (error instanceof LlmCallFailedError) {
    if (error.status === 400) {
      return Response.json(
        {
          error: "AI_COLLABORATION_INPUT_REJECTED",
          message: intent === "delegate"
            ? "当前工作范围过大或描述不够明确。请把它缩小为一项可核验的辅助工作后重试；本次没有修改文档。"
            : "当前任务内容未被模型接受。请缩小选区或新建对话后重试；本次没有修改文档。",
        },
        { status: 422 },
      );
    }
    return Response.json(
      {
        error: "AI_COLLABORATION_UPSTREAM_FAILED",
        message: "AI 服务刚才出现短暂波动，请重新发送任务。本次没有修改文档。",
      },
      { status: error.status === 429 ? 429 : 503 },
    );
  }
  return Response.json(
    {
      error: "AI_COLLABORATION_FAILED",
      message: "AI 组员暂时无法回应，请稍后重试。本次没有修改文档。",
    },
    { status: 503 },
  );
}

function upstreamFailureCategory(error: unknown): string | undefined {
  if (!(error instanceof LlmCallFailedError)) return undefined;
  const summary = error.upstreamSummary.toLowerCase();
  if (/context|token|maximum.{0,20}length|too long|上下文|长度/.test(summary)) {
    return "context-limit";
  }
  if (/content|safety|moderation|policy|敏感|审核/.test(summary)) {
    return "content-policy";
  }
  if (/parameter|invalid|request|参数/.test(summary)) return "invalid-request";
  return error.status === 400 ? "input-rejected" : "upstream-failure";
}

async function callCollaborationModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await callLLM(messages, {
      jsonMode: true,
      abortSignal: signal,
      maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
    });
  } catch (error) {
    if (!(error instanceof LlmJsonModeUnsupportedError)) throw error;
    return callLLM(messages, {
      jsonMode: false,
      abortSignal: signal,
      maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
    });
  }
}

async function callDelegatedWorkModel(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await callCollaborationModel(messages, signal);
  } catch (error) {
    if (!(error instanceof LlmCallFailedError) || error.status !== 400) throw error;
    // Some OpenAI-compatible endpoints report JSON-mode incompatibility as a
    // generic HTTP 400. Retry the same bounded task once without JSON mode.
    return callLLM(messages, {
      jsonMode: false,
      abortSignal: signal,
      maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
    });
  }
}

async function authenticateStudent(
  request: Request,
  courseId: string,
  requestedStudentId: string,
): Promise<{ claims: StudentClaims | null; studentId: string } | Response> {
  return authenticateLegacyAiStudent(request, courseId, requestedStudentId);
}

async function loadCollaborationScope(input: {
  request: Request;
  courseId: string;
  requestedStudentId: string;
  stageKey: string;
  workspaceKind: CollaborationWorkspaceKind;
}) {
  if (!COLLABORATION_STAGE_KEYS.has(input.stageKey)) {
    return Response.json(
      { error: "STAGE_NOT_SUPPORTED", message: "AI 协作实验目前仅支持方案与制作阶段。" },
      { status: 400 },
    );
  }
  const authentication = await authenticateStudent(
    input.request,
    input.courseId,
    input.requestedStudentId,
  );
  if (authentication instanceof Response) return authentication;
  const course = await getCourse(input.courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const configuredMode = normalizePblCourseConfig(course.pblConfig).makeArtifactMode;
  if (input.workspaceKind === "external-artifact") {
    if (input.stageKey !== "make" || configuredMode !== "other") {
      return Response.json(
        { error: "WORKSPACE_NOT_AVAILABLE", message: "当前课程尚未开放其他成果协作空间。" },
        { status: 409 },
      );
    }
  } else if (input.stageKey === "make" && configuredMode === "other") {
    return Response.json(
      { error: "WORKSPACE_CHANGED", message: "当前课程已切换为其他成果协作空间，请重新进入项目实践。" },
      { status: 409 },
    );
  }
  const student = course.students.find((item) => item.id === authentication.studentId);
  if (!student) {
    return Response.json({ error: "STUDENT_NOT_IN_COURSE" }, { status: 403 });
  }
  const activeStageKey = course.stages[course.currentStageIndex]?.key;
  if (activeStageKey !== input.stageKey) {
    return Response.json(
      { error: "STAGE_CHANGED", message: "课堂阶段已经变化，请返回课堂后重新进入 AI 协作。" },
      { status: 409 },
    );
  }
  return { authentication, course, student };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = boundedString(url.searchParams.get("courseId"), 120);
  const studentId = boundedString(url.searchParams.get("studentId"), 120);
  const stageKey = boundedString(url.searchParams.get("stageKey"), 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(url.searchParams.get("workspaceKind"));
  if (!courseId || !stageKey) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadCollaborationScope({
    request,
    courseId,
    requestedStudentId: studentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;
  const thread = await getCompanionThread(
    courseId,
    scope.student.id,
    collaborationThreadKey(stageKey, workspaceKind),
  );
  const commentStore = await getCompanionThread(
    courseId,
    scope.student.id,
    documentCommentThreadKey(stageKey, workspaceKind),
  );
  const conversationId = activeConversationId(thread?.messages ?? []);
  const messages = visibleConversationMessages(thread?.messages ?? [], conversationId)
    .slice(-40);
  return Response.json({
    messages,
    conversationId,
    workspaceKind,
    commentThreads: documentCommentThreads(commentStore?.messages ?? []),
    reviewedParagraphFingerprints: documentReviewedParagraphFingerprints(
      commentStore?.messages ?? [],
    ),
  });
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const courseId = boundedString(url.searchParams.get("courseId"), 120);
  const requestedStudentId = boundedString(url.searchParams.get("studentId"), 120);
  const stageKey = boundedString(url.searchParams.get("stageKey"), 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(url.searchParams.get("workspaceKind"));
  const messageId = boundedString(url.searchParams.get("messageId"), 160);
  const requestedConversationId = boundedString(url.searchParams.get("conversationId"), 160);
  if (!courseId || !stageKey || !messageId || !requestedConversationId) {
    return Response.json({ error: "MISSING_PARAMETERS" }, { status: 400 });
  }
  const scope = await loadCollaborationScope({
    request,
    courseId,
    requestedStudentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;
  const thread = await getCompanionThread(courseId, scope.student.id, collaborationThreadKey(stageKey, workspaceKind));
  const currentConversationId = activeConversationId(thread?.messages ?? []);
  if (requestedConversationId !== currentConversationId) {
    return Response.json(
      { error: "CONVERSATION_CHANGED", message: "当前对话已经变化，请刷新后重试。" },
      { status: 409 },
    );
  }
  const changed = await softDeleteCompanionMessage({
    courseId,
    studentId: scope.student.id,
    stageKey: collaborationThreadKey(stageKey, workspaceKind),
    messageId,
    conversationId: currentConversationId,
  });
  return Response.json({ ok: true, changed });
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let body: DocumentCollaborationRequest;
  try {
    body = await request.json() as DocumentCollaborationRequest;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const courseId = boundedString(body.courseId, 120);
  const requestedStudentId = boundedString(body.studentId, 120);
  const stageKey = boundedString(body.stageKey, 80);
  const workspaceKind = normalizeCollaborationWorkspaceKind(body.workspaceKind);
  const action = boundedString(body.action, 80);
  const message = boundedString(body.message, 1_200);
  const documentHtml = boundedString(body.documentHtml, MAX_DOCUMENT_HTML_LENGTH);
  const selectedText = boundedString(body.selectedText, 12_000);
  const proactive = body.proactive === true;
  const commentThreadId = boundedString(body.commentThreadId, 160);
  const targetText = boundedString(body.targetText, 3_000);
  const blockIndex = Number(body.blockIndex);
  const blockId = boundedString(body.blockId, 160) || undefined;
  const proactiveParagraphs = parseProactiveParagraphs(body.paragraphs);
  const contributionId = boundedString(body.contributionId, 160) || undefined;
  if (!courseId || !stageKey) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!action && (!message || !isDocumentCollaborationIntent(body.intent))) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (selectedText.length >= 6_000) {
    return Response.json(
      { error: "SELECTION_TOO_LONG", message: "一次最多处理约 6000 字，请缩小选区后再布置任务。" },
      { status: 413 },
    );
  }
  if (body.intent === "edit" && !selectedText) {
    return Response.json(
      { error: "SELECTION_REQUIRED", message: "请先在文档中选中需要 AI 协作修改的文字。" },
      { status: 422 },
    );
  }

  const scope = await loadCollaborationScope({
    request,
    courseId,
    requestedStudentId,
    stageKey,
    workspaceKind,
  });
  if (scope instanceof Response) return scope;

  const thread = await getCompanionThread(
    courseId,
    scope.student.id,
    collaborationThreadKey(stageKey, workspaceKind),
  );
  const currentConversationId = activeConversationId(thread?.messages ?? []);
  if (action === "reset-conversation") {
    const conversationId = `ai-conversation-${randomUUID()}`;
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: collaborationThreadKey(stageKey, workspaceKind),
      messages: [companionMessage({
        role: "system-trigger",
        content: "学生在 AI 协作界面开始了新对话；此前记录保留用于学习过程分析。",
        visibility: "teacher-only",
        triggerKind: "conversation-reset",
        conversationId,
        authorName: "系统",
      })],
    });
    await recordInteractionEvents([{
      courseId,
      studentId: scope.student.id,
      stageKey,
      conversationId,
      source: "system",
      eventType: "comment",
      actorRole: "system",
      content: "学生开始了新的 AI 协作对话，旧记录保留。",
      payload: { action: "reset-conversation" },
      requestId,
    }], workspaceKind);
    return Response.json({ ok: true, conversationId, workspaceKind });
  }
  if (action === "read-document-comment") {
    if (!commentThreadId) {
      return Response.json({ error: "INVALID_COMMENT_THREAD" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = documentCommentThreads(commentStore?.messages ?? [])
      .find((item) => item.id === commentThreadId);
    if (!existing) {
      return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    }
    const latestAssistantAt = existing.comments
      .filter((comment) => comment.role === "assistant")
      .map((comment) => comment.createdAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (existing.readAt && latestAssistantAt && Date.parse(existing.readAt) >= Date.parse(latestAssistantAt)) {
      return Response.json({ ok: true, readAt: existing.readAt });
    }
    const readAt = new Date().toISOString();
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: documentCommentThreadKey(stageKey, workspaceKind),
      messages: [companionMessage({
        role: "system-trigger",
        content: `${COMMENT_READ_PREFIX}${JSON.stringify({ id: commentThreadId, readAt })}`,
        visibility: "teacher-only",
        triggerKind: "document-comment-read",
        conversationId: commentThreadId,
        authorName: "系统",
      })],
    });
    return Response.json({ ok: true, readAt });
  }
  const userKey = scope.authentication.claims?.sub || getClientIp(request);
  const limit = companionLimiter.check(rateLimitKey(request, userKey));
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  if (action === "proactive-document-comments") {
    if (!proactiveParagraphs.length) {
      return Response.json({ error: "INVALID_COMMENT_TARGETS" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existingMessages = commentStore?.messages ?? [];
    const existingThreads = documentCommentThreads(existingMessages);
    const reviewedFingerprints = new Set(
      documentReviewedParagraphFingerprints(existingMessages),
    );
    const threadMatchesCandidate = (
      thread: DocumentAiCommentThread,
      candidate: ProactiveParagraph,
    ) => {
      if (candidate.blockId && thread.blockId && candidate.blockId === thread.blockId) return true;
      if (candidate.blockIndex === thread.blockIndex) return true;
      const previousBlockText = thread.blockText?.replace(/\s+/g, " ").trim();
      const currentBlockText = candidate.targetText.replace(/\s+/g, " ").trim();
      return Boolean(
        previousBlockText
        && currentBlockText
        && (
          previousBlockText.includes(thread.targetText)
          && currentBlockText.includes(thread.targetText)
        )
      );
    };
    const candidates = proactiveParagraphs
      .filter((candidate) =>
        !reviewedFingerprints.has(documentParagraphVersionFingerprint(candidate.targetText))
      )
      .map((candidate) => ({
        ...candidate,
        existingComments: existingThreads
          .filter((thread) => threadMatchesCandidate(thread, candidate))
          .flatMap((thread) => thread.comments
            .filter((comment) => comment.role === "assistant")
            .map((comment) => comment.content)),
      }));
    if (!candidates.length) return Response.json({ commentThreads: [] });

    try {
      const reviewResults: ReturnType<typeof normalizeBatchProactiveDocumentComments> = [];
      const reviewErrors: unknown[] = [];
      for (const reviewFocus of ["language", "reasoning"] as const) {
        const prompts = buildBatchProactiveDocumentCommentPrompts({
          course: scope.course,
          studentId: scope.student.id,
          stageKey,
          documentText: documentHtmlToPlainText(documentHtml),
          candidates,
          reviewFocus,
        });
        try {
          const raw = await callCollaborationModel([
            { role: "system", content: withWorkspaceInstruction(prompts.system, workspaceKind) },
            { role: "user", content: prompts.user },
          ], request.signal);
          reviewResults.push(...normalizeBatchProactiveDocumentComments(
            parseLLMJson(raw),
            candidates,
          ));
        } catch (error) {
          reviewErrors.push(error);
        }
      }
      if (reviewErrors.length === 2) throw reviewErrors[0];

      const seenResults = new Set<string>();
      const resultsById = new Map<string, typeof reviewResults>();
      reviewResults.forEach((result) => {
        const existingResults = resultsById.get(result.candidateId) ?? [];
        if (existingResults.some((existing) => areDocumentCommentIssuesEquivalent(
          { issueType: existing.issueType, targetText: existing.quotedText },
          { issueType: result.issueType, targetText: result.quotedText },
        ))) return;
        const fingerprint = `${result.candidateId}:${result.issueType}:${result.quotedText.replace(/\s+/g, "")}`;
        if (seenResults.has(fingerprint)) return;
        seenResults.add(fingerprint);
        existingResults.push(result);
        resultsById.set(result.candidateId, existingResults);
      });
      const messages: CompanionMessage[] = [];
      const commentThreads: DocumentAiCommentThread[] = [];
      candidates.forEach((candidate) => {
        (resultsById.get(candidate.candidateId) ?? []).forEach((result) => {
          const repeatsExistingIssue = existingThreads
            .filter((thread) => threadMatchesCandidate(thread, candidate))
            .some((thread) => areDocumentCommentIssuesEquivalent(
              { issueType: thread.issueType, targetText: thread.targetText },
              { issueType: result.issueType, targetText: result.quotedText },
            ));
          if (repeatsExistingIssue) return;
          const id = `document-comment-${randomUUID()}`;
          const createdAt = new Date().toISOString();
          const meta: DocumentCommentMeta = {
            id,
            blockId: candidate.blockId,
            blockIndex: candidate.blockIndex,
            blockText: candidate.targetText,
            targetText: result.quotedText,
            issueType: result.issueType,
            createdAt,
            reviewVersion: DOCUMENT_COMMENT_REVIEW_VERSION,
          };
          const metaMessage = companionMessage({
            role: "system-trigger",
            content: encodeDocumentCommentMeta(meta),
            visibility: "teacher-only",
            triggerKind: "document-saved",
            conversationId: id,
            authorName: "系统",
          });
          const agentMessage = companionMessage({
            role: "agent",
            content: result.comment,
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
              content: result.comment,
              createdAt: agentMessage.createdAt,
            }],
          });
        });
      });
      if (!reviewErrors.length) {
        candidates.forEach((candidate) => {
          const fingerprint = documentParagraphVersionFingerprint(candidate.targetText);
          messages.push(companionMessage({
            role: "system-trigger",
            content: encodeDocumentReviewCheckpoint({
              fingerprint,
              blockId: candidate.blockId,
              blockIndex: candidate.blockIndex,
              reviewedAt: new Date().toISOString(),
              reviewVersion: DOCUMENT_COMMENT_REVIEW_VERSION,
            }),
            visibility: "teacher-only",
            triggerKind: "document-saved",
            conversationId: `review-${fingerprint}`,
            authorName: "系统",
          }));
          reviewedFingerprints.add(fingerprint);
        });
      }
      if (messages.length) {
        await appendCompanionMessages({
          courseId,
          studentId: scope.student.id,
          stageKey: documentCommentThreadKey(stageKey, workspaceKind),
          messages,
        });
        // Every paragraph comment is an independent contextual conversation.
        // Persist its opening AI message under the comment thread id so later
        // student replies continue the same audit turn instead of starting at
        // the student's first reply or merging unrelated comments together.
        await recordInteractionEvents(commentThreads.map((thread) => ({
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: thread.id,
          source: "proactive-comment" as const,
          eventType: "comment" as const,
          actorRole: "ai" as const,
          content: thread.comments.find((comment) => comment.role === "assistant")?.content
            ?? "AI 组员发起了段落批注。",
          payload: {
            commentThreadId: thread.id,
            blockId: thread.blockId,
            blockIndex: thread.blockIndex,
            issueType: thread.issueType,
            targetText: thread.targetText,
            initialComment: true,
            candidateCount: candidates.length,
          },
          requestId,
        })), workspaceKind);
      }
      return Response.json({
        commentThreads,
        reviewedParagraphFingerprints: [...reviewedFingerprints],
      });
    } catch (error) {
      if (request.signal.aborted) {
        return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      }
      return collaborationFailureResponse(error, "check");
    }
  }

  if (action === "proactive-document-comment") {
    if (!targetText || !Number.isInteger(blockIndex) || blockIndex < 0) {
      return Response.json({ error: "INVALID_COMMENT_TARGET" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = documentCommentThreads(commentStore?.messages ?? [])
      .find((item) => {
        if (blockId && item.blockId) return item.blockId === blockId;
        return item.blockIndex === blockIndex
          && item.targetText.replace(/\s+/g, " ").trim() === targetText.replace(/\s+/g, " ").trim();
      });
    if (existing) return Response.json({ commentThread: existing, existing: true });

    const prompts = buildProactiveDocumentCommentPrompts({
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      documentText: documentHtmlToPlainText(documentHtml),
      targetText,
    });
    try {
      const raw = await callCollaborationModel([
        { role: "system", content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user", content: prompts.user },
      ], request.signal);
      const result = normalizeProactiveDocumentComment(parseLLMJson(raw));
      if (!result.shouldComment) return Response.json({ commentThread: null });

      const id = `document-comment-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const meta: DocumentCommentMeta = { id, blockId, blockIndex, targetText, createdAt };
      const messages = [
        companionMessage({
          role: "system-trigger",
          content: encodeDocumentCommentMeta(meta),
          visibility: "teacher-only",
          triggerKind: "document-saved",
          conversationId: id,
          authorName: "系统",
        }),
        companionMessage({
          role: "agent",
          content: result.comment,
          visibility: "student-and-teacher",
          companionId: "critic",
          conversationId: id,
          authorName: "AI 组员",
        }),
      ];
      await appendCompanionMessages({
        courseId,
        studentId: scope.student.id,
        stageKey: documentCommentThreadKey(stageKey, workspaceKind),
        messages,
      });
      await recordInteractionEvents([{
        courseId,
        studentId: scope.student.id,
        stageKey,
        conversationId: id,
        source: "proactive-comment",
        eventType: "comment",
        actorRole: "ai",
        content: result.comment,
        payload: { commentThreadId: id, blockIndex, blockId, targetText, initialComment: true },
        requestId,
      }], workspaceKind);
      return Response.json({
        commentThread: {
          ...meta,
          comments: [{
            id: messages[1].id,
            role: "assistant",
            content: result.comment,
            createdAt: messages[1].createdAt,
          }],
        } satisfies DocumentAiCommentThread,
      });
    } catch (error) {
      if (request.signal.aborted) {
        return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      }
      return collaborationFailureResponse(error, "check");
    }
  }
  if (action === "reply-document-comment") {
    if (!commentThreadId || !message) {
      return Response.json({ error: "INVALID_COMMENT_REPLY" }, { status: 400 });
    }
    const commentStore = await getCompanionThread(
      courseId,
      scope.student.id,
      documentCommentThreadKey(stageKey, workspaceKind),
    );
    const existing = documentCommentThreads(commentStore?.messages ?? [])
      .find((item) => item.id === commentThreadId);
    if (!existing) {
      return Response.json({ error: "COMMENT_THREAD_NOT_FOUND" }, { status: 404 });
    }
    const commentPolicy = evaluateAiWorkPolicy({
      intent: "check",
      request: message,
      scope: "paragraph",
      hasStudentArtifact: Boolean(targetText || existing.blockText || existing.targetText),
      proactive: true,
      selectedText: existing.targetText,
    });
    const commentBoundary = protectedBoundaryForPolicy(commentPolicy, message);
    const prompts = buildDocumentCommentReplyPrompts({
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      documentText: documentHtmlToPlainText(documentHtml),
      targetText: existing.targetText,
      history: existing.comments,
      studentReply: message,
      protectedBoundary: commentBoundary,
    });
    try {
      const raw = await callCollaborationModel([
        { role: "system", content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user", content: prompts.user },
      ], request.signal);
      const reply = normalizeDocumentCommentReply(
        parseLLMJson(raw),
        existing.targetText,
        commentBoundary,
      );
      if (!reply) throw new Error("EMPTY_DOCUMENT_COMMENT_REPLY");
      const studentMessage = companionMessage({
        role: "student",
        content: message,
        visibility: "student-and-teacher",
        authorId: scope.student.id,
        authorName: scope.student.name,
        conversationId: commentThreadId,
      });
      const agentMessage = companionMessage({
        role: "agent",
        content: reply.message,
        visibility: "student-and-teacher",
        companionId: "critic",
        authorName: "AI 组员",
        conversationId: commentThreadId,
      });
      const messages = [
        studentMessage,
        agentMessage,
        ...(reply.suggestion ? [companionMessage({
          role: "system-trigger",
          content: `${COMMENT_SUGGESTION_PREFIX}${JSON.stringify(reply.suggestion)}`,
          visibility: "teacher-only",
          triggerKind: "document-saved",
          authorName: "系统",
          conversationId: commentThreadId,
        })] : []),
      ];
      await appendCompanionMessages({
        courseId,
        studentId: scope.student.id,
        stageKey: documentCommentThreadKey(stageKey, workspaceKind),
        messages,
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
          payload: { commentThreadId, targetText: existing.targetText },
          requestId,
        },
        {
          courseId,
          studentId: scope.student.id,
          stageKey,
          conversationId: commentThreadId,
          source: "proactive-comment",
          eventType: reply.suggestion ? "proposal" : "response",
          actorRole: "ai",
          content: reply.message,
          payload: { commentThreadId, contributionId, kind: reply.kind, suggestion: reply.suggestion ?? null },
          requestId,
        },
      ], workspaceKind);
      return Response.json({
        commentThread: {
          ...existing,
          comments: [
            ...existing.comments,
            {
              id: studentMessage.id,
              role: "student",
              content: studentMessage.content,
              createdAt: studentMessage.createdAt,
            },
            {
              id: agentMessage.id,
              role: "assistant",
              content: agentMessage.content,
              createdAt: agentMessage.createdAt,
            },
          ],
        } satisfies DocumentAiCommentThread,
        result: reply,
      });
    } catch (error) {
      if (request.signal.aborted) {
        return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      }
      return collaborationFailureResponse(error, "discuss");
    }
  }
  if (action === "suggest-delegated-work") {
    const prompts = buildDelegatedWorkStarterPrompts({
      course: scope.course,
      studentId: scope.student.id,
      stageKey,
      documentText: documentHtmlToPlainText(documentHtml),
    });
    try {
      const raw = await callDelegatedWorkModel([
        { role: "system", content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user", content: prompts.user },
      ], request.signal);
      const candidates = normalizeDelegatedWorkStarters(parseLLMJson(raw));
      if (!candidates.length) return Response.json({ starters: [] });
      const reviewPrompts = buildDelegatedWorkStarterReviewPrompts({
        course: scope.course,
        studentId: scope.student.id,
        stageKey,
        documentText: documentHtmlToPlainText(documentHtml),
        candidates,
      });
      const reviewedRaw = await callDelegatedWorkModel([
        { role: "system", content: withWorkspaceInstruction(reviewPrompts.system, workspaceKind) },
        { role: "user", content: reviewPrompts.user },
      ], request.signal);
      const reviewed = normalizeDelegatedWorkStarters(parseLLMJson(reviewedRaw));
      await recordInteractionEvents([{
        courseId: scope.course.id,
        studentId: scope.student.id,
        stageKey,
        source: "sidebar",
        eventType: "response",
        actorRole: "ai",
        content: reviewed.join("\n"),
        payload: { action: "suggest-delegated-work", starters: reviewed },
        requestId,
      }], workspaceKind);
      return Response.json({ starters: reviewed });
    } catch (error) {
      if (request.signal.aborted) {
        return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
      }
      return collaborationFailureResponse(error, "delegate");
    }
  }
  if (action) {
    return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
  }
  if (!message || !isDocumentCollaborationIntent(body.intent)) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const intent = body.intent;
  // A selection-triggered request is always local. Older clients may still
  // label an organise/collect request as `delegate`; reinterpret that label
  // here so a stale browser can never escalate a selected paragraph into a
  // document-wide delegated operation.
  const effectiveIntent: DocumentCollaborationIntent = selectedText && intent === "delegate"
    ? "organize"
    : intent;
  const requestedConversationId = boundedString(body.conversationId, 160);
  if (requestedConversationId && requestedConversationId !== currentConversationId) {
    return Response.json(
      {
        error: "CONVERSATION_CHANGED",
        message: "当前对话已经更新，请重新发送。本次没有修改文档。",
        conversationId: currentConversationId,
      },
      { status: 409 },
    );
  }

  // The server, not the browser, owns the model context. This prevents old,
  // cleared, or client-injected turns from leaking back into a new task.
  const history = modelConversationHistory(thread?.messages ?? [], currentConversationId);
  const documentText = documentHtmlToPlainText(documentHtml);
  const revisionOf = parseDelegatedWorkRevision(body.revisionOf);
  const policyDecision: AiWorkPolicyDecision = evaluateAiWorkPolicy({
    intent: effectiveIntent,
    request: message,
    scope: selectedText ? "selection" : "document",
    hasStudentArtifact: Boolean(documentText),
    selectedText,
  });
  const protectedBoundary = protectedBoundaryForPolicy(policyDecision, message);

  try {
    let result: DocumentCollaborationResponse;
    if (effectiveIntent === "delegate" && !protectedBoundary) {
      result = await executeDelegatedWork({
        course: scope.course,
        student: scope.student,
        stageKey,
        request: message,
        documentText,
        history,
        signal: request.signal,
        revisionOf,
        workspaceKind,
      });
    } else {
      const prompts = buildDocumentCollaborationPrompts({
        course: scope.course,
        studentId: scope.student.id,
        studentName: scope.student.name,
        stageKey,
        intent: effectiveIntent,
        request: message,
        documentText,
        selectedText,
        history,
        protectedBoundary,
        proactive,
      });
      let llmMessages = [
        { role: "system" as const, content: withWorkspaceInstruction(prompts.system, workspaceKind) },
        { role: "user" as const, content: prompts.user },
      ];
      let raw: string;
      try {
        raw = await callCollaborationModel(llmMessages, request.signal);
      } catch (error) {
        if (!(error instanceof LlmCallFailedError) || error.status !== 400) throw error;
        // A compatible endpoint can reject a dense prompt with HTTP 400. Retry
        // once with a smaller, history-light prompt before asking the student to
        // change anything. The current request and project boundary stay intact.
        const compactPrompts = buildDocumentCollaborationPrompts({
          course: scope.course,
          studentId: scope.student.id,
          studentName: scope.student.name,
          stageKey,
          intent: effectiveIntent,
          request: message,
          documentText,
          selectedText,
          history,
          protectedBoundary,
          proactive,
          compact: true,
        });
        llmMessages = [
          { role: "system" as const, content: withWorkspaceInstruction(compactPrompts.system, workspaceKind) },
          { role: "user" as const, content: compactPrompts.user },
        ];
        raw = await callLLM(llmMessages, {
          jsonMode: false,
          abortSignal: request.signal,
          maxTransientRetries: COLLABORATION_TRANSIENT_RETRIES,
        });
      }
      result = normalizeDocumentCollaborationResponse(
        parseLLMJson(raw) as Record<string, unknown>,
        selectedText,
        protectedBoundary,
        effectiveIntent,
      );
    }
    const companionId = companionForIntent(effectiveIntent);
    const assistantRecord = assistantRecordForResult(result);
    const persistedMessages = [
      ...(!proactive ? [companionMessage({
        role: "student" as const,
        content: message,
        visibility: "student-and-teacher" as const,
        authorId: scope.student.id,
        authorName: scope.student.name,
        conversationId: currentConversationId,
      })] : []),
      companionMessage({
        role: "agent",
        content: assistantRecord,
        visibility: "student-and-teacher",
        companionId,
        authorName: "AI 组员",
        conversationId: currentConversationId,
      }),
    ];
    await appendCompanionMessages({
      courseId,
      studentId: scope.student.id,
      stageKey: collaborationThreadKey(stageKey, workspaceKind),
      messages: persistedMessages,
    });
    const source = selectedText || intent === "edit" ? "selection" : "sidebar";
    await recordInteractionEvents([
      {
        courseId: scope.course.id,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "request",
        actorRole: "student",
        actorId: scope.student.id,
        content: message,
        payload: { intent, effectiveIntent, selectedText, documentLength: documentText.length },
        requestId,
      },
      {
        courseId: scope.course.id,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "policy",
        actorRole: "system",
        content: policyDecision.reason,
        payload: policyDecision as unknown as Record<string, unknown>,
        requestId,
      },
      {
        courseId: scope.course.id,
        studentId: scope.student.id,
        stageKey,
        conversationId: currentConversationId,
        source,
        eventType: "response",
        actorRole: "ai",
        content: assistantRecord,
        payload: {
          kind: result.kind,
          companionId,
          contributionId,
          suggestion: result.suggestion ?? null,
          deliverable: result.deliverable ?? null,
        },
        requestId,
      },
    ], workspaceKind);
    return Response.json({
      result,
      companionId,
      conversationId: currentConversationId,
      workspaceKind,
      messages: persistedMessages,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json({ error: "REQUEST_ABORTED" }, { status: 499 });
    }
    console.error(
      "[ai-collaboration/document] generation failed:",
      {
        name: error instanceof Error ? error.name : "UnknownError",
        status: error instanceof LlmCallFailedError ? error.status ?? "unknown" : undefined,
        category: upstreamFailureCategory(error),
      },
    );
    void recordInteractionEvents([{
      courseId: scope.course.id,
      studentId: scope.student.id,
      stageKey,
      conversationId: currentConversationId,
      source: selectedText || intent === "edit" ? "selection" : "sidebar",
      eventType: "error",
      actorRole: "system",
      content: error instanceof Error ? error.message : "AI 组员请求失败",
      payload: { intent, effectiveIntent },
      requestId,
    }], workspaceKind);
    return collaborationFailureResponse(error, effectiveIntent);
  }
}

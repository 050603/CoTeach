"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import {
  ArrowLeft,
  Check,
  FilePenLine,
  LoaderCircle,
  RefreshCcw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  PlateDocumentEditor,
  type PlateDocumentEditorHandle,
  type PlateDocumentSelection,
} from "@/components/plate-document-editor";
import { PrimaryButton } from "@/components/ui";
import { FinalArtifactSubmission } from "@/components/views/student/final-artifact-submission";
import { ExternalArtifactSubmission } from "@/components/views/student/external-artifact-submission";
import {
  AiMemberWorkspace,
  type AiMemberWorkspaceMessage,
} from "@/components/views/student/ai-member-workspace";
import type {
  DelegatedWorkDeliverable,
  DocumentCollaborationIntent,
  DocumentCollaborationResponse,
  DocumentCollaborationSuggestion,
} from "@/lib/ai-collaboration/document-policy";
import type {
  DocumentAiCommentReplyResult,
  DocumentAiCommentThread,
  DocumentBlockCandidate,
} from "@/lib/ai-collaboration/document-comment-types";
import { documentAiCommentStatus } from "@/lib/ai-collaboration/document-comment-types";
import {
  documentParagraphVersionFingerprint,
  DOCUMENT_COMMENT_REVIEW_BATCH_SIZE,
  DOCUMENT_COMMENT_REVIEW_VERSION,
  isReviewableDocumentParagraph,
} from "@/lib/ai-collaboration/document-comment-policy";
import type { AiContribution } from "@/lib/learning-evidence/types";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import { cn } from "@/lib/utils";
import { collaborationBackHref, inferStageCollectionMode } from "@/lib/system-mode";
import { DashboardTopBar } from "@/components/dashboard-shell";
import { StudentClassroomHeaderStatus } from "@/components/classroom/student-classroom-header-status";
import { useCoursePresence } from "@/hooks/use-course-presence";
import {
  EXTERNAL_ARTIFACT_COLLABORATION_TEMPLATE,
  type CollaborationWorkspaceKind,
} from "@/lib/ai-collaboration/workspace-kind";
import type { ProjectMemoryEntry, ProjectSupportDetails } from "@/lib/ai-collaboration/project-support-types";
import { useProjectMemory } from "@/components/views/student/use-project-memory";
import { documentVersionDigest } from "@/lib/ai-collaboration/document-version";

type CollaborationMessage = AiMemberWorkspaceMessage;

type DocumentRequestSnapshot = {
  requestId: string;
  messageId: string;
  contributionId: string;
  createdAt: string;
  conversationId: string;
  intent: DocumentCollaborationIntent;
  message: string;
  documentHtml: string;
  selection: PlateDocumentSelection | null;
  revisionOf?: DeliveryRevision | null;
};

type DocumentRequestPayload = {
  requestId?: string;
  status?: "processing" | "completed" | "failed" | "cancelled";
  retryAfterMs?: number;
  retryable?: boolean;
  error?: string;
  message?: string;
  result?: DocumentCollaborationResponse;
  companionId?: AiContribution["companionId"];
  conversationId?: string;
  documentVersion?: string;
  messages?: Array<{ id: string; role: string }>;
  memories?: ProjectMemoryEntry[];
};

type PendingSuggestion = {
  id: string;
  confirmationId: string;
  contribution: AiContribution;
  suggestion: DocumentCollaborationSuggestion;
  selection: PlateDocumentSelection | null;
  presentation: "inline" | "blocks";
  previewReady: boolean;
  sourceThreadId?: string;
  sourceCommentId?: string;
};

type PendingDelivery = {
  id: string;
  confirmationId: string;
  contribution: AiContribution;
  deliverable: DelegatedWorkDeliverable;
  error?: string | null;
};

type DeliveryRevision = {
  title: string;
  content: string;
};

type UndoableEdit = {
  title: string;
  beforeHtml: string;
  afterHtml: string;
  confirmationId: string;
  contribution: AiContribution;
  decisionId: string;
  conversationId: string;
  source: "sidebar" | "selection" | "proactive-comment";
};

type EditNotice = {
  kind: "applied" | "undone";
  title: string;
};

const MODIFICATION_INTENTS = new Set<DocumentCollaborationIntent>(["edit"]);
const WRITING_INTENTS = new Set<DocumentCollaborationIntent>(["edit", "organize", "delegate"]);
const PROACTIVE_REVIEW_SETTLE_MS = 20_000;
const PROACTIVE_REVIEW_JITTER_MS = 10_000;
const PROACTIVE_REVIEW_RETRY_BASE_MS = 30_000;
const PROACTIVE_REVIEW_RETRY_MAX_MS = 5 * 60_000;
const REQUEST_RECOVERY_MAX_MS = 120_000;

function pendingRequestStorageKey(scope: string): string {
  return `openpbl:document-collaboration:requests:${scope}`;
}

function requestFailureMessage(error?: string, message?: string, originalMessage?: string): string {
  if (error === "REQUEST_INTERRUPTED") return "这次回答中断了，你的消息已保留。可以重新尝试。";
  if (error === "REQUEST_ID_CONFLICT") return "这次请求的内容已变化。请编辑后作为新消息发送。";
  if (message && message !== originalMessage) return message;
  return "这次回答没能完成，你的消息已保留。可以重新尝试。";
}

function readPendingRequestSnapshots(scope: string): DocumentRequestSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(pendingRequestStorageKey(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DocumentRequestSnapshot => {
      if (!item || typeof item !== "object") return false;
      const snapshot = item as Partial<DocumentRequestSnapshot>;
      return typeof snapshot.requestId === "string"
        && typeof snapshot.messageId === "string"
        && typeof snapshot.contributionId === "string"
        && typeof snapshot.message === "string"
        && typeof snapshot.documentHtml === "string"
        && typeof snapshot.conversationId === "string"
        && typeof snapshot.createdAt === "string"
        && Date.now() - Date.parse(snapshot.createdAt) < 24 * 60 * 60_000;
    }).slice(-8);
  } catch {
    return [];
  }
}

function writePendingRequestSnapshots(scope: string, snapshots: DocumentRequestSnapshot[]): void {
  try {
    if (snapshots.length) {
      window.sessionStorage.setItem(pendingRequestStorageKey(scope), JSON.stringify(snapshots.slice(-8)));
    } else {
      window.sessionStorage.removeItem(pendingRequestStorageKey(scope));
    }
  } catch {
    // The server task remains authoritative if browser storage is unavailable.
  }
}

function plainTextLength(html: string): number {
  if (typeof window === "undefined") return html.replace(/<[^>]*>/g, " ").trim().length;
  const node = window.document.createElement("div");
  node.innerHTML = html;
  return (node.textContent ?? "").replace(/\s+/g, "").length;
}

function isCommentThreadAnchored(thread: DocumentAiCommentThread, candidates: DocumentBlockCandidate[]): boolean {
  const expected = (thread.blockText ?? thread.targetText).replace(/\s+/g, " ").trim();
  const matches = (candidate: DocumentBlockCandidate | undefined) => Boolean(candidate
    && candidate.text.includes(thread.targetText)
    && (!thread.blockText || candidate.text.replace(/\s+/g, " ").trim() === expected));
  if (thread.blockId) return matches(candidates.find((candidate) => candidate.blockId === thread.blockId));
  if (matches(candidates.find((candidate) => candidate.blockIndex === thread.blockIndex))) return true;
  return Boolean(thread.blockText && candidates.filter(matches).length === 1);
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function inferMemberIntent(request: string, selectedText?: string): DocumentCollaborationIntent {
  const value = request.replace(/\s+/g, "");
  if (selectedText && /(?:改|润色|校对|重写|精简|扩写|调整表达|格式|纠正)/.test(value)) {
    return "edit";
  }
  if (/(?:整理|归纳|查找|检索|补充资料|资料|来源|列出|做一份|生成清单|分组|排版)/.test(value)) {
    return "delegate";
  }
  if (/(?:检查|审阅|找问题|哪里不|是否完整|逻辑)/.test(value)) return "check";
  if (/(?:总结|梳理进展|概括)/.test(value)) return "summarize";
  return "discuss";
}

export function DocumentAiCollaboration({
  courseId,
  workspaceKind = "document",
}: {
  courseId: string;
  workspaceKind?: CollaborationWorkspaceKind;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const course = useCourse(courseId);
  const resolvedCourseId = course?.id;
  const session = useSession();
  const studentId = session.studentId ?? "";
  const stage = course?.stages[course.currentStageIndex];
  useCoursePresence({
    courseId: course?.id,
    role: "student",
    enabled: course?.status === "teaching",
    heartbeat: true,
  });
  const stageKey = stage?.key ?? "";
  const requestScope = `${resolvedCourseId ?? courseId}:${studentId}:${stageKey}:${workspaceKind}`;
  const isExternalArtifact = workspaceKind === "external-artifact";
  const workspaceNoun = isExternalArtifact ? "成果协作稿" : "文档";
  const supportedStage = stageKey === "make" && course?.status === "teaching";
  const projectMemory = useProjectMemory({
    courseId: resolvedCourseId ?? "",
    studentId,
    enabled: Boolean(resolvedCourseId && studentId && supportedStage),
  });
  const editorRef = useRef<PlateDocumentEditorHandle>(null);
  const submissionIdRef = useRef<string | undefined>(undefined);
  const submissionVersionRef = useRef(1);
  const loadedScopeRef = useRef("");
  const requestSnapshotsRef = useRef<Map<string, DocumentRequestSnapshot>>(new Map());
  const activeRequestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const recoveredRequestIdsRef = useRef<Set<string>>(new Set());
  const recoverRequestRef = useRef<((requestId: string) => void) | null>(null);
  const commentReplySnapshotRef = useRef(new Map<string, {
    requestId: string;
    contributionId: string;
    threadId: string;
    message: string;
    documentHtml: string;
  }>());
  const proactiveRequestRef = useRef<Set<string>>(new Set());
  const analyzedParagraphsRef = useRef<Set<string>>(new Set());
  const proactiveRetryTimerRef = useRef<number | null>(null);
  const proactiveRetryAttemptRef = useRef(0);
  const savedContentRef = useRef("");
  const currentDocumentRef = useRef("");
  const currentConversationRef = useRef("legacy");
  const [documentHtml, setDocumentHtml] = useState("");
  const [documentReady, setDocumentReady] = useState(false);
  const [selection, setSelection] = useState<PlateDocumentSelection | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [intent, setIntent] = useState<DocumentCollaborationIntent>("discuss");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [aiCommentThreads, setAiCommentThreads] = useState<DocumentAiCommentThread[]>([]);
  const [invalidCommentIds, setInvalidCommentIds] = useState<Set<string>>(new Set());
  const [commentStatusError, setCommentStatusError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState("legacy");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSuggestion, setPendingSuggestion] = useState<PendingSuggestion | null>(null);
  const [pendingDelivery, setPendingDelivery] = useState<PendingDelivery | null>(null);
  const [deliveryRevision, setDeliveryRevision] = useState<DeliveryRevision | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [undoableEdit, setUndoableEdit] = useState<UndoableEdit | null>(null);
  const [editNotice, setEditNotice] = useState<EditNotice | null>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [quickIntent, setQuickIntent] = useState<DocumentCollaborationIntent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [proactiveReviewRetry, setProactiveReviewRetry] = useState(0);
  const [proactiveReviewEnabled, setProactiveReviewEnabled] = useState(true);
  const [submittedVersion, setSubmittedVersion] = useState<{
    sequence: number;
    submittedAt?: string;
    downloadUrl: string;
  } | null>(null);

  const group = course?.groups?.find((item) =>
    item.members.some((member) => member.studentId === studentId));
  const existingDocument = !course || !studentId || !supportedStage
    ? undefined
    : [...(course.submissions ?? [])]
      .filter((item) =>
        item.stageKey === stageKey
        && item.type === (isExternalArtifact ? "artifact-brief" : "document")
        && (
          item.studentId === studentId
          || Boolean(group?.id && item.groupId === group.id)
        ))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const documentTitle = isExternalArtifact
    ? "成果协作稿"
    : stageKey === "proposal"
      ? "项目方案协作文档"
      : "项目成果协作文档";
  const projectTitle = (course ? getCourseStageRequirements(course, stageKey)?.drivingQuestion : "")
    || course?.drivingQuestion
    || group?.topic
    || course?.name
    || documentTitle;
  const canSubmitFinal = stageKey === "make" && !isExternalArtifact;

  useEffect(() => {
    if (!editNotice) return;
    const timer = window.setTimeout(
      () => setEditNotice(null),
      editNotice.kind === "applied" ? 5_000 : 3_000,
    );
    return () => window.clearTimeout(timer);
  }, [editNotice]);

  const scheduleProactiveReviewWake = useCallback((delayMs: number) => {
    if (proactiveRetryTimerRef.current !== null) return;
    proactiveRetryTimerRef.current = window.setTimeout(() => {
      proactiveRetryTimerRef.current = null;
      setProactiveReviewRetry((current) => current + 1);
    }, delayMs);
  }, []);

  const scheduleProactiveReviewRetry = useCallback((minimumDelayMs = 0) => {
    if (proactiveRetryTimerRef.current !== null) return;
    const exponentialDelay = Math.min(
      PROACTIVE_REVIEW_RETRY_MAX_MS,
      PROACTIVE_REVIEW_RETRY_BASE_MS * (2 ** proactiveRetryAttemptRef.current),
    );
    proactiveRetryAttemptRef.current = Math.min(proactiveRetryAttemptRef.current + 1, 4);
    scheduleProactiveReviewWake(
      Math.max(minimumDelayMs, exponentialDelay)
      + Math.floor(Math.random() * PROACTIVE_REVIEW_JITTER_MS),
    );
  }, [scheduleProactiveReviewWake]);

  useEffect(() => () => {
    if (proactiveRetryTimerRef.current !== null) {
      window.clearTimeout(proactiveRetryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (session.joinedCourseId && session.joinedCourseId !== courseId) {
      router.replace("/student");
    }
  }, [courseId, hydrated, router, session.joinedCourseId]);

  useEffect(() => {
    if (!course || !studentId || !supportedStage) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${workspaceKind}`;
    if (loadedScopeRef.current === scopeKey) return;
    loadedScopeRef.current = scopeKey;
    const initialContent = existingDocument?.content
      ?? (isExternalArtifact ? EXTERNAL_ARTIFACT_COLLABORATION_TEMPLATE : "");
    submissionIdRef.current = existingDocument?.id;
    submissionVersionRef.current = existingDocument?.version ?? 1;
    // A new external workspace starts with a real, editable proxy draft.  Mark
    // it unsaved once so the normal autosave persists the template exactly once;
    // subsequent refreshes load that submission instead of reinserting it.
    savedContentRef.current = existingDocument ? initialContent : (isExternalArtifact ? "" : initialContent);
    setDocumentHtml(initialContent);
    currentDocumentRef.current = initialContent;
    setDocumentReady(true);
    setSaveStatus(existingDocument || !isExternalArtifact ? "saved" : "unsaved");
    setSelection(null);
    setPendingSuggestion(null);
    setPendingDelivery(null);
    setDeliveryRevision(null);
    proactiveRequestRef.current = new Set();
    analyzedParagraphsRef.current = new Set();
    proactiveRetryAttemptRef.current = 0;
    setAiCommentThreads([]);
    setUndoableEdit(null);
    requestSnapshotsRef.current = new Map(readPendingRequestSnapshots(scopeKey).map((snapshot) => [snapshot.requestId, snapshot]));
  }, [course, existingDocument, existingDocument?.content, existingDocument?.id, existingDocument?.version, isExternalArtifact, stageKey, studentId, supportedStage, workspaceKind]);

  useEffect(() => {
    const latest = (course?.projectDocumentVersions ?? [])
      .filter((version) => version.submissionId === submissionIdRef.current && version.status === "submitted")
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (latest?.docxUploadId) {
      setSubmittedVersion({
        sequence: latest.sequence,
        submittedAt: latest.submittedAt,
        downloadUrl: `/api/uploads/${latest.docxUploadId}?download=1`,
      });
    }
  }, [course?.projectDocumentVersions, existingDocument?.id]);

  useEffect(() => {
    if (!resolvedCourseId || !studentId || !supportedStage) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ courseId: resolvedCourseId, studentId, stageKey, workspaceKind });
    void fetch(`/api/ai-collaboration/document?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as {
        conversationId?: string;
        messages?: Array<{
          id: string;
          role: string;
          content: string;
          createdAt: string;
          projectSupport?: ProjectSupportDetails;
        }>;
        commentThreads?: DocumentAiCommentThread[];
        reviewedParagraphFingerprints?: string[];
        proactiveReviewEnabled?: boolean;
        requests?: Array<{
          requestId: string;
          conversationId?: string;
          message?: string;
          intent?: DocumentCollaborationIntent;
          status: "processing" | "failed" | "cancelled";
          createdAt?: string;
          error?: string;
          retryable?: boolean;
        }>;
      };
      if (controller.signal.aborted) return;
      setProactiveReviewEnabled(payload.proactiveReviewEnabled !== false);
      const loadedConversationId = payload.conversationId || "legacy";
      currentConversationRef.current = loadedConversationId;
      setConversationId(loadedConversationId);
      const loadedMessages: CollaborationMessage[] = (payload.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role === "student" ? "user" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
        support: message.projectSupport,
      }));
      const snapshots = readPendingRequestSnapshots(`${resolvedCourseId}:${studentId}:${stageKey}:${workspaceKind}`);
      requestSnapshotsRef.current = new Map(snapshots.map((snapshot) => [snapshot.requestId, snapshot]));
      const pendingById = new Map((payload.requests ?? [])
        .filter((request) => !request.conversationId || request.conversationId === loadedConversationId)
        .map((request) => [request.requestId, request]));
      const requestIds = new Set([...pendingById.keys(), ...snapshots
        .filter((snapshot) => snapshot.conversationId === loadedConversationId)
        .map((snapshot) => snapshot.requestId)]);
      for (const requestId of requestIds) {
        const request = pendingById.get(requestId);
        const snapshot = requestSnapshotsRef.current.get(requestId);
        const content = request?.message ?? snapshot?.message;
        if (!content) continue;
        loadedMessages.push({
          id: snapshot?.messageId ?? `document-request-${requestId}`,
          role: "user",
          content,
          createdAt: request?.createdAt ?? snapshot?.createdAt ?? new Date().toISOString(),
          requestId,
          requestStatus: request?.status === "failed" ? "failed" : request?.status === "cancelled" ? "cancelled" : "recovering",
          requestError: request?.status === "failed" ? requestFailureMessage(request.error, undefined, content) : undefined,
          retryable: Boolean(snapshot) && request?.retryable !== false,
        });
      }
      setMessages(loadedMessages);
      for (const requestId of requestIds) {
        const status = pendingById.get(requestId)?.status;
        if (status !== "failed" && status !== "cancelled") {
          window.setTimeout(() => recoverRequestRef.current?.(requestId), 0);
        }
      }
      const commentThreads = payload.commentThreads ?? [];
      setAiCommentThreads(commentThreads);
      const reviewedFingerprints = new Set(payload.reviewedParagraphFingerprints ?? []);
      commentThreads
        .filter((thread) =>
          thread.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION
          && Boolean(thread.blockText)
        )
        .forEach((thread) => {
          reviewedFingerprints.add(documentParagraphVersionFingerprint(thread.blockText ?? ""));
        });
      analyzedParagraphsRef.current = reviewedFingerprints;
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setHistoryLoaded(true);
    });
    return () => controller.abort();
  }, [resolvedCourseId, stageKey, studentId, supportedStage, workspaceKind]);

  const persistDocument = useCallback(async (
    content: string,
    source: "auto" | "manual" | "ai" | "undo",
  ): Promise<boolean> => {
    if (!course || !studentId || !supportedStage) {
      setSaveStatus("error");
      return false;
    }
    if (content === savedContentRef.current && session.saveState !== "error") {
      setSaveStatus("saved");
      return true;
    }
    setSaveStatus("saving");
    const submission = await session.persistSubmission({
      id: submissionIdRef.current,
      courseId: course.id,
      studentId,
      studentName: session.studentName ?? session.user.name,
      groupId: group?.id,
      stageKey,
      type: isExternalArtifact ? "artifact-brief" : "document",
      title: documentTitle,
      content,
    });
    if (!submission) {
      setSaveStatus("error");
      return false;
    }
    submissionIdRef.current = submission.id;
    submissionVersionRef.current = submission.version ?? 1;
    savedContentRef.current = content;
    setSaveStatus("saved");
    void source;
    return true;
  }, [course, documentTitle, group, isExternalArtifact, session, stageKey, studentId, supportedStage]);

  useEffect(() => {
    if (!documentReady || !course || !studentId || !supportedStage) return;
    if (documentHtml === savedContentRef.current) return;
    const timer = window.setTimeout(() => void persistDocument(documentHtml, "auto"), 900);
    return () => window.clearTimeout(timer);
  }, [course, documentHtml, documentReady, persistDocument, stageKey, studentId, supportedStage]);

  useEffect(() => {
    if (!documentReady || !historyLoaded || !course || !studentId || !supportedStage || !proactiveReviewEnabled) return;
    if (saveStatus !== "saved" || busy || pendingSuggestion || pendingDelivery) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${workspaceKind}`;
    const storageKey = `openpbl:ai-collaboration:paragraph-review:v${DOCUMENT_COMMENT_REVIEW_VERSION}:${scopeKey}`;
    const stableJitterMs = [...scopeKey].reduce(
      (hash, character) => (hash * 31 + character.charCodeAt(0)) % PROACTIVE_REVIEW_JITTER_MS,
      0,
    );
    const timer = window.setTimeout(() => {
      const candidates = editorRef.current?.getBlockCandidates() ?? [];

      try {
        const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]") as unknown;
        if (Array.isArray(stored)) {
          stored.filter((item): item is string => typeof item === "string")
            .forEach((item) => analyzedParagraphsRef.current.add(item));
        }
      } catch {
        window.sessionStorage.removeItem(storageKey);
      }

      const candidatesToReview = candidates.filter((item) => {
        const type = item.type.toLowerCase();
        if (!["p", "blockquote", "h1", "h2", "h3"].includes(type)) return false;
        if (!isReviewableDocumentParagraph(item.text)) return false;
        const signature = documentParagraphVersionFingerprint(item.text);
        const hasCompletedReview = aiCommentThreads.some((thread) =>
          thread.reviewVersion === DOCUMENT_COMMENT_REVIEW_VERSION
          && Boolean(thread.blockText)
          && documentParagraphVersionFingerprint(thread.blockText ?? "") === signature
        );
        return !analyzedParagraphsRef.current.has(signature)
          && !hasCompletedReview
          && !proactiveRequestRef.current.has(signature);
      });
      if (!candidatesToReview.length) return;

      const requests = candidatesToReview.slice(0, DOCUMENT_COMMENT_REVIEW_BATCH_SIZE).map((candidate) => ({
        candidate,
        signature: documentParagraphVersionFingerprint(candidate.text),
      }));
      const hasMoreCandidates = candidatesToReview.length > requests.length;
      requests.forEach(({ signature }) => proactiveRequestRef.current.add(signature));
      void fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({
          action: "proactive-document-comments",
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
          paragraphs: requests.map(({ candidate }) => ({
            candidateId: candidate.blockId
              ? `block:${candidate.blockId}`
              : `index:${candidate.blockIndex}`,
            blockId: candidate.blockId,
            blockIndex: candidate.blockIndex,
            targetText: candidate.text,
          })),
          documentHtml,
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({})) as {
          commentThreads?: DocumentAiCommentThread[];
          reviewedParagraphFingerprints?: string[];
          reviewedCandidateIds?: string[];
          complete?: boolean;
          documentVersion?: string;
          proactiveReviewEnabled?: boolean;
        };
        if (!response.ok) {
          const retryAfterSeconds = Number(response.headers.get("Retry-After"));
          scheduleProactiveReviewRetry(
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0,
          );
          return;
        }
        if (payload.proactiveReviewEnabled === false) {
          setProactiveReviewEnabled(false);
          return;
        }
        const currentHash = payload.documentVersion
          ? await documentVersionDigest(currentDocumentRef.current).catch(() => null)
          : null;
        if (currentDocumentRef.current !== documentHtml || (payload.documentVersion && currentHash !== null && currentHash !== payload.documentVersion)) {
          scheduleProactiveReviewWake(1_500);
          return;
        }
        const confirmedFingerprints = new Set(payload.reviewedParagraphFingerprints ?? []);
        const confirmedCandidateIds = new Set(payload.reviewedCandidateIds ?? []);
        const confirmedRequests = requests.filter(({ signature, candidate }) =>
          confirmedFingerprints.has(signature)
          || confirmedCandidateIds.has(candidate.blockId ? `block:${candidate.blockId}` : `index:${candidate.blockIndex}`)
        );
        confirmedRequests.forEach(({ signature }) => analyzedParagraphsRef.current.add(signature));
        try {
          window.sessionStorage.setItem(
            storageKey,
            JSON.stringify([...analyzedParagraphsRef.current].slice(-200)),
          );
        } catch { /* Server review checkpoints remain authoritative. */ }
        if (payload.complete === false || confirmedRequests.length < requests.length) {
          scheduleProactiveReviewRetry();
        } else {
          proactiveRetryAttemptRef.current = 0;
          if (hasMoreCandidates) {
            scheduleProactiveReviewWake(Math.floor(Math.random() * PROACTIVE_REVIEW_JITTER_MS));
          }
        }
        const liveCandidates = editorRef.current?.getBlockCandidates() ?? [];
        const incoming = (payload.commentThreads ?? []).filter((thread) => {
          const original = requests.find(({ candidate }) =>
            candidate.blockId ? candidate.blockId === thread.blockId : candidate.blockIndex === thread.blockIndex);
          if (!original) return false;
          const live = liveCandidates.find((candidate) =>
            original.candidate.blockId ? candidate.blockId === original.candidate.blockId : candidate.blockIndex === original.candidate.blockIndex);
          return Boolean(live
            && live.text.replace(/\s+/g, " ").trim() === original.candidate.text.replace(/\s+/g, " ").trim()
            && live.text.includes(thread.targetText));
        });
        if (!incoming.length) return;
        const incomingIds = new Set(incoming.map((thread) => thread.id));
        setAiCommentThreads((current) => [
          ...current.filter((thread) => !incomingIds.has(thread.id)),
          ...incoming,
        ]);
      }).catch(() => scheduleProactiveReviewRetry()).finally(() => {
        requests.forEach(({ signature }) => proactiveRequestRef.current.delete(signature));
      });
    }, proactiveReviewRetry > 0 ? 1_000 : PROACTIVE_REVIEW_SETTLE_MS + stableJitterMs);
    return () => window.clearTimeout(timer);
  }, [aiCommentThreads, busy, course, documentHtml, documentReady, historyLoaded, pendingDelivery, pendingSuggestion, proactiveReviewEnabled, proactiveReviewRetry, saveStatus, scheduleProactiveReviewRetry, scheduleProactiveReviewWake, stageKey, studentId, supportedStage, workspaceKind]);

  useEffect(() => {
    if (!documentReady) return;
    const candidates = editorRef.current?.getBlockCandidates();
    if (!candidates) return;
    setInvalidCommentIds(new Set(aiCommentThreads
      .filter((thread) => !isCommentThreadAnchored(thread, candidates))
      .map((thread) => thread.id)));
  }, [aiCommentThreads, documentHtml, documentReady]);

  const replyToDocumentComment = useCallback(async ({
    threadId,
    message,
  }: {
    threadId: string;
    message: string;
  }) => {
    if (!course || !studentId || !supportedStage) {
      throw new Error("当前项目状态已经变化，请刷新页面后重试。");
    }
    if ((pendingSuggestion || pendingDelivery) && /(?:修改|改写|替换|润色|重写|直接改)/.test(message)) {
      throw new Error("已有修改或交付待审阅。你可以继续讨论这条批注；请先处理现有内容，再请求新的修改。");
    }
    const sourceThread = aiCommentThreads.find((thread) => thread.id === threadId);
    if (!sourceThread) throw new Error("这条批注已经失效，请刷新页面后重试。");
    const previousReply = commentReplySnapshotRef.current.get(threadId);
    const replySnapshot = previousReply?.message === message && previousReply.documentHtml === documentHtml
      ? previousReply
      : {
          requestId: nowId("document-comment-ai-request"),
          contributionId: nowId("document-comment-ai-contribution"),
          threadId,
          message,
          documentHtml,
        };
    commentReplySnapshotRef.current.set(threadId, replySnapshot);
    const { requestId, contributionId } = replySnapshot;
    const query = new URLSearchParams({ courseId: course.id, studentId, stageKey, workspaceKind, requestId });
    const readStatus = async () => {
      const response = await fetch(`/api/ai-collaboration/document?${query.toString()}`, { cache: "no-store" });
      return { response, payload: await response.json().catch(() => ({})) as {
        commentThread?: DocumentAiCommentThread;
        message?: string;
        result?: DocumentAiCommentReplyResult;
        status?: string;
        retryAfterMs?: number;
      } };
    };
    let current: Awaited<ReturnType<typeof readStatus>>;
    try {
      const response = await fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student", "X-Request-Id": requestId },
        body: JSON.stringify({
          action: "reply-document-comment",
          commentThreadId: threadId,
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
          documentHtml: replySnapshot.documentHtml,
          message: replySnapshot.message,
          requestId,
          contributionId,
        }),
      });
      current = { response, payload: await response.json().catch(() => ({})) };
      if (response.ok && !current.payload.commentThread && current.payload.status !== "processing") {
        current = await readStatus();
      }
    } catch {
      current = await readStatus();
    }
    const deadline = Date.now() + REQUEST_RECOVERY_MAX_MS;
    while (current.response.status === 202 || current.payload.status === "processing") {
      if (Date.now() >= deadline) throw new Error("回复仍在处理中，原文已保留。请稍后再试。");
      await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(5_000, Math.max(750, current.payload.retryAfterMs ?? 1_500))));
      current = await readStatus();
    }
    const { response, payload } = current as { response: Response; payload: {
      commentThread?: DocumentAiCommentThread;
      message?: string;
      result?: DocumentAiCommentReplyResult;
    } };
    if (!response.ok || !payload.commentThread) {
      throw new Error(payload.message ?? "AI 组员暂时无法回复这条批注，请稍后重试。");
    }
    commentReplySnapshotRef.current.delete(threadId);
    setAiCommentThreads((current) => [
      ...current.filter((thread) => thread.id !== payload.commentThread!.id),
      payload.commentThread!,
    ]);
    if (!payload.result?.suggestion || pendingSuggestion || pendingDelivery) return;

    const suggestion = payload.result.suggestion;
    const sourceCommentId = [...payload.commentThread.comments]
      .reverse()
      .find((comment) => comment.role === "assistant")?.id;
    const selectionSnapshot = editorRef.current?.resolveCommentSelection({
      blockId: sourceThread.blockId,
      blockIndex: sourceThread.blockIndex,
      expectedBlockText: sourceThread.blockText ?? sourceThread.targetText,
      targetText: suggestion.targetText,
    }) ?? null;
    const preview = selectionSnapshot
      ? editorRef.current?.previewAiSuggestion({
          operation: "replace",
          ...selectionSnapshot,
          replacement: suggestion.replacement,
        })
      : undefined;
    const contribution: AiContribution = {
      id: contributionId,
      courseId: course.id,
      studentId,
      stageKey,
      companionId: "critic",
      impact: "high",
      request: message,
      suggestion: `${payload.result.message}\n${suggestion.replacement || "（删除所选内容）"}`,
      sourceEvidenceIds: (course.learningEvidence ?? [])
        .filter((item) => item.studentId === studentId && item.stageKey === stageKey)
        .slice(-8)
        .map((item) => item.id),
      proposedChange: suggestion.title,
      status: "pending-decision",
      createdAt: new Date().toISOString(),
    };
    session.upsertAiContribution(contribution);
    const confirmation = session.upsertCompanionConfirmation({
      courseId: course.id,
      studentId,
      stageKey,
      action: "edit-workspace",
      title: suggestion.title,
      summary: suggestion.reason,
      payload: {
        kind: "document-comment-edit",
        documentTitle,
        commentThreadId: threadId,
        targetText: suggestion.targetText,
        replacement: suggestion.replacement,
        selectionAnchor: selectionSnapshot?.anchor,
        selectionFocus: selectionSnapshot?.focus,
        contributionId: contribution.id,
      },
      status: "pending",
    });
    setPendingSuggestion({
      id: nowId("comment-suggestion"),
      confirmationId: confirmation.id,
      contribution,
      suggestion,
      selection: selectionSnapshot,
      presentation: preview?.presentation
        ?? (suggestion.targetText.length >= 220 ? "blocks" : "inline"),
      previewReady: preview?.ok === true,
      sourceThreadId: threadId,
      sourceCommentId,
    });
    setSuggestionError(
      preview?.ok
        ? null
        : preview?.reason ?? "批注对应的文字已经变化，未能在正文中标出修改。请拒绝本次建议后重新讨论。",
    );
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: "AI 组员从段落批注提出修改",
      summary: suggestion.reason,
      source: "agent",
      companionId: "critic",
    });
  }, [aiCommentThreads, course, documentHtml, documentTitle, pendingDelivery, pendingSuggestion, session, stageKey, studentId, supportedStage, workspaceKind]);

  const markDocumentCommentRead = useCallback(async ({ threadId }: { threadId: string }) => {
    if (!course || !studentId || !supportedStage) return;
    const optimisticReadAt = new Date().toISOString();
    setAiCommentThreads((current) => current.map((thread) =>
      thread.id === threadId ? { ...thread, readAt: optimisticReadAt } : thread
    ));
    const response = await fetch("/api/ai-collaboration/document", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify({
        action: "read-document-comment",
        commentThreadId: threadId,
        courseId: course.id,
        studentId,
        stageKey,
        workspaceKind,
      }),
    });
    const payload = await response.json().catch(() => ({})) as { readAt?: string };
    if (response.ok && payload.readAt) {
      setAiCommentThreads((current) => current.map((thread) =>
        thread.id === threadId ? { ...thread, readAt: payload.readAt } : thread
      ));
    }
  }, [course, stageKey, studentId, supportedStage, workspaceKind]);

  const updateDocumentCommentStatus = useCallback(async ({
    threadId,
    status,
  }: {
    threadId: string;
    status: "open" | "resolved" | "deferred" | "not-applicable";
  }) => {
    if (!course || !studentId || !supportedStage) throw new Error("当前项目状态已变化，请刷新后重试。");
    const previous = aiCommentThreads.find((thread) => thread.id === threadId);
    if (!previous) throw new Error("这条批注已失效，请刷新后重试。");
    setCommentStatusError(null);
    setAiCommentThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, status } : thread));
    try {
      const response = await fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({
          action: "set-document-comment-status",
          commentThreadId: threadId,
          status,
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { commentThread?: DocumentAiCommentThread; message?: string };
      if (!response.ok || !payload.commentThread) throw new Error(payload.message ?? "批注状态未能保存，请稍后重试。");
      setAiCommentThreads((current) => current.map((thread) => thread.id === threadId ? payload.commentThread! : thread));
    } catch (statusError) {
      setAiCommentThreads((current) => current.map((thread) => thread.id === threadId ? previous : thread));
      setCommentStatusError(statusError instanceof Error ? statusError.message : "批注状态未能保存，请稍后重试。");
      throw statusError;
    }
  }, [aiCommentThreads, course, stageKey, studentId, supportedStage, workspaceKind]);

  function handleDocumentChange(html: string) {
    currentDocumentRef.current = html;
    setDocumentHtml(html);
    setSaveStatus(html === savedContentRef.current ? "saved" : "unsaved");
    if (undoableEdit && html !== undoableEdit.afterHtml) setUndoableEdit(null);
  }

  function recordAiInteraction(input: {
    conversationId?: string;
    source: "sidebar" | "selection" | "proactive-comment" | "system";
    eventType: "proposal" | "decision" | "undo" | "comment" | "error";
    content?: string;
    payload?: Record<string, unknown>;
  }) {
    if (!course || !studentId || !supportedStage) return;
    const { conversationId: targetConversationId, ...event } = input;
    void fetch("/api/ai-collaboration/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify({
        courseId: course.id,
        studentId,
        stageKey,
        workspaceKind,
        conversationId: targetConversationId ?? conversationId,
        actorRole: "student",
        ...event,
      }),
    }).catch(() => undefined);
  }

  async function sendRequest(
    requestedIntent = intent,
    preset?: string,
    selectionOverride?: PlateDocumentSelection | null,
    retrySnapshot?: DocumentRequestSnapshot,
    statusOnly = false,
  ) {
    const requestText = (retrySnapshot?.message ?? preset ?? draft).trim();
    if (!requestText || !course || !studentId || busy || !supportedStage) return null;
    if ((pendingSuggestion || pendingDelivery) && WRITING_INTENTS.has(requestedIntent)) {
      setError("已有一项修改或交付待审阅。你可以继续讨论；请先处理它，再安排新的写入工作。");
      return null;
    }
    // A selection always narrows the operation to that local paragraph. The
    // server applies the same rule even if a stale client sends intent=delegate.
    const currentSelection = retrySnapshot ? retrySnapshot.selection : (selectionOverride === undefined ? selection : selectionOverride);
    const selectionSnapshot = currentSelection
      ? {
          ...currentSelection,
          anchor: { ...currentSelection.anchor, path: [...currentSelection.anchor.path] },
          focus: { ...currentSelection.focus, path: [...currentSelection.focus.path] },
        }
      : null;
    if (MODIFICATION_INTENTS.has(requestedIntent) && !selectionSnapshot) {
      setIntent(requestedIntent);
      setError(`局部修改必须先选中文字。这样 AI 只能处理你指定的范围，不会接管整篇${workspaceNoun}。`);
      return null;
    }
    const requestId = retrySnapshot?.requestId ?? nowId("document-ai-request");
    const contributionId = retrySnapshot?.contributionId ?? nowId("document-ai-contribution");
    const optimistic: CollaborationMessage = {
      id: retrySnapshot?.messageId ?? nowId("student-message"),
      role: "user",
      content: requestText,
      createdAt: retrySnapshot?.createdAt ?? new Date().toISOString(),
      requestId,
      requestStatus: statusOnly || retrySnapshot ? "recovering" : "sending",
    };
    const snapshot: DocumentRequestSnapshot = retrySnapshot ?? {
      requestId,
      messageId: optimistic.id,
      contributionId,
      createdAt: optimistic.createdAt,
      conversationId,
      intent: requestedIntent,
      message: requestText,
      documentHtml,
      selection: selectionSnapshot,
      revisionOf: requestedIntent === "delegate" ? deliveryRevision : undefined,
    };
    requestSnapshotsRef.current.set(requestId, snapshot);
    writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
    setMessages((current) => {
      const index = current.findIndex((message) => message.requestId === requestId || message.id === optimistic.id);
      if (index < 0) return [...current, optimistic];
      return current.map((message, itemIndex) => itemIndex === index ? { ...message, ...optimistic, id: message.id } : message);
    });
    if (!retrySnapshot) setDraft("");
    setQuickIntent(null);
    setIntent(requestedIntent);
    setBusy(true);
    setError(null);
    setSuggestionError(null);
    const controller = new AbortController();
    activeRequestRef.current = { id: requestId, controller };
    let retryable = true;
    try {
      const query = new URLSearchParams({ courseId: course.id, studentId, stageKey, workspaceKind, requestId });
      const fetchStatus = async (): Promise<{ response: Response; payload: DocumentRequestPayload }> => {
        const response = await fetch(`/api/ai-collaboration/document?${query.toString()}`, { cache: "no-store", signal: controller.signal });
        return { response, payload: await response.json().catch(() => ({})) as DocumentRequestPayload };
      };
      let current: { response: Response; payload: DocumentRequestPayload };
      if (statusOnly) {
        current = await fetchStatus();
      } else {
        try {
          const response = await fetch("/api/ai-collaboration/document", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-OpenPBL-Role": "student",
              "X-Request-Id": requestId,
            },
            signal: controller.signal,
            body: JSON.stringify({
              courseId: course.id,
              studentId,
              stageKey,
              workspaceKind,
              conversationId: snapshot.conversationId,
              requestId,
              intent: snapshot.intent,
              message: snapshot.message,
              documentHtml: snapshot.documentHtml,
              selectedText: snapshot.selection?.text,
              contributionId: snapshot.contributionId,
              revisionOf: snapshot.revisionOf,
            }),
          });
          current = { response, payload: await response.json().catch(() => ({})) as DocumentRequestPayload };
        } catch (requestError) {
          if (controller.signal.aborted) throw requestError;
          // The server may have completed the request even if its response was lost.
          current = await fetchStatus();
        }
      }
      const deadline = Date.now() + REQUEST_RECOVERY_MAX_MS;
      while (current.payload.status === "processing" || current.response.status === 202) {
        setMessages((messagesNow) => messagesNow.map((message) => message.requestId === requestId
          ? { ...message, requestStatus: "processing" }
          : message));
        if (Date.now() >= deadline) throw new Error("回答仍在处理中，你的消息已保留。请稍后重新尝试。");
        await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(5_000, Math.max(750, current.payload.retryAfterMs ?? 1_500))));
        if (controller.signal.aborted) return null;
        current = await fetchStatus();
      }
      if (activeRequestRef.current?.id !== requestId) return null;
      const { response, payload } = current;
      if (snapshot.conversationId !== currentConversationRef.current) return null;
      const currentVersion = payload.documentVersion
        ? await documentVersionDigest(currentDocumentRef.current).catch(() => null)
        : null;
      const matchesCurrentWorkspace = snapshot.documentHtml === currentDocumentRef.current
        && snapshot.conversationId === currentConversationRef.current
        && (!payload.documentVersion || currentVersion === null || currentVersion === payload.documentVersion);
      if (payload.conversationId) {
        currentConversationRef.current = payload.conversationId;
        setConversationId(payload.conversationId);
      }
      if (!response.ok || payload.status === "failed" || payload.status === "cancelled" || !payload.result) {
        retryable = payload.retryable !== false && response.status !== 409 && payload.status !== "cancelled";
        throw new Error(requestFailureMessage(payload.error, payload.message, snapshot.message));
      }
      requestSnapshotsRef.current.delete(requestId);
      writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
      const assistantMessage: CollaborationMessage = {
        id: payload.messages?.find((message) => message.role === "agent")?.id
          ?? nowId("ai-message"),
        role: "assistant",
        content: matchesCurrentWorkspace || (!payload.result.suggestion && !payload.result.deliverable)
          ? payload.result.message
          : `${payload.result.message}\n\n文稿或对话已更新，这次结果仅供参考。若要应用，请基于当前内容重新提出请求。`,
        createdAt: new Date().toISOString(),
        kind: payload.result.kind,
        support: payload.result.support,
      };
      const persistedStudentId = payload.messages?.find((message) => message.role === "student")?.id;
      setMessages((current) => [
        ...current
          .filter((message) => message.id !== optimistic.id && message.requestId !== requestId && message.id !== assistantMessage.id),
        {
          ...optimistic,
          id: persistedStudentId ?? optimistic.id,
          requestStatus: undefined,
        },
        assistantMessage,
      ]);
      if (payload.memories) projectMemory.replaceMemories(payload.memories);
      const contribution: AiContribution = {
        id: contributionId,
        courseId: course.id,
        studentId,
        stageKey,
        companionId: payload.companionId ?? "recorder",
        impact: payload.result.suggestion || payload.result.deliverable ? "high" : "low",
        request: requestText,
        suggestion: payload.result.deliverable
          ? `${payload.result.message}\n${payload.result.deliverable.content}`
          : payload.result.suggestion
            ? `${payload.result.message}\n${payload.result.suggestion.replacement}`
            : payload.result.message,
        sourceEvidenceIds: (course.learningEvidence ?? [])
          .filter((item) => item.studentId === studentId && item.stageKey === stageKey)
          .slice(-8)
          .map((item) => item.id),
        proposedChange: payload.result.deliverable?.title ?? payload.result.suggestion?.title,
        status: payload.result.suggestion || payload.result.deliverable ? "pending-decision" : "decided",
        createdAt: new Date().toISOString(),
      };
      session.upsertAiContribution(contribution);
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: payload.result.kind === "boundary"
          ? "AI 组员守住了协作边界"
          : payload.result.kind === "work-delivery"
            ? "AI 组员提交了辅助工作"
            : `AI 组员参与${workspaceNoun}协作`,
        summary: payload.result.message.slice(0, 260),
        source: "agent",
        companionId: contribution.companionId,
      });
      if (matchesCurrentWorkspace && payload.result.suggestion && selectionSnapshot) {
        const preview = editorRef.current?.previewAiSuggestion({
          operation: "replace",
          ...selectionSnapshot,
          replacement: payload.result.suggestion.replacement,
        });
        const confirmation = session.upsertCompanionConfirmation({
          courseId: course.id,
          studentId,
          stageKey,
          action: "edit-workspace",
          title: payload.result.suggestion.title,
          summary: payload.result.suggestion.reason,
          payload: {
            kind: "document-collaboration-edit",
            documentTitle,
            targetText: payload.result.suggestion.targetText,
            replacement: payload.result.suggestion.replacement,
            selectionAnchor: selectionSnapshot.anchor,
            selectionFocus: selectionSnapshot.focus,
            contributionId: contribution.id,
          },
          status: "pending",
        });
        setPendingSuggestion({
          id: nowId("suggestion"),
          confirmationId: confirmation.id,
          contribution,
          suggestion: payload.result.suggestion,
          selection: selectionSnapshot,
          presentation: preview?.presentation
            ?? (selectionSnapshot.text.length >= 220 || selectionSnapshot.text.includes("\n\n") ? "blocks" : "inline"),
          previewReady: preview?.ok === true,
        });
        setSuggestionError(preview?.ok ? null : preview?.reason ?? "未能在正文中生成修改标记，请重新选择目标内容后再试。");
      }
      if (matchesCurrentWorkspace && payload.result.suggestion && !selectionSnapshot && payload.result.suggestion.operation === "insert") {
        const preview = editorRef.current?.previewAiSuggestion({
          operation: "insert",
          replacement: payload.result.suggestion.replacement,
        });
        const confirmation = session.upsertCompanionConfirmation({
          courseId: course.id,
          studentId,
          stageKey,
          action: "edit-workspace",
          title: payload.result.suggestion.title,
          summary: payload.result.suggestion.reason,
          payload: {
            kind: "document-collaboration-insert",
            documentTitle,
            replacement: payload.result.suggestion.replacement,
            contributionId: contribution.id,
          },
          status: "pending",
        });
        setPendingSuggestion({
          id: nowId("suggestion"),
          confirmationId: confirmation.id,
          contribution,
          suggestion: payload.result.suggestion,
          selection: null,
          presentation: preview?.presentation
            ?? (payload.result.suggestion.replacement.length >= 220 || payload.result.suggestion.replacement.includes("\n\n") ? "blocks" : "inline"),
          previewReady: preview?.ok === true,
        });
        setSuggestionError(preview?.ok ? null : preview?.reason ?? "未能在正文中生成新增标记，请把光标放到目标位置后再试。");
      }
      if (matchesCurrentWorkspace && payload.result.deliverable) {
        const deliverable = payload.result.deliverable;
        const confirmation = session.upsertCompanionConfirmation({
          courseId: course.id,
          studentId,
          stageKey,
          action: "edit-workspace",
          title: deliverable.title,
          summary: deliverable.summary,
          payload: {
            kind: "delegated-work-delivery",
            documentTitle,
            content: deliverable.content,
            documentActions: deliverable.documentActions,
            sources: deliverable.sources,
            contributionId: contribution.id,
          },
          status: "pending",
        });
        setPendingDelivery({
          id: nowId("delivery"),
          confirmationId: confirmation.id,
          contribution,
          deliverable,
          error: null,
        });
        setDeliveryRevision(null);
      }
      return assistantMessage;
    } catch (requestError) {
      if (controller.signal.aborted) return null;
      recordAiInteraction({
        source: selectionSnapshot ? "selection" : "sidebar",
        eventType: "error",
        content: requestError instanceof Error ? requestError.message : "AI 组员请求失败",
        payload: { intent: requestedIntent, requestId },
      });
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? {
            ...message,
            requestStatus: "failed",
            requestError: requestError instanceof Error ? requestError.message : "这次回答没能完成，你的消息已保留。可以重新尝试。",
            retryable,
          }
        : message));
      return null;
    } finally {
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
        setBusy(false);
      }
    }
  }

  recoverRequestRef.current = (requestId) => {
    if (recoveredRequestIdsRef.current.has(requestId)) return;
    if (activeRequestRef.current) {
      window.setTimeout(() => recoverRequestRef.current?.(requestId), 1_000);
      return;
    }
    recoveredRequestIdsRef.current.add(requestId);
    const snapshot = requestSnapshotsRef.current.get(requestId);
    if (snapshot) {
      void sendRequest(snapshot.intent, snapshot.message, snapshot.selection, snapshot, true);
      return;
    }
    // A request started in another tab has no local editor snapshot. Recover
    // its answer for reading, but never construct an editable preview from it.
    void (async () => {
      if (!course || !studentId) return;
      const query = new URLSearchParams({ courseId: course.id, studentId, stageKey, workspaceKind, requestId });
      const deadline = Date.now() + REQUEST_RECOVERY_MAX_MS;
      try {
        while (Date.now() < deadline) {
          const response = await fetch(`/api/ai-collaboration/document?${query.toString()}`, { cache: "no-store" });
          const payload = await response.json().catch(() => ({})) as DocumentRequestPayload;
          if (payload.status === "processing" || response.status === 202) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(5_000, Math.max(750, payload.retryAfterMs ?? 1_500))));
            continue;
          }
          if (response.ok && payload.status === "completed" && payload.result) {
            const studentMessageId = payload.messages?.find((message) => message.role === "student")?.id;
            const assistantMessageId = payload.messages?.find((message) => message.role === "agent")?.id ?? nowId("ai-message");
            setMessages((current) => [
              ...current.filter((message) => message.requestId !== requestId && message.id !== assistantMessageId),
              ...current.filter((message) => message.requestId === requestId).map((message) => ({ ...message, id: studentMessageId ?? message.id, requestStatus: undefined })),
              {
                id: assistantMessageId,
                role: "assistant" as const,
                content: payload.result!.suggestion || payload.result!.deliverable
                  ? `${payload.result!.message}\n\n这次结果已恢复。如需应用修改，请基于当前文稿重新提出请求。`
                  : payload.result!.message,
                createdAt: new Date().toISOString(),
                kind: payload.result!.kind,
                support: payload.result!.support,
              },
            ]);
          } else {
            setMessages((current) => current.map((message) => message.requestId === requestId
              ? { ...message, requestStatus: payload.status === "cancelled" ? "cancelled" : "failed", requestError: requestFailureMessage(payload.error, payload.message, message.content), retryable: false }
              : message));
          }
          return;
        }
        setMessages((current) => current.map((message) => message.requestId === requestId
          ? { ...message, requestStatus: "failed", requestError: "回答仍在处理中，请稍后刷新查看。", retryable: false }
          : message));
      } catch {
        setMessages((current) => current.map((message) => message.requestId === requestId
          ? { ...message, requestStatus: "failed", requestError: "暂时无法确认这次请求的状态，请稍后刷新。", retryable: false }
          : message));
      }
    })();
  };

  function retryMessage(requestId: string) {
    const snapshot = requestSnapshotsRef.current.get(requestId);
    if (!snapshot) {
      setError("这次请求的原始内容已不可用，请编辑原消息后重新发送。");
      return;
    }
    recoveredRequestIdsRef.current.delete(requestId);
    void sendRequest(snapshot.intent, snapshot.message, snapshot.selection, snapshot);
  }

  function editMessage(messageId: string) {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    setDraft(message.content);
    setQuickIntent(null);
    setError(null);
  }

  async function cancelMessage(requestId: string) {
    if (!course || !studentId) return;
    if (activeRequestRef.current?.id === requestId) {
      activeRequestRef.current.controller.abort();
      activeRequestRef.current = null;
      setBusy(false);
    }
    setMessages((current) => current.map((message) => message.requestId === requestId
      ? { ...message, requestStatus: "recovering", requestError: undefined }
      : message));
    try {
      const response = await fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({ action: "cancel-request", courseId: course.id, studentId, stageKey, workspaceKind, requestId }),
      });
      const payload = await response.json().catch(() => ({})) as DocumentRequestPayload;
      if (response.ok && payload.status === "completed") {
        // Completion can win the race with cancellation. Recover the saved
        // answer rather than showing a failure for a successful request.
        recoveredRequestIdsRef.current.delete(requestId);
        window.setTimeout(() => recoverRequestRef.current?.(requestId), 0);
        return;
      }
      if (!response.ok || payload.status !== "cancelled") throw new Error(payload.message ?? "取消状态未能确认。");
      requestSnapshotsRef.current.delete(requestId);
      writePendingRequestSnapshots(requestScope, [...requestSnapshotsRef.current.values()]);
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? { ...message, requestStatus: "cancelled", retryable: false }
        : message));
    } catch {
      setMessages((current) => current.map((message) => message.requestId === requestId
        ? { ...message, requestStatus: "failed", requestError: "取消状态未能确认。你的原消息已保留，可以重新尝试或刷新查看。", retryable: requestSnapshotsRef.current.has(requestId) }
        : message));
    }
  }

  function submitMemberRequest() {
    const nextIntent = quickIntent ?? inferMemberIntent(draft, selection?.text);
    void sendRequest(nextIntent, undefined, selection);
  }

  async function startNewConversation() {
    if (!course || busy || pendingSuggestion || pendingDelivery) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({
          action: "reset-conversation",
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        conversationId?: string;
        message?: string;
      };
      if (!response.ok || !payload.conversationId) {
        throw new Error(payload.message ?? "暂时无法开始新对话，请稍后重试。");
      }
      currentConversationRef.current = payload.conversationId;
      setConversationId(payload.conversationId);
      requestSnapshotsRef.current.clear();
      writePendingRequestSnapshots(requestScope, []);
      recoveredRequestIdsRef.current.clear();
      setMessages([]);
      setDraft("");
      setDeliveryRevision(null);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "暂时无法开始新对话，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteConversationMessage(messageId: string) {
    if (!course || busy) return;
    const query = new URLSearchParams({
      courseId: course.id,
      studentId,
      stageKey,
      workspaceKind,
      conversationId,
      messageId,
    });
    setMessages((current) => current.filter((message) => message.id !== messageId));
    const response = await fetch(`/api/ai-collaboration/document?${query.toString()}`, {
      method: "DELETE",
      headers: { "X-OpenPBL-Role": "student" },
    });
    if (!response.ok) {
      setError("这条记录暂时无法从当前对话中移除，请刷新后重试。");
    } else {
      projectMemory.replaceMemories((current) => current.filter((memory) =>
        !memory.sourceMessageIds.includes(messageId)));
    }
  }

  async function uploadDocumentImage(file: File): Promise<string> {
    if (!course) throw new Error("课程尚未加载，暂时不能上传图片。");
    const form = new FormData();
    form.set("file", file);
    form.set("title", file.name || `${workspaceNoun}图片`);
    form.set("courseId", course.id);
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({})) as { url?: string; message?: string };
    if (!response.ok || !payload.url) throw new Error(payload.message ?? "图片上传失败，请稍后再试。");
    return payload.url;
  }

  function resolveSuggestion(decision: "adopted" | "rejected") {
    if (!pendingSuggestion || !course) return;
    const decisionId = `document-ai-decision-${pendingSuggestion.contribution.id}`;
    if (decision === "rejected") {
      if (pendingSuggestion.previewReady) {
        const previewResult = editorRef.current?.resolveAiSuggestion("rejected");
        if (!previewResult?.ok) {
          setSuggestionError(previewResult?.reason ?? "未能撤销正文中的修改标记，请稍后重试。");
          return;
        }
      }
      session.resolveCompanionConfirmation(course.id, pendingSuggestion.confirmationId, "rejected");
      session.upsertAiContribution({ ...pendingSuggestion.contribution, status: "decided" });
      session.recordStudentAiDecision({
        id: decisionId,
        courseId: course.id,
        studentId,
        stageKey,
        contributionId: pendingSuggestion.contribution.id,
        decision: "rejected",
        reason: "学生查看正文中的红删绿增标记后选择保留自己的原文。",
        resultingEvidenceIds: [],
        decidedAt: new Date().toISOString(),
      });
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: `拒绝 AI 修改“${pendingSuggestion.suggestion.title}”`,
        summary: `${workspaceNoun}没有发生变化，学生保留了原文。`,
        source: "student",
        companionId: pendingSuggestion.contribution.companionId,
      });
      recordAiInteraction({
        conversationId: pendingSuggestion.sourceThreadId ?? conversationId,
        source: pendingSuggestion.sourceThreadId ? "proactive-comment" : "selection",
        eventType: "decision",
        content: "学生拒绝 AI 修改建议，保留原文。",
        payload: { decision: "rejected", contributionId: pendingSuggestion.contribution.id },
      });
      setPendingSuggestion(null);
      setSuggestionError(null);
      return;
    }

    if (!pendingSuggestion.previewReady) {
      setSuggestionError("正文中没有可确认的修改标记，请保留原文后重新发起任务。");
      return;
    }
    const result = editorRef.current?.resolveAiSuggestion("accepted");
    if (!result?.ok || !result.beforeHtml || !result.afterHtml) {
      setSuggestionError(result?.reason ?? "修改未能确认，请重新选择目标内容并生成建议。");
      return;
    }
    session.resolveCompanionConfirmation(course.id, pendingSuggestion.confirmationId, "confirmed");
    session.upsertAiContribution({ ...pendingSuggestion.contribution, status: "decided" });
    session.recordStudentAiDecision({
      id: decisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: pendingSuggestion.contribution.id,
      decision: "adopted",
      reason: pendingSuggestion.presentation === "blocks"
        ? "学生查看正文中的段落级修改标记后主动确认应用。"
        : "学生查看正文中的字词级修改标记后主动确认应用。",
      appliedChangeSummary: pendingSuggestion.suggestion.title,
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `确认 AI 修改“${pendingSuggestion.suggestion.title}”`,
      summary: pendingSuggestion.suggestion.reason,
      source: "student",
      companionId: pendingSuggestion.contribution.companionId,
    });
    recordAiInteraction({
      conversationId: pendingSuggestion.sourceThreadId ?? conversationId,
      source: pendingSuggestion.sourceThreadId ? "proactive-comment" : "selection",
      eventType: "decision",
      content: `学生确认应用 AI 修改：${pendingSuggestion.suggestion.title}`,
      payload: { decision: "adopted", contributionId: pendingSuggestion.contribution.id, confirmationId: pendingSuggestion.confirmationId },
    });
    setUndoableEdit({
      title: pendingSuggestion.suggestion.title,
      beforeHtml: result.beforeHtml,
      afterHtml: result.afterHtml,
      confirmationId: pendingSuggestion.confirmationId,
      contribution: pendingSuggestion.contribution,
      decisionId,
      conversationId: pendingSuggestion.sourceThreadId ?? conversationId,
      source: pendingSuggestion.sourceThreadId ? "proactive-comment" : "selection",
    });
    setEditNotice({ kind: "applied", title: pendingSuggestion.suggestion.title });
    setPendingSuggestion(null);
    setSuggestionError(null);
    setSelection(null);
    void persistDocument(result.afterHtml, "ai");
  }

  function resolveDelivery(decision: "adopted" | "rejected" | "revision") {
    if (!pendingDelivery || !course) return;
    const decisionId = `document-ai-decision-${pendingDelivery.contribution.id}`;
    const { deliverable, contribution } = pendingDelivery;

    if (decision !== "adopted") {
      session.resolveCompanionConfirmation(course.id, pendingDelivery.confirmationId, "rejected");
      session.upsertAiContribution({ ...contribution, status: "decided" });
      session.recordStudentAiDecision({
        id: decisionId,
        courseId: course.id,
        studentId,
        stageKey,
        contributionId: contribution.id,
        decision: "rejected",
        reason: decision === "revision"
          ? `学生作为组长审阅交付后退回修改，原交付未写入${workspaceNoun}。`
          : `学生作为组长审阅交付后决定暂不采用，${workspaceNoun}未发生变化。`,
        resultingEvidenceIds: [],
        decidedAt: new Date().toISOString(),
      });
      session.addCompanionProcessRecord({
        courseId: course.id,
        studentId,
        stageKey,
        title: decision === "revision"
          ? `退回组员交付“${deliverable.title}”`
          : `暂不采用组员交付“${deliverable.title}”`,
        summary: decision === "revision"
          ? "等待组长补充修改意见后重新交付。"
          : `${workspaceNoun}没有发生变化。`,
        source: "student",
        companionId: contribution.companionId,
      });
      recordAiInteraction({
        source: "sidebar",
        eventType: "decision",
        content: decision === "revision" ? "学生退回 AI 组员交付要求修改。" : "学生暂不采用 AI 组员交付。",
        payload: { decision: "rejected", reason: decision, contributionId: contribution.id },
      });
      if (decision === "revision") {
        setDeliveryRevision({ title: deliverable.title, content: deliverable.content });
        setIntent("delegate");
        setDraft(`请修改这份交付：${deliverable.title}\n\n需要调整的地方：`);
      }
      setPendingDelivery(null);
      return;
    }

    const documentActions = deliverable.documentActions
      .filter((action) => action.operation !== "none");
    const result = documentActions.length
      ? editorRef.current?.applyDelegatedWorkPlan(documentActions)
      : null;
    if (documentActions.length && (!result?.ok || !result.beforeHtml || !result.afterHtml)) {
      setPendingDelivery((current) => current ? {
        ...current,
        error: result?.reason ?? `AI 规划的${workspaceNoun}位置已经失效，请退回交付后重新规划。`,
      } : current);
      return;
    }
    session.resolveCompanionConfirmation(course.id, pendingDelivery.confirmationId, "confirmed");
    session.upsertAiContribution({ ...contribution, status: "decided" });
    session.recordStudentAiDecision({
      id: decisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: contribution.id,
      decision: "adopted",
      reason: documentActions.length
        ? `学生作为组长审阅独立交付和${workspaceNoun}操作计划后，主动确认应用。`
        : `学生作为组长审阅了本次不涉及${workspaceNoun}修改的独立交付。`,
      appliedChangeSummary: deliverable.title,
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `采纳组员交付“${deliverable.title}”`,
      summary: documentActions.length
        ? `学生确认执行：${documentActions.map((action) => action.description).join("；")}`
        : `本次交付只作为参考资料完成审阅，${workspaceNoun}没有变化。`,
      source: "student",
      companionId: contribution.companionId,
    });
    recordAiInteraction({
      source: "sidebar",
      eventType: "decision",
      content: `学生确认审阅 AI 组员交付：${deliverable.title}`,
      payload: { decision: "adopted", contributionId: contribution.id, confirmationId: pendingDelivery.confirmationId, appliedToDocument: documentActions.length > 0 },
    });
    if (result?.beforeHtml && result.afterHtml) {
      setUndoableEdit({
        title: deliverable.title,
        beforeHtml: result.beforeHtml,
        afterHtml: result.afterHtml,
        confirmationId: pendingDelivery.confirmationId,
        contribution,
        decisionId,
        conversationId,
        source: "sidebar",
      });
      setEditNotice({ kind: "applied", title: deliverable.title });
    }
    setPendingDelivery(null);
    setSelection(null);
    if (result?.afterHtml) void persistDocument(result.afterHtml, "ai");
  }

  function undoAiEdit() {
    if (!undoableEdit || !course) return;
    if (documentHtml !== undoableEdit.afterHtml) {
      setUndoableEdit(null);
      setError(`${workspaceNoun}在 AI 修改后又发生了变化。为避免覆盖新内容，本次不能整体撤销。`);
      return;
    }
    setDocumentHtml(undoableEdit.beforeHtml);
    setSelection(null);
    session.resolveCompanionConfirmation(course.id, undoableEdit.confirmationId, "rejected");
    session.recordStudentAiDecision({
      id: undoableEdit.decisionId,
      courseId: course.id,
      studentId,
      stageKey,
      contributionId: undoableEdit.contribution.id,
      decision: "rejected",
      reason: "学生在应用后使用撤销，决定恢复修改前原文。",
      resultingEvidenceIds: [],
      decidedAt: new Date().toISOString(),
    });
    session.addCompanionProcessRecord({
      courseId: course.id,
      studentId,
      stageKey,
      title: `撤销 AI 内容“${undoableEdit.title}”`,
      summary: "已恢复修改前的文档内容。",
      source: "student",
      companionId: undoableEdit.contribution.companionId,
    });
    recordAiInteraction({
      conversationId: undoableEdit.conversationId,
      source: undoableEdit.source,
      eventType: "undo",
      content: `学生撤销 AI 修改：${undoableEdit.title}`,
      payload: { contributionId: undoableEdit.contribution.id, decisionId: undoableEdit.decisionId },
    });
    void persistDocument(undoableEdit.beforeHtml, "undo");
    setEditNotice({ kind: "undone", title: undoableEdit.title });
    setUndoableEdit(null);
  }

  async function submitFinalDocument() {
    if (!course || !studentId || !supportedStage || !canSubmitFinal || submitting) return;
    if (pendingSuggestion || pendingDelivery) {
      setError("请先接受或拒绝当前待确认的 AI 修改或组员交付，再提交最终版。");
      return;
    }
    if (plainTextLength(documentHtml) < 2) {
      setError("文档还没有可提交的内容，请先完成自己的方案编写。");
      return;
    }
    if (documentHtml !== savedContentRef.current) await persistDocument(documentHtml, "manual");
    setSubmitting(true);
    setError(null);
    try {
      const flushed = await session.flushSaves();
      if (!flushed || !submissionIdRef.current) {
        throw new Error("文档尚未保存成功，请稍后重试。");
      }
      const requestId = nowId("project-submit");
      const response = await fetch("/api/project-practice/submissions/finalize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenPBL-Role": "student",
          "X-Request-Id": requestId,
        },
        body: JSON.stringify({
          courseId: course.id,
          submissionId: submissionIdRef.current,
          studentId,
          stageKey,
          expectedVersion: submissionVersionRef.current,
          requestId,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        sequence?: number;
        submittedAt?: string;
        downloadUrl?: string;
        message?: string;
      };
      if (!response.ok || !payload.sequence || !payload.downloadUrl) {
        throw new Error(payload.message ?? "最终 Word 文档生成失败，请稍后重试。");
      }
      setSubmittedVersion({
        sequence: payload.sequence,
        submittedAt: payload.submittedAt,
        downloadUrl: payload.downloadUrl,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "最终 Word 文档生成失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (!hydrated || !course) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-stone-500">
        <LoaderCircle className="mr-2 animate-spin" size={20} />正在准备 AI 协作空间…
      </div>
    );
  }

  if (!studentId) {
    return <UnavailableState message="学生身份尚未初始化，请重新进入课堂。" onBack={() => router.replace("/student")} />;
  }

  if (!supportedStage) {
    return (
      <UnavailableState
        message={course.status === "finished"
          ? "课堂已经结束，协作成果现已只读保存。"
          : `${workspaceNoun}协作目前仅在项目实践阶段开放。`}
        onBack={() => router.replace(collaborationBackHref(course.id))}
      />
    );
  }

  const historicalComments = aiCommentThreads.filter((thread) =>
    documentAiCommentStatus(thread) !== "open" || invalidCommentIds.has(thread.id));

  return (
    <main className="flex min-h-dvh flex-col bg-[var(--pbl-bg)] pt-16 text-[var(--pbl-text)]">
      <DashboardTopBar
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
        currentStage={{ index: course.currentStageIndex, total: course.stages.length, label: stage?.label ?? "项目实践" }}
        currentTask={stage?.description}
        headerSlot={stage ? <StudentClassroomHeaderStatus course={course} /> : undefined}
        hideCourseSwitcher
        leadRole="学生"
        role="student"
        userName={session.studentName ?? session.user.name}
      />
      <header className="sticky top-16 z-[60] h-16 border-b border-[var(--pbl-border)] bg-[color-mix(in_srgb,var(--pbl-surface)_96%,transparent)] backdrop-blur-sm">
        <div className="flex h-full w-full items-center justify-between gap-3 px-2 sm:px-3 lg:px-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium leading-none text-stone-500">{isExternalArtifact ? "本地成果协作" : "选题方向"}</p>
            <h1 className="mt-1 truncate text-base font-bold leading-tight text-stone-950 sm:text-lg">{projectTitle}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className="hidden sm:inline-flex"><SaveState status={session.saveState === "error" ? "error" : saveStatus} /></span>
            <PrimaryButton
              disabled={saveStatus === "saving"}
              onClick={() => void persistDocument(documentHtml, "manual")}
              size="sm"
              tone="slate"
              variant="outline"
            >
              <Save size={14} />保存
            </PrimaryButton>
            {canSubmitFinal ? (
              <PrimaryButton
                disabled={submitting || saveStatus === "saving" || session.saveState === "saving" || Boolean(pendingSuggestion) || Boolean(pendingDelivery)}
                onClick={() => { void submitFinalDocument(); }}
                size="sm"
                tone="blue"
              >
                {submitting ? <LoaderCircle className="animate-spin" size={14} /> : <Send size={14} />}
                {submitting ? "生成 Word…" : submittedVersion ? `提交第 ${submittedVersion.sequence + (saveStatus === "unsaved" || saveStatus === "error" ? 1 : 0)} 版` : "提交最终版"}
              </PrimaryButton>
            ) : null}
            {isExternalArtifact ? (
              <PrimaryButton
                disabled={saveStatus === "saving" || session.saveState === "saving" || Boolean(pendingSuggestion) || Boolean(pendingDelivery)}
                onClick={() => window.dispatchEvent(new Event("openpbl:open-external-upload"))}
                size="sm"
                tone="blue"
              >
                <Send size={14} />提交成果
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </header>

      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-32 z-[59] h-3 bg-[var(--pbl-bg)]" />

      <div className={cn(
        "relative w-full flex-1 px-2 py-3 transition-[padding] duration-300 sm:px-3 lg:px-4",
        memberOpen && "xl:pr-[32rem]",
      )}>
        <section className="min-w-0 overflow-visible border-y border-[var(--pbl-border)] bg-white lg:border-x-0">
          <div className="px-1 sm:px-2">
            {documentReady ? (
              <PlateDocumentEditor
                aiCommentThreads={aiCommentThreads}
                aiContext={{
                  courseId,
                  studentId,
                  stageKey,
                  projectGoal: projectTitle,
                  currentTask: stage?.label,
                }}
                minHeight={700}
                stickyToolbarTop={140}
                workspaceLabel={isExternalArtifact ? "成果协作稿" : "文档"}
                onChange={handleDocumentChange}
                onAiCommentRead={markDocumentCommentRead}
                onAiCommentReply={replyToDocumentComment}
                onAiCommentStatusChange={updateDocumentCommentStatus}
                onAiSuggestionDecision={(decision) => {
                  resolveSuggestion(decision === "accepted" ? "adopted" : "rejected");
                }}
                onImageUpload={uploadDocumentImage}
                onOpenAiMember={() => { setMemberOpen(true); setError(null); }}
                onSelectionChange={setSelection}
                pendingAiCommentSuggestion={pendingSuggestion?.sourceThreadId ? {
                  threadId: pendingSuggestion.sourceThreadId,
                  assistantCommentId: pendingSuggestion.sourceCommentId,
                  title: pendingSuggestion.suggestion.title,
                  targetText: pendingSuggestion.suggestion.targetText,
                  replacement: pendingSuggestion.suggestion.replacement,
                  reason: pendingSuggestion.suggestion.reason,
                  error: suggestionError,
                } : undefined}
                ref={editorRef}
                value={documentHtml}
              />
            ) : null}
          </div>
          <footer className="border-t border-stone-100 px-5 py-3 text-xs text-stone-500">
            <span>{plainTextLength(documentHtml)} 字 · {isExternalArtifact ? "成果协作稿自动保存" : "当前草稿自动保存"}</span>
            {canSubmitFinal && submittedVersion ? <a className="ml-3 font-semibold text-emerald-700 hover:underline" download href={submittedVersion.downloadUrl}>下载第 {submittedVersion.sequence} 版 Word</a> : null}
          </footer>
          {historicalComments.length ? (
            <details className="border-t border-stone-100 px-5 py-3 text-xs text-stone-600">
              <summary className="cursor-pointer font-medium">批注历史 · {historicalComments.length} 条</summary>
              {commentStatusError ? <p className="mt-2 text-rose-700" role="alert">{commentStatusError}</p> : null}
              <div className="mt-3 space-y-2">
                {historicalComments.map((thread) => {
                  const status = invalidCommentIds.has(thread.id) ? "invalidated" : documentAiCommentStatus(thread);
                  const label = status === "resolved" ? "已处理" : status === "deferred" ? "暂不处理" : status === "not-applicable" ? "不适用" : "依据已失效";
                  return <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5" key={thread.id}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 flex-1 line-clamp-2 text-stone-800">{thread.comments.find((comment) => comment.role === "assistant")?.content ?? thread.targetText}</p>
                      <span className="shrink-0 text-stone-500">{label}</span>
                    </div>
                    {status !== "invalidated" ? <button className="mt-2 rounded border border-stone-300 px-2 py-1 text-stone-700 hover:bg-white" onClick={() => void updateDocumentCommentStatus({ threadId: thread.id, status: "open" }).catch(() => undefined)} type="button">重新打开</button> : null}
                  </div>;
                })}
              </div>
            </details>
          ) : null}
        </section>

        {isExternalArtifact ? (
          <div className="mt-4">
            <ExternalArtifactSubmission course={course} studentId={studentId} />
          </div>
        ) : stageKey === "make" && inferStageCollectionMode(course.stages) === "new" ? (
          <div className="mt-4">
      <FinalArtifactSubmission course={course} />
          </div>
        ) : null}

        {memberOpen ? (
          <AiMemberWorkspace
            busy={busy}
            draft={draft}
            error={error}
            historyLoaded={historyLoaded}
            messages={messages}
            memories={projectMemory.memories}
            memoryContinuation={projectMemory.continuation}
            onAcceptChange={() => resolveSuggestion("adopted")}
            onChangeDraft={(value) => { setDraft(value); setQuickIntent(null); }}
            onClose={() => setMemberOpen(false)}
            onDismissError={() => setError(null)}
            onDeleteMessage={(messageId) => { void deleteConversationMessage(messageId); }}
            onRetryMessage={retryMessage}
            onEditMessage={editMessage}
            onCancelMessage={(requestId) => { void cancelMessage(requestId); }}
            onQuickAction={(actionIntent, prompt) => {
              setQuickIntent(prompt ? actionIntent : null);
              setDraft(prompt);
              setError(null);
            }}
            onNewConversation={() => { void startNewConversation(); }}
            onRejectChange={() => resolveSuggestion("rejected")}
            onAdoptDelivery={() => resolveDelivery("adopted")}
            onRejectDelivery={() => resolveDelivery("rejected")}
            onReviseDelivery={() => resolveDelivery("revision")}
            onSubmit={submitMemberRequest}
            onUpdateMemory={projectMemory.updateMemory}
            onDeleteMemory={projectMemory.deleteMemory}
            onClearMemories={projectMemory.clearMemories}
            workspaceLabel={isExternalArtifact ? "成果协作稿" : "文档"}
            pendingChange={pendingSuggestion && !pendingSuggestion.sourceThreadId ? {
              title: pendingSuggestion.suggestion.title,
              reason: pendingSuggestion.suggestion.reason,
              operation: pendingSuggestion.suggestion.operation,
              presentation: pendingSuggestion.presentation,
              error: suggestionError,
            } : null}
            pendingDelivery={pendingDelivery ? {
              ...pendingDelivery.deliverable,
              error: pendingDelivery.error,
            } : null}
            projectTitle={projectTitle}
          />
        ) : null}
        {!memberOpen && (pendingDelivery || (pendingSuggestion && !pendingSuggestion.sourceThreadId)) ? (
          <button
            className="fixed bottom-5 right-5 z-[79] inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-xs font-semibold text-stone-900 shadow-[0_16px_48px_-18px_rgba(28,25,23,0.5)] transition hover:-translate-y-0.5 hover:shadow-xl"
            onClick={() => {
              setIntent(pendingDelivery ? "delegate" : "edit");
              setMemberOpen(true);
            }}
            type="button"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-stone-950 text-white"><FilePenLine size={14} /></span>
            {pendingDelivery ? "查看待审阅的组员交付" : "查看待确认的 AI 修改"}
          </button>
        ) : null}
        {editNotice ? (
          <div
            aria-live="polite"
            className="fixed bottom-6 left-1/2 z-[90] flex w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 shadow-[0_20px_60px_-18px_rgba(28,25,23,0.45)]"
            role="status"
          >
            <span className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full",
              editNotice.kind === "applied" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700",
            )}>
              {editNotice.kind === "applied" ? <Check size={18} /> : <RefreshCcw size={17} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-stone-900">{editNotice.kind === "applied" ? "AI 修改已应用" : "AI 修改已撤销"}</p>
              <p className="truncate text-xs text-stone-500">{editNotice.title}</p>
            </div>
            {editNotice.kind === "applied" && undoableEdit ? (
              <button
                className="shrink-0 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:border-blue-300 hover:text-blue-700"
                onClick={undoAiEdit}
                type="button"
              >
                撤销
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function SaveState({ status }: { status: "saved" | "unsaved" | "saving" | "error" }) {
  const copy = status === "saving" ? "保存中" : status === "unsaved" ? "有未保存修改" : status === "error" ? "保存失败" : "已保存";
  return (
    <span className={cn(
      "hidden items-center gap-1.5 text-xs sm:inline-flex",
      status === "error" ? "text-rose-700" : status === "unsaved" ? "text-amber-700" : "text-stone-500",
    )}>
      {status === "saving" ? <LoaderCircle className="animate-spin" size={13} /> : status === "error" ? <RefreshCcw size={13} /> : <Check size={13} />}{copy}
    </span>
  );
}

function UnavailableState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] p-6">
      <section className="max-w-md rounded-[var(--radius-lg)] border border-stone-200 bg-white p-7 text-center shadow-[var(--shadow-raised)]">
        <ShieldCheck className="mx-auto text-[var(--pbl-ai)]" size={30} />
        <h1 className="mt-4 text-xl font-bold text-stone-950">AI 协作空间暂不可用</h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">{message}</p>
        <PrimaryButton className="mt-5" onClick={onBack} tone="slate" variant="outline"><ArrowLeft size={15} />返回</PrimaryButton>
      </section>
    </div>
  );
}

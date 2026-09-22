"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";
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
} from "@/lib/ai-collaboration/document-comment-types";
import {
  documentParagraphVersionFingerprint,
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

type CollaborationMessage = AiMemberWorkspaceMessage;

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

function plainTextLength(html: string): number {
  if (typeof window === "undefined") return html.replace(/<[^>]*>/g, " ").trim().length;
  const node = window.document.createElement("div");
  node.innerHTML = html;
  return (node.textContent ?? "").replace(/\s+/g, "").length;
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
  const presence = useCoursePresence({
    courseId: course?.id,
    role: "student",
    enabled: course?.status === "teaching",
    heartbeat: true,
  });
  const stageKey = stage?.key ?? "";
  const isExternalArtifact = workspaceKind === "external-artifact";
  const workspaceNoun = isExternalArtifact ? "成果协作稿" : "文档";
  const supportedStage = stageKey === "make" && course?.status === "teaching";
  const editorRef = useRef<PlateDocumentEditorHandle>(null);
  const submissionIdRef = useRef<string | undefined>(undefined);
  const submissionVersionRef = useRef(1);
  const loadedScopeRef = useRef("");
  const proactiveRequestRef = useRef<Set<string>>(new Set());
  const analyzedParagraphsRef = useRef<Set<string>>(new Set());
  const proactiveRetryTimerRef = useRef<number | null>(null);
  const taskStarterContextRef = useRef<{ signature: string; length: number; at: number } | null>(null);
  const savedContentRef = useRef("");
  const [documentHtml, setDocumentHtml] = useState("");
  const [documentReady, setDocumentReady] = useState(false);
  const [selection, setSelection] = useState<PlateDocumentSelection | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [intent, setIntent] = useState<DocumentCollaborationIntent>("discuss");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [aiCommentThreads, setAiCommentThreads] = useState<DocumentAiCommentThread[]>([]);
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
  const [memberMode, setMemberMode] = useState<"discuss" | "task">("discuss");
  const [taskStarters, setTaskStarters] = useState<string[]>([]);
  const [taskStartersBusy, setTaskStartersBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [proactiveReviewRetry, setProactiveReviewRetry] = useState(0);
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
  const onlineCount = course
    ? course.students.filter((student) => presence.onlineStudentIds.has(student.id)).length
    : 0;

  useEffect(() => {
    if (!editNotice) return;
    const timer = window.setTimeout(
      () => setEditNotice(null),
      editNotice.kind === "applied" ? 5_000 : 3_000,
    );
    return () => window.clearTimeout(timer);
  }, [editNotice]);

  const scheduleProactiveReviewRetry = useCallback(() => {
    if (proactiveRetryTimerRef.current !== null) return;
    proactiveRetryTimerRef.current = window.setTimeout(() => {
      proactiveRetryTimerRef.current = null;
      setProactiveReviewRetry((current) => current + 1);
    }, 5_000);
  }, []);

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
    setDocumentReady(true);
    setSaveStatus(existingDocument || !isExternalArtifact ? "saved" : "unsaved");
    setSelection(null);
    setPendingSuggestion(null);
    setPendingDelivery(null);
    setDeliveryRevision(null);
    setTaskStarters([]);
    taskStarterContextRef.current = null;
    proactiveRequestRef.current = new Set();
    analyzedParagraphsRef.current = new Set();
    setAiCommentThreads([]);
    setUndoableEdit(null);
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
        }>;
        commentThreads?: DocumentAiCommentThread[];
        reviewedParagraphFingerprints?: string[];
      };
      if (controller.signal.aborted) return;
      setConversationId(payload.conversationId || "legacy");
      setMessages((payload.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role === "student" ? "user" : "assistant",
        content: message.content,
        createdAt: message.createdAt,
      })));
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

  useEffect(() => {
    if (!memberOpen || !course || !studentId || !supportedStage) return;
    const textLength = plainTextLength(documentHtml);
    const signature = `${course.id}:${stageKey}:${documentHtml.slice(0, 900)}:${documentHtml.slice(-900)}`;
    const previous = taskStarterContextRef.current;
    if (previous?.signature === signature) return;
    if (
      previous
      && Math.abs(textLength - previous.length) < 80
      && Date.now() - previous.at < 60_000
    ) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTaskStartersBusy(true);
      void fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        signal: controller.signal,
        body: JSON.stringify({
          action: "suggest-delegated-work",
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
          documentHtml,
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { starters?: string[] };
        if (!response.ok || !Array.isArray(payload.starters) || !payload.starters.length) return;
        taskStarterContextRef.current = { signature, length: textLength, at: Date.now() };
        setTaskStarters(payload.starters.slice(0, 3));
      }).catch(() => undefined).finally(() => {
        if (!controller.signal.aborted) setTaskStartersBusy(false);
      });
    }, 700);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [course, documentHtml, memberOpen, stageKey, studentId, supportedStage, workspaceKind]);

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
    if (!documentReady || !historyLoaded || !course || !studentId || !supportedStage) return;
    if (busy || pendingSuggestion || pendingDelivery) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${workspaceKind}`;
    const storageKey = `openpbl:ai-collaboration:paragraph-review:v${DOCUMENT_COMMENT_REVIEW_VERSION}:${scopeKey}`;
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

      const requests = candidatesToReview.map((candidate) => ({
        candidate,
        signature: documentParagraphVersionFingerprint(candidate.text),
      }));
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
        };
        if (!response.ok) throw new Error("PROACTIVE_COMMENT_BATCH_FAILED");
        const confirmedFingerprints = new Set(payload.reviewedParagraphFingerprints ?? []);
        const confirmedRequests = requests.filter(({ signature }) =>
          confirmedFingerprints.has(signature)
        );
        confirmedRequests.forEach(({ signature }) => analyzedParagraphsRef.current.add(signature));
        window.sessionStorage.setItem(
          storageKey,
          JSON.stringify([...analyzedParagraphsRef.current].slice(-200)),
        );
        if (confirmedRequests.length < requests.length) scheduleProactiveReviewRetry();
        const incoming = payload.commentThreads ?? [];
        if (!incoming.length) return;
        const incomingIds = new Set(incoming.map((thread) => thread.id));
        setAiCommentThreads((current) => [
          ...current.filter((thread) => !incomingIds.has(thread.id)),
          ...incoming,
        ]);
      }).catch(() => scheduleProactiveReviewRetry()).finally(() => {
        requests.forEach(({ signature }) => proactiveRequestRef.current.delete(signature));
      });
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [aiCommentThreads, busy, course, documentHtml, documentReady, historyLoaded, pendingDelivery, pendingSuggestion, proactiveReviewRetry, scheduleProactiveReviewRetry, stageKey, studentId, supportedStage, workspaceKind]);

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
    if (pendingSuggestion) {
      throw new Error("请先接受或拒绝正文中当前标出的修改，再继续回复批注。");
    }
    const sourceThread = aiCommentThreads.find((thread) => thread.id === threadId);
    if (!sourceThread) throw new Error("这条批注已经失效，请刷新页面后重试。");
    const contributionId = nowId("document-comment-ai-contribution");
    const response = await fetch("/api/ai-collaboration/document", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify({
        action: "reply-document-comment",
        commentThreadId: threadId,
        courseId: course.id,
        studentId,
        stageKey,
        workspaceKind,
        documentHtml,
        message,
        contributionId,
      }),
    });
    const payload = await response.json().catch(() => ({})) as {
      commentThread?: DocumentAiCommentThread;
      message?: string;
      result?: DocumentAiCommentReplyResult;
    };
    if (!response.ok || !payload.commentThread) {
      throw new Error(payload.message ?? "AI 组员暂时无法回复这条批注，请稍后重试。");
    }
    setAiCommentThreads((current) => [
      ...current.filter((thread) => thread.id !== payload.commentThread!.id),
      payload.commentThread!,
    ]);
    if (!payload.result?.suggestion) return;

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
  }, [aiCommentThreads, course, documentHtml, documentTitle, pendingSuggestion, session, stageKey, studentId, supportedStage, workspaceKind]);

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

  function handleDocumentChange(html: string) {
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
  ) {
    const requestText = (preset ?? draft).trim();
    if (!requestText || !course || !studentId || busy || !supportedStage) return null;
    if (pendingSuggestion) {
      setError("请先接受或拒绝正文中当前标出的修改，再继续和 AI 组员协作。");
      return null;
    }
    if (pendingDelivery) {
      setError("请先审阅、退回或暂不采用当前的组员交付，再安排下一项工作。");
      return null;
    }
    // A selection always narrows the operation to that local paragraph. The
    // server applies the same rule even if a stale client sends intent=delegate.
    const currentSelection = selectionOverride === undefined ? selection : selectionOverride;
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
    const optimistic: CollaborationMessage = {
      id: nowId("student-message"),
      role: "user",
      content: requestText,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setDraft("");
    setIntent(requestedIntent);
    setBusy(true);
    setError(null);
    setSuggestionError(null);
    const contributionId = nowId("document-ai-contribution");
    const requestId = nowId("document-ai-request");
    try {
      const response = await fetch("/api/ai-collaboration/document", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenPBL-Role": "student",
          "X-Request-Id": requestId,
        },
        body: JSON.stringify({
          courseId: course.id,
          studentId,
          stageKey,
          workspaceKind,
          conversationId,
          intent: requestedIntent,
          message: requestText,
          documentHtml,
          selectedText: selectionSnapshot?.text,
          contributionId,
          revisionOf: requestedIntent === "delegate" ? deliveryRevision : undefined,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        result?: DocumentCollaborationResponse;
        companionId?: AiContribution["companionId"];
        message?: string;
        conversationId?: string;
        messages?: Array<{ id: string; role: string }>;
      };
      if (payload.conversationId) setConversationId(payload.conversationId);
      if (!response.ok || !payload.result) {
        throw new Error(payload.message ?? "AI 组员暂时无法回应，请稍后重试。");
      }
      const assistantMessage: CollaborationMessage = {
        id: payload.messages?.find((message) => message.role === "agent")?.id
          ?? nowId("ai-message"),
        role: "assistant",
        content: payload.result.message,
        createdAt: new Date().toISOString(),
        kind: payload.result.kind,
      };
      const persistedStudentId = payload.messages?.find((message) => message.role === "student")?.id;
      setMessages((current) => [
        ...current
          .filter((message) => message.id !== optimistic.id),
        {
          ...optimistic,
          id: persistedStudentId ?? optimistic.id,
        },
        assistantMessage,
      ]);
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
      if (payload.result.suggestion && selectionSnapshot) {
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
      if (payload.result.suggestion && !selectionSnapshot && payload.result.suggestion.operation === "insert") {
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
      if (payload.result.deliverable) {
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
      recordAiInteraction({
        source: selectionSnapshot ? "selection" : "sidebar",
        eventType: "error",
        content: requestError instanceof Error ? requestError.message : "AI 组员请求失败",
        payload: { intent: requestedIntent },
      });
      setError(requestError instanceof Error ? requestError.message : "AI 组员暂时无法回应，请稍后再试。");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function submitMemberRequest() {
    const nextIntent = inferMemberIntent(draft, selection?.text);
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
      setConversationId(payload.conversationId);
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
        setMemberMode("task");
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

  return (
    <main className="flex min-h-dvh flex-col bg-[var(--pbl-bg)] pt-16 text-[var(--pbl-text)]">
      <DashboardTopBar
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
        currentStage={{ index: course.currentStageIndex, total: course.stages.length, label: stage?.label ?? "项目实践" }}
        currentTask={getCourseStageRequirements(course, stage?.key ?? "make")?.requirements || stage?.description}
        headerSlot={stage ? <StudentClassroomHeaderStatus currentIndex={course.currentStageIndex} onlineCount={onlineCount} stageLabel={stage.label} total={course.stages.length} /> : undefined}
        hideCourseSwitcher
        leadRole="学生"
        role="student"
        userName={session.studentName ?? session.user.name}
      />
      <div className="px-3"><CourseStageRequirements course={course} stageKey={stage?.key ?? "make"} /></div>
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
                onAiSuggestionDecision={(decision) => {
                  resolveSuggestion(decision === "accepted" ? "adopted" : "rejected");
                }}
                onImageUpload={uploadDocumentImage}
                onOpenAiMember={() => { setMemberOpen(true); setMemberMode("discuss"); setError(null); }}
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
            mode={memberMode}
            taskStarters={taskStarters}
            taskStartersBusy={taskStartersBusy}
            onAcceptChange={() => resolveSuggestion("adopted")}
            onChangeDraft={setDraft}
            onClose={() => setMemberOpen(false)}
            onDismissError={() => setError(null)}
            onModeChange={(mode) => {
              setMemberMode(mode);
              setIntent(mode === "task" ? "delegate" : "discuss");
              setError(null);
            }}
            onDeleteMessage={(messageId) => { void deleteConversationMessage(messageId); }}
            onNewConversation={() => { void startNewConversation(); }}
            onRejectChange={() => resolveSuggestion("rejected")}
            onAdoptDelivery={() => resolveDelivery("adopted")}
            onRejectDelivery={() => resolveDelivery("rejected")}
            onReviseDelivery={() => resolveDelivery("revision")}
            onSubmit={submitMemberRequest}
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
              setMemberMode("task");
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

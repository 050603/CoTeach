"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CourseStageRequirements } from "@/components/classroom/course-stage-requirements";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import Editor, {
  DiffEditor,
  loader,
  type Monaco,
  type OnMount,
} from "@monaco-editor/react";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  Keyboard,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { PrimaryButton } from "@/components/ui";
import {
  CodeAiMemberWorkspace,
  type CodeAiWorkspaceMessage,
} from "@/components/views/student/code-ai-member-workspace";
import { CodeAiCommentThreadPanel } from "@/components/views/student/code-ai-comment-thread";
import {
  createCodeArtifact,
  normalizeCodeFileName,
  parseCodeArtifact,
  serializeCodeArtifact,
  type CodeArtifact,
  type CodeArtifactLanguage,
} from "@/lib/ai-collaboration/code-artifact";
import type {
  CodeAiChangeSet,
  CodeCollaborationIntent,
  CodeCollaborationResponse,
  CodeRunContext,
  CodeSelection,
} from "@/lib/ai-collaboration/code-policy";
import type { CodeAiCommentThread } from "@/lib/ai-collaboration/code-comment-types";
import type { CodeRunnerResult } from "@/lib/code-runner/client";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import { cn } from "@/lib/utils";
import { collaborationBackHref } from "@/lib/system-mode";
import { DashboardTopBar } from "@/components/dashboard-shell";
import { StudentClassroomHeaderStatus } from "@/components/classroom/student-classroom-header-status";
import { useCoursePresence } from "@/hooks/use-course-presence";
import type { ProjectMemoryEntry, ProjectSupportDetails } from "@/lib/ai-collaboration/project-support-types";
import { useProjectMemory } from "@/components/views/student/use-project-memory";

loader.config({
  paths: { vs: "/api/openmaic/interactive-runtime/monaco" },
});

const MONACO_ZH_CN_URL = "/api/openmaic/interactive-runtime/monaco/nls/lang/zh-cn.js";
const PROACTIVE_REVIEW_IDLE_MS = 9_000;
const RUNNER_MARKER_OWNER = "openpbl-code-runner";

type MonacoEditor = Parameters<OnMount>[0];
type MonacoDisposable = { dispose: () => void };

function codeSubmissionTitle(language: CodeArtifactLanguage): string {
  return language === "python" ? "Python 项目代码" : "C 语言项目代码";
}

function saveStateLabel(status: "saved" | "unsaved" | "saving" | "error"): string {
  if (status === "saving") return "保存中";
  if (status === "unsaved") return "有未保存修改";
  if (status === "error") return "保存失败";
  return "已保存";
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function modelPath(courseId: string, language: CodeArtifactLanguage, filePath: string): string {
  return `file:///openpbl/${encodeURIComponent(courseId)}/${language}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeCodeForDiff(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function contentFingerprint(content: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function collaborationMessage(value: unknown): CodeAiWorkspaceMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const content = typeof record.content === "string" ? record.content : "";
  const role = record.role === "student" || record.role === "user"
    ? "user"
    : record.role === "agent" || record.role === "assistant"
      ? "assistant"
      : undefined;
  if (!id || !content || !role) return null;
  return {
    id,
    role,
    content,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    support: record.projectSupport && typeof record.projectSupport === "object"
      ? record.projectSupport as ProjectSupportDetails
      : undefined,
  };
}

function outputStatusLabel(result: CodeRunnerResult | null, running: boolean): string {
  if (running) return "运行中";
  if (!result) return "等待运行";
  if (result.status === "success") return `运行完成 · ${result.durationMs} ms`;
  if (result.status === "timeout") return `运行超时 · ${result.durationMs} ms`;
  return result.phase === "compile" ? "编译未通过" : `运行失败 · 退出码 ${String(result.exitCode)}`;
}

function applyChangeSet(artifact: CodeArtifact, changeSet: CodeAiChangeSet): CodeArtifact {
  const byPath = new Map(changeSet.changes.map((change) => [change.filePath, change]));
  const retained = artifact.files.flatMap((file) => {
    const change = byPath.get(file.path);
    if (!change) return [file];
    if (change.operation === "delete") return [];
    if (change.operation === "modify") return [{ ...file, content: change.proposedContent }];
    return [file];
  });
  const created = changeSet.changes
    .filter((change) => change.operation === "create")
    .map((change) => ({ id: nowId("ai-file"), path: change.filePath, content: change.proposedContent }));
  const files = [...retained, ...created];
  if (!files.length) return artifact;
  const activeFileId = files.some((file) => file.id === artifact.activeFileId)
    ? artifact.activeFileId
    : files[0].id;
  return { ...artifact, files, activeFileId };
}

function threadIsUnread(thread: CodeAiCommentThread): boolean {
  const latestAssistantAt = thread.comments
    .filter((comment) => comment.role === "assistant")
    .map((comment) => Date.parse(comment.createdAt))
    .sort((left, right) => right - left)[0];
  return Boolean(latestAssistantAt && (!thread.readAt || Date.parse(thread.readAt) < latestAssistantAt));
}

function threadMatchesArtifact(thread: CodeAiCommentThread, artifact: CodeArtifact): boolean {
  if (thread.resolvedAt) return false;
  const file = artifact.files.find((item) => item.path === thread.filePath);
  if (!file) return false;
  if (thread.quotedCode) return file.content.includes(thread.quotedCode);
  return thread.startLine <= Math.max(1, file.content.split("\n").length);
}

export function CodeAiCollaboration({
  courseId,
  language,
}: {
  courseId: string;
  language: CodeArtifactLanguage;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const course = useCourse(courseId);
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
  const supportedStage = stageKey === "make" && course?.status === "teaching";
  const projectMemory = useProjectMemory({
    courseId,
    studentId,
    enabled: Boolean(course && studentId && supportedStage),
  });
  const replaceProjectMemories = projectMemory.replaceMemories;
  const onlineCount = course
    ? course.students.filter((student) => presence.onlineStudentIds.has(student.id)).length
    : 0;
  const loadedScopeRef = useRef("");
  const historyScopeRef = useRef("");
  const submissionIdRef = useRef<string | undefined>(undefined);
  const savedContentRef = useRef("");
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorDisposablesRef = useRef<MonacoDisposable[]>([]);
  const findingDecorationIdsRef = useRef<string[]>([]);
  const commentThreadsRef = useRef<CodeAiCommentThread[]>([]);
  const activeCommentThreadIdRef = useRef<string | null>(null);
  const artifactRef = useRef<CodeArtifact>(createCodeArtifact(language));
  const lastReviewedArtifactRef = useRef("");
  const proactiveAbortRef = useRef<AbortController | null>(null);
  const startersAbortRef = useRef<AbortController | null>(null);
  const lastStartersFingerprintRef = useRef("");

  const [artifact, setArtifact] = useState<CodeArtifact>(() => createCodeArtifact(language));
  const [artifactReady, setArtifactReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [addingFile, setAddingFile] = useState(false);
  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [monacoLocaleStatus, setMonacoLocaleStatus] = useState<"loading" | "ready" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<CodeRunnerResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [stdin, setStdin] = useState("");
  const [consoleTab, setConsoleTab] = useState<"output" | "input">("output");
  const [filesPanelOpen, setFilesPanelOpen] = useState(true);
  const [consoleRatio, setConsoleRatio] = useState(0.28);
  const [resizingConsole, setResizingConsole] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [memberMode, setMemberMode] = useState<"discuss" | "task">("discuss");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [conversationId, setConversationId] = useState("legacy");
  const [messages, setMessages] = useState<CodeAiWorkspaceMessage[]>([]);
  const [selection, setSelection] = useState<CodeSelection | undefined>(undefined);
  const [commentThreads, setCommentThreads] = useState<CodeAiCommentThread[]>([]);
  const [activeCommentThreadId, setActiveCommentThreadId] = useState<string | null>(null);
  const [commentPanelTop, setCommentPanelTop] = useState(12);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [pendingChangeSet, setPendingChangeSet] = useState<CodeAiChangeSet | null>(null);
  const [pendingChangeSourceThreadId, setPendingChangeSourceThreadId] = useState<string | null>(null);
  const [previewChangeIndex, setPreviewChangeIndex] = useState(0);
  const [undoArtifact, setUndoArtifact] = useState<{ artifact: CodeArtifact; title: string } | null>(null);
  const codeWorkspaceStackRef = useRef<HTMLDivElement | null>(null);

  const group = course?.groups?.find((item) =>
    item.members.some((member) => member.studentId === studentId));
  const existingCode = useMemo(() => {
    if (!course || !studentId || !supportedStage) return undefined;
    return [...(course.submissions ?? [])]
      .filter((item) =>
        item.stageKey === stageKey
        && item.type === "code"
        && (
          item.studentId === studentId
          || Boolean(group?.id && item.groupId === group.id)
        )
        && Boolean(parseCodeArtifact(item.content, language)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  }, [course, group, language, stageKey, studentId, supportedStage]);
  const projectTitle = group?.topic || course?.drivingQuestion || course?.name || codeSubmissionTitle(language);
  const activeFile = artifact.files.find((file) => file.id === artifact.activeFileId) ?? artifact.files[0];
  const serializedArtifact = useMemo(() => serializeCodeArtifact(artifact), [artifact]);
  const activePreview = pendingChangeSet?.changes[previewChangeIndex];
  const previewOriginal = normalizeCodeForDiff(activePreview
    ? artifact.files.find((file) => file.path === activePreview.filePath)?.content ?? ""
    : "");
  const previewModified = normalizeCodeForDiff(activePreview?.operation === "delete" ? "" : activePreview?.proposedContent ?? "");
  const previewModelKey = activePreview
    ? `${contentFingerprint(previewOriginal)}-${contentFingerprint(previewModified)}`
    : "empty";
  const runContext: CodeRunContext = useMemo(() => runResult
    ? {
        status: runResult.status,
        phase: runResult.phase,
        exitCode: runResult.exitCode,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
      }
    : { status: "idle" }, [runResult]);
  const fallbackTaskStarters = useMemo(() => {
    const main = activeFile?.path ?? (language === "python" ? "main.py" : "main.c");
    if (runResult?.status === "failed") {
      return [
        `结合刚才的${runResult.phase === "compile" ? "编译" : "运行"}错误，帮我定位原因，但先不要改代码`,
        "为这个错误补一个能复现问题的非核心测试",
        `检查 ${main} 中是否还有同类问题`,
      ];
    }
    if (runResult?.status === "success") {
      return [
        "根据刚才的运行结果，帮我找一个还没有覆盖的边界情况",
        `检查 ${main} 的可读性和重复逻辑`,
        "帮我补充不改变核心算法的测试用例",
      ];
    }
    return [
      `先帮我检查 ${main} 是否具备可运行条件`,
      "对照项目要求，我们现在最值得先验证什么？",
      "帮我设计一个最小测试，但不要替我实现核心算法",
    ];
  }, [activeFile?.path, language, runResult]);
  const [taskStarters, setTaskStarters] = useState<string[]>([]);
  const [taskStartersFingerprint, setTaskStartersFingerprint] = useState("");
  const visibleCommentThreads = useMemo(
    () => commentThreads.filter((thread) => threadMatchesArtifact(thread, artifact)),
    [artifact, commentThreads],
  );
  const activeCommentThread = visibleCommentThreads.find((thread) => thread.id === activeCommentThreadId);
  const siblingCommentThreads = activeCommentThread
    ? visibleCommentThreads.filter((thread) => thread.filePath === activeCommentThread.filePath
      && thread.startLine === activeCommentThread.startLine)
    : [];
  const activeCommentSiblingIndex = activeCommentThread
    ? Math.max(0, siblingCommentThreads.findIndex((thread) => thread.id === activeCommentThread.id))
    : 0;
  const currentStartersFingerprint = `${serializedArtifact}:${JSON.stringify(runContext)}:${memberMode}`;
  const visibleTaskStarters = taskStartersFingerprint === currentStartersFingerprint && taskStarters.length
    ? taskStarters
    : fallbackTaskStarters;

  useEffect(() => {
    artifactRef.current = artifact;
  }, [artifact]);

  useEffect(() => {
    commentThreadsRef.current = visibleCommentThreads;
  }, [visibleCommentThreads]);

  useEffect(() => {
    activeCommentThreadIdRef.current = activeCommentThreadId;
  }, [activeCommentThreadId]);

  useEffect(() => {
    if (!hydrated) return;
    if (session.joinedCourseId && session.joinedCourseId !== courseId) router.replace("/student");
  }, [courseId, hydrated, router, session.joinedCourseId]);

  useEffect(() => {
    const localizedGlobal = globalThis as typeof globalThis & { _VSCODE_NLS_LANGUAGE?: string };
    if (localizedGlobal._VSCODE_NLS_LANGUAGE === "zh-cn") {
      const timer = window.setTimeout(() => setMonacoLocaleStatus("ready"), 0);
      return () => window.clearTimeout(timer);
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${MONACO_ZH_CN_URL}"]`);
    const script = existing ?? document.createElement("script");
    const handleLoad = () => setMonacoLocaleStatus("ready");
    const handleError = () => setMonacoLocaleStatus("error");
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    if (!existing) {
      script.src = MONACO_ZH_CN_URL;
      script.dataset.openpblMonacoLocale = "zh-cn";
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, []);

  useEffect(() => {
    if (!course || !studentId || !supportedStage) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${language}`;
    if (loadedScopeRef.current === scopeKey) return;
    loadedScopeRef.current = scopeKey;
    const initialArtifact = existingCode
      ? parseCodeArtifact(existingCode.content, language) ?? createCodeArtifact(language)
      : createCodeArtifact(language);
    const initialContent = serializeCodeArtifact(initialArtifact);
    submissionIdRef.current = existingCode?.id;
    savedContentRef.current = initialContent;
    artifactRef.current = initialArtifact;
    setArtifact(initialArtifact);
    setArtifactReady(true);
    setSaveStatus("saved");
    setAddingFile(false);
    setNewFileName("");
    setFileError(null);
    setRunResult(null);
    setRunError(null);
    setCommentThreads([]);
    setActiveCommentThreadId(null);
    setPendingChangeSet(null);
    setUndoArtifact(null);
    setSelection(undefined);
    lastReviewedArtifactRef.current = "";
    lastStartersFingerprintRef.current = "";
  }, [course, existingCode, language, stageKey, studentId, supportedStage]);

  const persistArtifact = useCallback((content: string) => {
    if (!course || !studentId || !supportedStage || content === savedContentRef.current) {
      setSaveStatus("saved");
      return;
    }
    setSaveStatus("saving");
    const title = codeSubmissionTitle(language);
    const submission = session.upsertSubmission({
      id: submissionIdRef.current,
      courseId: course.id,
      studentId,
      studentName: session.studentName ?? session.user.name,
      groupId: group?.id,
      stageKey,
      type: "code",
      title,
      content,
    });
    if (!submission) {
      setSaveStatus("error");
      return;
    }
    submissionIdRef.current = submission.id;
    savedContentRef.current = content;
    setSaveStatus("saved");
  }, [course, group, language, session, stageKey, studentId, supportedStage]);

  useEffect(() => {
    if (!artifactReady || serializedArtifact === savedContentRef.current) return;
    setSaveStatus("unsaved");
    const timer = window.setTimeout(() => persistArtifact(serializedArtifact), 900);
    return () => window.clearTimeout(timer);
  }, [artifactReady, persistArtifact, serializedArtifact]);

  useEffect(() => {
    if (!artifactReady || !course || !studentId || !supportedStage) return;
    const scopeKey = `${course.id}:${studentId}:${stageKey}:${language}`;
    if (historyScopeRef.current === scopeKey) return;
    historyScopeRef.current = scopeKey;
    setHistoryLoaded(false);
    const query = new URLSearchParams({ courseId, studentId, stageKey, language });
    void fetch(`/api/ai-collaboration/code?${query.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { messages?: unknown[]; conversationId?: string; commentThreads?: CodeAiCommentThread[]; memories?: ProjectMemoryEntry[]; message?: string };
        if (!response.ok) throw new Error(payload.message || "无法加载代码协作记录。");
        setMessages((payload.messages ?? []).map(collaborationMessage).filter((item): item is CodeAiWorkspaceMessage => Boolean(item)));
        setConversationId(payload.conversationId || "legacy");
        setCommentThreads(payload.commentThreads ?? []);
        if (payload.memories) replaceProjectMemories(payload.memories);
      })
      .catch((error) => setAiError(error instanceof Error ? error.message : "无法加载代码协作记录。"))
      .finally(() => setHistoryLoaded(true));
  }, [artifactReady, course, courseId, language, replaceProjectMemories, stageKey, studentId, supportedStage]);

  const captureSelection = useCallback((editor = editorRef.current): CodeSelection | undefined => {
    const model = editor?.getModel();
    const currentSelection = editor?.getSelection();
    if (!model || !currentSelection || currentSelection.isEmpty()) return undefined;
    const text = model.getValueInRange(currentSelection);
    if (!text.trim()) return undefined;
    const file = artifactRef.current.files.find((item) => item.id === artifactRef.current.activeFileId);
    if (!file) return undefined;
    return {
      filePath: file.path,
      startLine: currentSelection.startLineNumber,
      startColumn: currentSelection.startColumn,
      endLine: currentSelection.endLineNumber,
      endColumn: currentSelection.endColumn,
      text,
    };
  }, []);

  const syncCommentPanelPosition = useCallback((editor = editorRef.current) => {
    const threadId = activeCommentThreadIdRef.current;
    if (!editor || !threadId) return;
    const thread = commentThreadsRef.current.find((item) => item.id === threadId);
    if (!thread) return;
    const position = editor.getScrolledVisiblePosition({ lineNumber: thread.startLine, column: 1 });
    const editorHeight = editor.getLayoutInfo().height;
    const requestedTop = position ? position.top - 8 : 12;
    setCommentPanelTop(Math.max(12, Math.min(requestedTop, Math.max(12, editorHeight - 230))));
  }, []);

  const markCommentRead = useCallback((threadId: string) => {
    const readAt = new Date().toISOString();
    setCommentThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, readAt } : thread));
    void fetch("/api/ai-collaboration/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId,
        studentId,
        stageKey,
        language,
        action: "read-code-comment",
        commentThreadId: threadId,
        artifact: artifactRef.current,
      }),
    }).catch(() => undefined);
  }, [courseId, language, stageKey, studentId]);

  const openCommentThread = useCallback((thread: CodeAiCommentThread) => {
    const file = artifactRef.current.files.find((item) => item.path === thread.filePath);
    if (!file) return;
    setArtifact((current) => ({ ...current, activeFileId: file.id }));
    setActiveCommentThreadId(thread.id);
    setCommentDraft("");
    setCommentError(null);
    setMemberOpen(false);
    markCommentRead(thread.id);
    window.setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.revealLinesInCenter(thread.startLine, thread.endLine);
      editor.setPosition({ lineNumber: thread.startLine, column: 1 });
      syncCommentPanelPosition(editor);
      editor.focus();
    }, 80);
  }, [markCommentRead, syncCommentPanelPosition]);

  const openSelectionCollaboration = useCallback((kind: "discuss" | "review" | "edit") => {
    const nextSelection = captureSelection();
    if (!nextSelection) return;
    setSelection(nextSelection);
    setActiveCommentThreadId(null);
    setMemberOpen(true);
    setMemberMode(kind === "edit" ? "task" : "discuss");
    setAiError(null);
    if (kind === "review") setAiDraft("请检查我选中的代码，先准确指出具体问题和影响，不要直接修改。");
    else if (kind === "edit") setAiDraft("请针对我选中的代码提出一份局部修改，保留我的核心思路，并说明修改理由。");
    else setAiDraft("我想和你讨论这段代码。请先说说这里最值得关注的一点，再和我一起判断。");
  }, [captureSelection]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editorDisposablesRef.current.forEach((item) => item.dispose());
    editorDisposablesRef.current = [
      editor.onDidChangeCursorSelection(() => setSelection(captureSelection(editor))),
      editor.onDidScrollChange(() => syncCommentPanelPosition(editor)),
      editor.addAction({
        id: "openpbl-ai-discuss-selection",
        label: "与 AI 组员讨论所选代码",
        contextMenuGroupId: "openpbl.ai",
        contextMenuOrder: 1,
        precondition: "editorHasSelection",
        run: () => openSelectionCollaboration("discuss"),
      }),
      editor.addAction({
        id: "openpbl-ai-review-selection",
        label: "请 AI 组员检查所选代码",
        contextMenuGroupId: "openpbl.ai",
        contextMenuOrder: 2,
        precondition: "editorHasSelection",
        run: () => openSelectionCollaboration("review"),
      }),
      editor.addAction({
        id: "openpbl-ai-edit-selection",
        label: "请 AI 组员提出修改",
        contextMenuGroupId: "openpbl.ai",
        contextMenuOrder: 3,
        precondition: "editorHasSelection",
        run: () => openSelectionCollaboration("edit"),
      }),
      editor.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return;
        const currentFile = artifactRef.current.files.find((item) => item.id === artifactRef.current.activeFileId);
        const matches = commentThreadsRef.current.filter((item) =>
          item.filePath === currentFile?.path
          && item.startLine <= event.target.position!.lineNumber
          && item.endLine >= event.target.position!.lineNumber);
        const thread = matches.find(threadIsUnread) ?? matches[0];
        if (thread) openCommentThread(thread);
      }),
    ];
  }, [captureSelection, openCommentThread, openSelectionCollaboration, syncCommentPanelPosition]);

  useEffect(() => () => {
    editorDisposablesRef.current.forEach((item) => item.dispose());
    editorDisposablesRef.current = [];
    proactiveAbortRef.current?.abort();
    startersAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const relevant = visibleCommentThreads.filter((thread) => thread.filePath === activeFile?.path);
    const grouped = new Map<string, CodeAiCommentThread[]>();
    relevant.forEach((thread) => {
      const key = String(thread.startLine);
      grouped.set(key, [...(grouped.get(key) ?? []), thread]);
    });
    findingDecorationIdsRef.current = editor.deltaDecorations(
      findingDecorationIdsRef.current,
      [...grouped.values()].map((threads) => {
        const representative = threads[0];
        const unread = threads.some(threadIsUnread);
        return ({
        range: {
          startLineNumber: representative.startLine,
          startColumn: 1,
          endLineNumber: Math.max(...threads.map((thread) => thread.endLine)),
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: unread ? "openpbl-ai-code-line-unread" : "openpbl-ai-code-line-read",
          glyphMarginClassName: unread ? "openpbl-ai-code-glyph-unread" : "openpbl-ai-code-glyph-read",
          glyphMarginHoverMessage: {
            value: `**AI 组员在这里留下 ${threads.length} 条批注**\n\n${threads.map((thread) => `- ${thread.title}`).join("\n")}`,
          },
          overviewRuler: {
            color: unread ? "#f59e0b" : "#a8a29e",
            position: 2,
          },
        },
      }); }),
    );
    syncCommentPanelPosition(editor);
  }, [activeFile?.path, syncCommentPanelPosition, visibleCommentThreads]);

  useEffect(() => {
    if (
      !artifactReady
      || aiBusy
      || pendingChangeSet
      || running
      || artifact.files.every((file) => file.content.trim().length < 40)
    ) return;
    const reviewFingerprint = `${serializedArtifact}:${JSON.stringify(runContext)}`;
    if (reviewFingerprint === lastReviewedArtifactRef.current) return;
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      proactiveAbortRef.current?.abort();
      proactiveAbortRef.current = controller;
      const fingerprint = reviewFingerprint;
      void fetch("/api/ai-collaboration/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          studentId,
          stageKey,
          language,
          intent: "proactive-review",
          artifact,
          run: runContext,
        }),
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json() as { result?: CodeCollaborationResponse; commentThreads?: CodeAiCommentThread[]; message?: string };
        if (!response.ok) throw new Error(payload.message || "主动检查暂时未完成。");
        const currentFingerprint = `${serializeCodeArtifact(artifactRef.current)}:${JSON.stringify(runContext)}`;
        if (currentFingerprint === fingerprint) {
          lastReviewedArtifactRef.current = fingerprint;
          const incoming = payload.commentThreads ?? [];
          if (incoming.length) {
            setCommentThreads((current) => {
              const incomingIds = new Set(incoming.map((thread) => thread.id));
              return [...current.filter((thread) => !incomingIds.has(thread.id)), ...incoming];
            });
          }
        }
      }).catch((error) => {
        if (controller.signal.aborted) return;
        console.warn("[code-collaboration] proactive review failed", error);
      });
    }, runResult?.status === "failed" ? 1_200 : PROACTIVE_REVIEW_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [aiBusy, artifact, artifactReady, courseId, language, pendingChangeSet, runContext, runResult?.status, running, serializedArtifact, stageKey, studentId]);

  useEffect(() => {
    if (!memberOpen || !artifactReady || pendingChangeSet || aiBusy) return;
    const fingerprint = currentStartersFingerprint;
    if (lastStartersFingerprintRef.current === fingerprint) return;
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      startersAbortRef.current?.abort();
      startersAbortRef.current = controller;
      void fetch("/api/ai-collaboration/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          studentId,
          stageKey,
          language,
          action: "code-task-starters",
          mode: memberMode,
          artifact,
          run: runContext,
        }),
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json() as { starters?: string[]; message?: string };
        if (!response.ok) throw new Error(payload.message || "暂时无法生成代码建议。");
        if (payload.starters?.length) {
          setTaskStarters(payload.starters);
          setTaskStartersFingerprint(fingerprint);
        }
        lastStartersFingerprintRef.current = fingerprint;
      }).catch((error) => {
        if (!controller.signal.aborted) console.warn("[code-collaboration] starter refresh failed", error);
      });
    }, 1_600);
    return () => window.clearTimeout(timer);
  }, [aiBusy, artifact, artifactReady, courseId, currentStartersFingerprint, language, memberMode, memberOpen, pendingChangeSet, runContext, stageKey, studentId]);

  function updateActiveFile(content: string) {
    setArtifact((current) => ({
      ...current,
      files: current.files.map((file) => file.id === current.activeFileId ? { ...file, content } : file),
    }));
    setUndoArtifact(null);
  }

  function addFile() {
    const path = normalizeCodeFileName(newFileName, language);
    if (!path) {
      setFileError("请输入有效的项目内文件名");
      return;
    }
    if (artifact.files.some((file) => file.path.toLocaleLowerCase() === path.toLocaleLowerCase())) {
      setFileError("这个文件已经存在");
      return;
    }
    const id = nowId("file");
    setArtifact((current) => ({ ...current, activeFileId: id, files: [...current.files, { id, path, content: "" }] }));
    setAddingFile(false);
    setNewFileName("");
    setFileError(null);
    setSelection(undefined);
  }

  function deleteFile(fileId: string) {
    if (artifact.files.length <= 1 || pendingChangeSet) return;
    setArtifact((current) => {
      const files = current.files.filter((file) => file.id !== fileId);
      const activeFileId = current.activeFileId === fileId ? files[0].id : current.activeFileId;
      return { ...current, files, activeFileId };
    });
    setPendingDeleteFileId(null);
    setSelection(undefined);
    setActiveCommentThreadId(null);
    setRunResult(null);
    setUndoArtifact(null);
  }

  async function runCode() {
    if (running || pendingChangeSet) return;
    persistArtifact(serializedArtifact);
    setRunning(true);
    setRunError(null);
    setConsoleTab("output");
    try {
      const response = await fetch("/api/ai-collaboration/code/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, studentId, stageKey, language, artifact, stdin }),
      });
      const payload = await response.json() as CodeRunnerResult & { message?: string };
      if (!response.ok) throw new Error(payload.message || "代码没有正常启动。");
      setRunResult(payload);
      const monaco = monacoRef.current;
      if (monaco) {
        artifact.files.forEach((file) => {
          const model = monaco.editor.getModel(monaco.Uri.parse(modelPath(courseId, language, file.path)));
          if (!model) return;
          monaco.editor.setModelMarkers(
            model,
            RUNNER_MARKER_OWNER,
            payload.diagnostics.filter((item) => item.filePath === file.path).map((item) => ({
              startLineNumber: item.line,
              startColumn: item.column ?? 1,
              endLineNumber: item.line,
              endColumn: item.column ? item.column + 1 : Math.max(2, model.getLineMaxColumn(item.line)),
              severity: item.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              message: item.message,
              source: language === "c" ? "GCC" : "Python",
            })),
          );
        });
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "代码没有正常启动。");
      setRunResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function submitAiRequest(override?: { message: string; intent: CodeCollaborationIntent; selection?: CodeSelection }) {
    const requestMessage = (override?.message ?? aiDraft).trim();
    if (!requestMessage || aiBusy || pendingChangeSet) return;
    const intent = override?.intent ?? (memberMode === "task" ? "delegate" : selection ? "review" : "discuss");
    const requestSelection = override?.selection ?? selection;
    setAiBusy(true);
    setAiError(null);
    const optimisticId = nowId("student-message");
    const optimistic: CodeAiWorkspaceMessage = {
      id: optimisticId,
      role: "user",
      content: requestMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setAiDraft("");
    try {
      const response = await fetch("/api/ai-collaboration/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          studentId,
          stageKey,
          language,
          intent,
          message: requestMessage,
          artifact,
          selection: requestSelection,
          run: runContext,
          conversationId,
        }),
      });
      const payload = await response.json() as {
        result?: CodeCollaborationResponse;
        messages?: unknown[];
        conversationId?: string;
        message?: string;
        memories?: ProjectMemoryEntry[];
      };
      if (!response.ok || !payload.result) throw new Error(payload.message || "AI 组员暂时无法回应。");
      const serverMessages = (payload.messages ?? []).map(collaborationMessage).filter((item): item is CodeAiWorkspaceMessage => Boolean(item));
      const serverUser = serverMessages.find((item) => item.role === "user");
      const serverAgent = serverMessages.find((item) => item.role === "assistant");
      setMessages((current) => [
        ...current.filter((item) => item.id !== optimisticId),
        serverUser ?? optimistic,
        {
          id: serverAgent?.id ?? nowId("ai-message"),
          role: "assistant",
          content: payload.result!.message,
          createdAt: serverAgent?.createdAt ?? new Date().toISOString(),
          kind: payload.result!.kind,
          support: payload.result!.support,
        },
      ]);
      if (payload.memories) projectMemory.replaceMemories(payload.memories);
      setConversationId(payload.conversationId || conversationId);
      if (payload.result.changeSet) {
        setPendingChangeSet(payload.result.changeSet);
        setPendingChangeSourceThreadId(null);
        setPreviewChangeIndex(0);
        setMemberOpen(true);
      }
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setAiDraft(requestMessage);
      setAiError(error instanceof Error ? error.message : "AI 组员暂时无法回应。");
    } finally {
      setAiBusy(false);
    }
  }

  async function resetConversation() {
    setAiBusy(true);
    setAiError(null);
    try {
      const response = await fetch("/api/ai-collaboration/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, studentId, stageKey, language, action: "reset-conversation" }),
      });
      const payload = await response.json() as { conversationId?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || "无法开始新对话。");
      setMessages([]);
      setConversationId(payload.conversationId || "legacy");
      setSelection(undefined);
      setAiDraft("");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "无法开始新对话。");
    } finally {
      setAiBusy(false);
    }
  }

  async function deleteMessage(messageId: string) {
    const query = new URLSearchParams({ courseId, studentId, stageKey, language, messageId, conversationId });
    try {
      const response = await fetch(`/api/ai-collaboration/code?${query.toString()}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setMessages((current) => current.filter((item) => item.id !== messageId));
      projectMemory.replaceMemories((current) => current.filter((memory) =>
        !memory.sourceMessageIds.includes(messageId)));
    } catch {
      setAiError("这条消息暂时无法移除，请稍后重试。");
    }
  }

  async function submitCommentReply(override?: string) {
    const thread = activeCommentThread;
    const requestMessage = (override ?? commentDraft).trim();
    if (!thread || !requestMessage || commentBusy || pendingChangeSet) return;
    setCommentBusy(true);
    setCommentError(null);
    setCommentDraft("");
    try {
      const response = await fetch("/api/ai-collaboration/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          studentId,
          stageKey,
          language,
          action: "reply-code-comment",
          commentThreadId: thread.id,
          message: requestMessage,
          artifact,
          run: runContext,
        }),
      });
      const payload = await response.json() as {
        commentThread?: CodeAiCommentThread;
        result?: CodeCollaborationResponse;
        message?: string;
      };
      if (!response.ok || !payload.commentThread || !payload.result) throw new Error(payload.message || "AI 组员暂时无法回应这条批注。");
      setCommentThreads((current) => current.map((item) => item.id === thread.id ? { ...payload.commentThread!, readAt: new Date().toISOString() } : item));
      if (payload.result.changeSet) {
        setPendingChangeSet(payload.result.changeSet);
        setPendingChangeSourceThreadId(thread.id);
        setPreviewChangeIndex(0);
      }
      markCommentRead(thread.id);
    } catch (error) {
      setCommentDraft(requestMessage);
      setCommentError(error instanceof Error ? error.message : "AI 组员暂时无法回应这条批注。");
    } finally {
      setCommentBusy(false);
    }
  }

  function resolveCommentThread(threadId: string) {
    const resolvedAt = new Date().toISOString();
    setCommentThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, resolvedAt } : thread));
    void fetch("/api/ai-collaboration/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId, studentId, stageKey, language, action: "resolve-code-comment", commentThreadId: threadId, artifact: artifactRef.current }),
    }).catch(() => undefined);
  }

  function acceptChangeSet() {
    if (!pendingChangeSet) return;
    const before = artifact;
    const next = applyChangeSet(artifact, pendingChangeSet);
    setArtifact(next);
    setUndoArtifact({ artifact: before, title: pendingChangeSet.title });
    if (pendingChangeSourceThreadId) resolveCommentThread(pendingChangeSourceThreadId);
    setPendingChangeSet(null);
    setPendingChangeSourceThreadId(null);
    setPreviewChangeIndex(0);
    setSelection(undefined);
  }

  function rejectChangeSet() {
    if (!pendingChangeSet) return;
    setPendingChangeSet(null);
    setPendingChangeSourceThreadId(null);
    setPreviewChangeIndex(0);
  }

  function reopenChangeExplanation() {
    if (!pendingChangeSet) return;
    if (pendingChangeSourceThreadId) {
      const thread = visibleCommentThreads.find((item) => item.id === pendingChangeSourceThreadId);
      if (thread) {
        setMemberOpen(false);
        setActiveCommentThreadId(thread.id);
        setCommentError(null);
        markCommentRead(thread.id);
        return;
      }
    }
    setActiveCommentThreadId(null);
    setMemberOpen(true);
    setAiError(null);
  }

  function setClampedConsoleRatio(nextRatio: number) {
    setConsoleRatio(Math.min(0.62, Math.max(0.16, nextRatio)));
  }

  function resizeConsoleFromPointer(clientY: number) {
    const bounds = codeWorkspaceStackRef.current?.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return;
    setClampedConsoleRatio((bounds.bottom - clientY) / bounds.height);
  }

  if (!hydrated || !course) {
    return <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] text-sm text-stone-500"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={20} />正在准备代码协作空间…</span></div>;
  }

  if (!studentId || !supportedStage) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--pbl-bg)] px-6">
        <div className="max-w-md text-center">
          <Code2 className="mx-auto text-stone-400" size={28} />
          <p className="mt-3 text-sm text-stone-600">{!studentId
            ? "学生身份尚未初始化，请重新进入课堂。"
            : course.status === "finished"
              ? "课堂已经结束，协作成果现已只读保存。"
              : "代码协作目前仅在项目实践阶段开放。"}</p>
          <PrimaryButton className="mt-4" onClick={() => router.replace(collaborationBackHref(course.id))} tone="slate" variant="outline">返回课堂</PrimaryButton>
        </div>
      </div>
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
            <p className="text-[10px] font-medium leading-none text-stone-500">选题方向</p>
            <h1 className="mt-1 truncate text-base font-bold leading-tight text-stone-950 sm:text-lg">{projectTitle}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className={cn("hidden items-center gap-1.5 text-xs sm:inline-flex", saveStatus === "error" ? "text-red-600" : "text-stone-500")}>{saveStatus === "saved" ? <Check size={13} /> : null}{saveStateLabel(saveStatus)}</span>
            <PrimaryButton disabled={saveStatus === "saving"} onClick={() => persistArtifact(serializedArtifact)} size="sm" tone="slate" variant="outline"><Save size={14} />保存</PrimaryButton>
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100dvh-8rem)] flex-1 flex-col px-2 py-3 sm:px-3 lg:px-4">
        <section className="flex min-h-[calc(100dvh-9.5rem)] min-w-0 flex-1 flex-col overflow-hidden border border-stone-200 bg-white shadow-sm md:flex-row">
          <aside aria-label="项目文件" className={cn("flex w-full shrink-0 flex-col border-b border-stone-200 bg-stone-50/70 transition-[width] duration-200 md:border-b-0 md:border-r", filesPanelOpen ? "md:w-56" : "md:w-11")}>
            {filesPanelOpen ? (
              <div className="flex h-11 items-center justify-between border-b border-stone-200 px-2.5">
                <span className="pl-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">项目文件</span>
                <div className="flex items-center gap-0.5">
                  <button aria-label="新建代码文件" className="grid h-7 w-7 place-items-center rounded text-stone-500 transition hover:bg-stone-200 hover:text-stone-800" disabled={Boolean(pendingChangeSet)} onClick={() => { setAddingFile(true); setFileError(null); }} title="新建代码文件" type="button"><Plus size={15} /></button>
                  <button aria-label="折叠项目文件栏" className="grid h-7 w-7 place-items-center rounded text-stone-500 transition hover:bg-stone-200 hover:text-stone-800" onClick={() => setFilesPanelOpen(false)} title="折叠项目文件栏" type="button"><ChevronLeft size={15} /></button>
                </div>
              </div>
            ) : (
              <div className="flex h-11 items-center justify-center border-b border-stone-200">
                <button aria-label="展开项目文件栏" className="relative grid h-8 w-8 place-items-center rounded text-stone-500 transition hover:bg-stone-200 hover:text-stone-800" onClick={() => setFilesPanelOpen(true)} title="展开项目文件栏" type="button">
                  <ChevronRight size={16} />
                  {visibleCommentThreads.some(threadIsUnread) ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-500" /> : null}
                </button>
              </div>
            )}
            {filesPanelOpen ? (
            <div className="max-h-44 min-h-0 flex-1 overflow-y-auto py-1.5 md:max-h-none">
              {artifact.files.map((file) => (
                <div className={cn("group/file relative flex items-center transition", file.id === artifact.activeFileId ? "bg-stone-200/80" : "hover:bg-stone-100")} key={file.id}>
                  <button className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-2 pr-10 text-left text-sm", file.id === artifact.activeFileId ? "font-medium text-stone-950" : "text-stone-600 hover:text-stone-900")} disabled={Boolean(pendingChangeSet)} onClick={() => { setArtifact((current) => ({ ...current, activeFileId: file.id })); setSelection(undefined); setActiveCommentThreadId(null); }} type="button">
                    <FileCode2 className="shrink-0 text-stone-500" size={15} />
                    <span className="truncate">{file.path}</span>
                    {visibleCommentThreads.some((thread) => thread.filePath === file.path && threadIsUnread(thread)) ? <span className="ml-auto size-2 shrink-0 rounded-full bg-amber-500" title="有未读的 AI 组员批注" /> : null}
                  </button>
                  <button aria-label={`删除 ${file.path}`} className="absolute right-2 grid size-7 place-items-center rounded text-stone-400 transition hover:bg-white hover:text-rose-600 md:opacity-0 md:group-hover/file:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100 disabled:hidden" disabled={artifact.files.length <= 1 || Boolean(pendingChangeSet)} onClick={() => setPendingDeleteFileId(file.id)} title={artifact.files.length <= 1 ? "项目至少保留一个文件" : "删除文件"} type="button"><Trash2 size={13} /></button>
                  {pendingDeleteFileId === file.id ? (
                    <div className="absolute left-2 right-2 top-[calc(100%-2px)] z-30 rounded-lg border border-stone-200 bg-white p-2.5 text-[10px] text-stone-600 shadow-lg">
                      <p>确定删除 <strong className="font-mono text-stone-900">{file.path}</strong>？项目会自动保存这次删除。</p>
                      <div className="mt-2 flex justify-end gap-1.5"><button className="rounded px-2 py-1 hover:bg-stone-100" onClick={() => setPendingDeleteFileId(null)} type="button">取消</button><button className="rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700" onClick={() => deleteFile(file.id)} type="button">删除</button></div>
                    </div>
                  ) : null}
                </div>
              ))}
              {addingFile ? (
                <div className="mx-2 mt-1 rounded-md border border-stone-200 bg-white p-2 shadow-sm">
                  <div className="flex items-center gap-1.5"><input aria-label="新文件名" autoFocus className="h-8 min-w-0 flex-1 rounded border border-stone-300 px-2 text-xs outline-none focus:border-stone-500" onChange={(event) => { setNewFileName(event.target.value); setFileError(null); }} onKeyDown={(event) => { if (event.key === "Enter") addFile(); if (event.key === "Escape") setAddingFile(false); }} placeholder={language === "python" ? "例如 utils.py" : "例如 helper.c"} value={newFileName} /><button aria-label="创建文件" className="grid h-8 w-8 place-items-center rounded bg-stone-800 text-white" onClick={addFile} type="button"><Check size={14} /></button><button aria-label="取消新建" className="grid h-8 w-8 place-items-center rounded text-stone-500 hover:bg-stone-100" onClick={() => setAddingFile(false)} type="button"><X size={14} /></button></div>
                  {fileError ? <p className="mt-1.5 text-[11px] text-red-600">{fileError}</p> : null}
                </div>
              ) : null}
            </div>
            ) : (
              <button aria-label="展开项目文件栏" className="mx-auto mt-2 grid h-8 w-8 place-items-center rounded text-stone-500 transition hover:bg-stone-200 hover:text-stone-800" onClick={() => setFilesPanelOpen(true)} title="项目文件" type="button"><FileCode2 size={16} /></button>
            )}
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-white px-3 py-1">
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-stone-500">
                {pendingChangeSet ? <Sparkles className="text-sky-600" size={14} /> : <Code2 size={14} />}
                <span>{pendingChangeSet ? "修改预览" : language === "python" ? "Python" : "C 语言"}</span><ChevronRight size={12} /><span className="truncate font-medium text-stone-800">{pendingChangeSet ? activePreview?.filePath : activeFile?.path}</span>
              </div>
              <div className="flex items-center gap-2">
                {pendingChangeSet ? (
                  <>
                    {pendingChangeSet.changes.length > 1 ? (
                      <div className="flex h-8 items-center rounded-md border border-stone-200 bg-white">
                        <button aria-label="查看上一个修改文件" className="grid size-7 place-items-center text-stone-500 hover:bg-stone-50 hover:text-stone-900 disabled:opacity-30" disabled={previewChangeIndex === 0} onClick={() => setPreviewChangeIndex((current) => Math.max(0, current - 1))} type="button"><ChevronLeft size={13} /></button>
                        <span className="min-w-10 text-center text-[10px] font-medium text-stone-500">{previewChangeIndex + 1}/{pendingChangeSet.changes.length}</span>
                        <button aria-label="查看下一个修改文件" className="grid size-7 place-items-center text-stone-500 hover:bg-stone-50 hover:text-stone-900 disabled:opacity-30" disabled={previewChangeIndex >= pendingChangeSet.changes.length - 1} onClick={() => setPreviewChangeIndex((current) => Math.min(pendingChangeSet.changes.length - 1, current + 1))} type="button"><ChevronRight size={13} /></button>
                      </div>
                    ) : null}
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 text-xs font-medium text-stone-700 transition hover:bg-stone-50" onClick={reopenChangeExplanation} title="重新查看 AI 组员的修改说明" type="button"><Bot size={14} /><span className="hidden lg:inline">查看说明</span></button>
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 text-xs font-medium text-stone-700 transition hover:bg-stone-50" onClick={rejectChangeSet} title="拒绝本次修改，保留原代码" type="button"><X size={14} /><span className="hidden sm:inline">保留原代码</span></button>
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-stone-950 px-2.5 text-xs font-semibold text-white transition hover:bg-stone-800" onClick={acceptChangeSet} title="接受并写入全部修改" type="button"><CheckCircle2 size={14} /><span className="hidden sm:inline">接受修改</span></button>
                  </>
                ) : (
                  <>
                    {undoArtifact ? (
                      <div className="flex h-8 items-center gap-1.5 rounded-md bg-emerald-50 px-2 text-[10px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200" title={`已应用 AI 组员修改“${undoArtifact.title}”`}>
                        <Check size={12} />
                        <span className="hidden xl:inline">已应用修改</span>
                        <button className="inline-flex h-6 items-center gap-1 rounded px-1.5 font-semibold text-emerald-900 hover:bg-emerald-100" onClick={() => { setArtifact(undoArtifact.artifact); setUndoArtifact(null); setPendingChangeSet(null); }} type="button"><RotateCcw size={11} />撤销</button>
                      </div>
                    ) : null}
                    <span className="hidden text-[10px] text-stone-400 xl:inline">{language === "python" ? "运行 main.py（缺失时运行当前文件），支持项目内导入" : "编译项目内全部 .c 文件"}</span>
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-50" onClick={() => { setMemberOpen(true); setActiveCommentThreadId(null); setAiError(null); }} type="button"><Bot size={14} />AI 组员</button>
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-stone-950 px-3 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40" disabled={running} onClick={() => { void runCode(); }} type="button">{running ? <LoaderCircle className="animate-spin" size={13} /> : <Play size={13} />}{running ? "运行中" : "运行"}</button>
                  </>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col" ref={codeWorkspaceStackRef}>
            <div className="relative min-h-48 flex-1 bg-white">
              {pendingChangeSet && activePreview ? (
                <DiffEditor
                  height="100%"
                  language={language === "python" ? "python" : "cpp"}
                  modified={previewModified}
                  modifiedModelPath={`file:///openpbl-ai-preview/${language}/modified/${encodeURIComponent(activePreview.filePath)}-${previewChangeIndex}-${previewModelKey}`}
                  options={{
                    automaticLayout: true,
                    diffAlgorithm: "advanced",
                    diffWordWrap: "on",
                    enableSplitViewResizing: true,
                    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace",
                    fontSize: 13,
                    glyphMargin: true,
                    hideUnchangedRegions: {
                      contextLineCount: 3,
                      enabled: true,
                      minimumLineCount: 8,
                      revealLineCount: 5,
                    },
                    ignoreTrimWhitespace: true,
                    lineHeight: 21,
                    minimap: { enabled: false },
                    originalEditable: false,
                    readOnly: true,
                    renderSideBySide: true,
                    scrollBeyondLastLine: false,
                  }}
                  original={previewOriginal}
                  originalModelPath={`file:///openpbl-ai-preview/${language}/original/${encodeURIComponent(activePreview.filePath)}-${previewChangeIndex}-${previewModelKey}`}
                  theme="vs"
                />
              ) : artifactReady && activeFile && monacoLocaleStatus === "ready" ? (
                <Editor
                  height="100%"
                  keepCurrentModel
                  language={language === "python" ? "python" : "cpp"}
                  loading={<div className="flex h-full items-center justify-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在加载代码编辑器…</div>}
                  onChange={(value) => updateActiveFile(value ?? "")}
                  onMount={handleEditorMount}
                  options={{
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    cursorSmoothCaretAnimation: "on",
                    folding: true,
                    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace",
                    fontSize: 14,
                    glyphMargin: true,
                    lineHeight: 22,
                    minimap: { enabled: true, showSlider: "mouseover" },
                    padding: { top: 18, bottom: 24 },
                    renderWhitespace: "selection",
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    stickyScroll: { enabled: true },
                    tabSize: 4,
                    wordWrap: "on",
                  }}
                  path={modelPath(courseId, language, activeFile.path)}
                  saveViewState
                  theme="vs"
                  value={activeFile.content}
                />
              ) : monacoLocaleStatus === "error" ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-stone-500"><span>代码编辑器中文资源加载失败，请刷新页面重试。</span><PrimaryButton onClick={() => window.location.reload()} size="sm" tone="slate" variant="outline">重新加载</PrimaryButton></div>
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-stone-500"><LoaderCircle className="animate-spin" size={18} />正在加载代码编辑器…</div>
              )}

              {activeCommentThread ? (
                <CodeAiCommentThreadPanel
                  busy={commentBusy}
                  changeSet={pendingChangeSourceThreadId === activeCommentThread.id ? pendingChangeSet : null}
                  draft={commentDraft}
                  error={commentError}
                  onAcceptChangeSet={acceptChangeSet}
                  onChangeDraft={setCommentDraft}
                  onClose={() => { setActiveCommentThreadId(null); setCommentDraft(""); setCommentError(null); }}
                  onNavigate={(direction) => {
                    if (!siblingCommentThreads.length) return;
                    const index = (activeCommentSiblingIndex + direction + siblingCommentThreads.length) % siblingCommentThreads.length;
                    openCommentThread(siblingCommentThreads[index]);
                  }}
                  onPreviewChange={setPreviewChangeIndex}
                  onRejectChangeSet={rejectChangeSet}
                  onRequestEdit={() => { void submitCommentReply(`请针对“${activeCommentThread.title}”提出一份局部修改，保留我的核心思路，并说明修改理由。`); }}
                  onSubmit={() => { void submitCommentReply(); }}
                  positionTop={commentPanelTop}
                  previewChangeIndex={previewChangeIndex}
                  siblingCount={siblingCommentThreads.length}
                  siblingIndex={activeCommentSiblingIndex}
                  thread={activeCommentThread}
                />
              ) : null}
            </div>

            <div
              aria-label="调整代码编辑区与运行面板的高度"
              aria-orientation="horizontal"
              aria-valuemax={62}
              aria-valuemin={16}
              aria-valuenow={Math.round(consoleRatio * 100)}
              className={cn(
                "group relative z-20 h-2 shrink-0 cursor-row-resize touch-none bg-stone-200 outline-none transition-colors hover:bg-sky-200 focus-visible:bg-sky-200",
                resizingConsole && "bg-sky-300",
              )}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setClampedConsoleRatio(consoleRatio + 0.04);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setClampedConsoleRatio(consoleRatio - 0.04);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setClampedConsoleRatio(0.16);
                } else if (event.key === "End") {
                  event.preventDefault();
                  setClampedConsoleRatio(0.62);
                }
              }}
              onPointerCancel={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                setResizingConsole(false);
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setResizingConsole(true);
                resizeConsoleFromPointer(event.clientY);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                resizeConsoleFromPointer(event.clientY);
              }}
              onPointerUp={(event) => {
                resizeConsoleFromPointer(event.clientY);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                setResizingConsole(false);
              }}
              role="separator"
              tabIndex={0}
              title="拖动调整代码区与运行面板高度"
            >
              <span className="absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-400 transition-colors group-hover:bg-sky-600 group-focus-visible:bg-sky-600" />
            </div>

            <div className="min-h-[7.5rem] max-h-[62%] shrink-0 bg-stone-950 text-stone-300" style={{ height: `${consoleRatio * 100}%` }}>
              <div className="flex h-10 items-center justify-between border-b border-stone-800 px-3">
                <div className="flex h-full items-center gap-1">
                  <button className={cn("inline-flex h-full items-center gap-1.5 border-b-2 px-2 text-xs font-medium", consoleTab === "output" ? "border-white text-white" : "border-transparent text-stone-500 hover:text-stone-300")} onClick={() => setConsoleTab("output")} type="button"><TerminalSquare size={14} />运行结果</button>
                  <button className={cn("inline-flex h-full items-center gap-1.5 border-b-2 px-2 text-xs font-medium", consoleTab === "input" ? "border-white text-white" : "border-transparent text-stone-500 hover:text-stone-300")} onClick={() => setConsoleTab("input")} type="button"><Keyboard size={14} />标准输入</button>
                </div>
                <span className={cn("inline-flex items-center gap-1.5 text-[10px]", running ? "text-sky-300" : runResult?.status === "success" ? "text-emerald-400" : runResult || runError ? "text-rose-400" : "text-stone-500")}>{running ? <LoaderCircle className="animate-spin" size={11} /> : runResult?.status === "success" ? <Check size={11} /> : runResult || runError ? <CircleAlert size={11} /> : <Square size={9} />}{runError || outputStatusLabel(runResult, running)}</span>
              </div>
              {consoleTab === "input" ? (
                <div className="h-[calc(100%-2.5rem)] p-3"><textarea className="h-full w-full resize-none rounded-md border border-stone-700 bg-stone-900 px-3 py-2 font-mono text-xs leading-5 text-stone-200 outline-none placeholder:text-stone-600 focus:border-stone-500" maxLength={32000} onChange={(event) => setStdin(event.target.value)} placeholder="需要 input() 或 scanf() 时，在这里预先输入；每行会按顺序提供给程序。" value={stdin} /></div>
              ) : (
                <pre className="h-[calc(100%-2.5rem)] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-stone-300">{running ? "正在安全沙箱中编译并运行…" : runError ? runError : runResult ? [runResult.stdout, runResult.stderr].filter(Boolean).join(runResult.stdout && runResult.stderr ? "\n" : "") || "程序已正常结束，没有输出。" : "点击“运行”后，Python 或 C 代码会在无网络、有限时、有限资源的独立沙箱中执行。"}</pre>
              )}
            </div>
            </div>
          </div>
        </section>
      </div>

      {memberOpen ? (
        <CodeAiMemberWorkspace
          busy={aiBusy}
          changeSet={pendingChangeSet}
          draft={aiDraft}
          error={aiError}
          historyLoaded={historyLoaded}
          messages={messages}
          memories={projectMemory.memories}
          memoryContinuation={projectMemory.continuation}
          mode={memberMode}
          onAcceptChangeSet={acceptChangeSet}
          onChangeDraft={setAiDraft}
          onClearSelection={() => setSelection(undefined)}
          onClose={() => setMemberOpen(false)}
          onDeleteMessage={(id) => { void deleteMessage(id); }}
          onDismissError={() => setAiError(null)}
          onModeChange={(mode) => { setMemberMode(mode); setAiError(null); }}
          onNewConversation={() => { void resetConversation(); }}
          onPreviewChange={setPreviewChangeIndex}
          onRejectChangeSet={rejectChangeSet}
          onSubmit={() => { void submitAiRequest(); }}
          onUpdateMemory={projectMemory.updateMemory}
          onDeleteMemory={projectMemory.deleteMemory}
          onClearMemories={projectMemory.clearMemories}
          previewChangeIndex={previewChangeIndex}
          projectTitle={projectTitle}
          selection={selection}
          starters={visibleTaskStarters}
        />
      ) : null}
    </main>
  );
}

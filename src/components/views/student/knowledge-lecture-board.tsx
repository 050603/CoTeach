"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Bot,
  CheckCircle2,
  CircleHelp,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Play,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import type {
  KnowledgeLectureAttempt,
  KnowledgeLectureTutorThread,
} from "@/lib/session/types";
import type { KnowledgeLectureExplanation } from "@/lib/courses/knowledge-explanation-types";
import { createLearningEvent, postLearningEvents } from "@/lib/learning-analytics/telemetry";
import { browserRandomUUID } from "@/lib/browser/random-uuid";
import { cn } from "@/lib/utils";
import { dispatchPlaybackModalBlock } from "@openmaic/lib/playback/activity-events";
import styles from "./knowledge-lecture-board.module.css";

/** Keep the same receipt across a lost response or a page reload. */
export async function fetchTutor(body: Record<string, unknown>): Promise<Response> {
  const key = `knowledge-tutor-request:${JSON.stringify([body.courseId, body.studentId, body.attemptId, body.questionId, body.action, body.message ?? ""])}`;
  let requestId = browserRandomUUID();
  try { requestId = sessionStorage.getItem(key) || requestId; sessionStorage.setItem(key, requestId); } catch { /* memory-only retry when storage is unavailable */ }
  const serialized = JSON.stringify({ ...body, requestId });
  const deadline = Date.now() + 190_000;
  let networkFailures = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch("/api/knowledge-lecture", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" }, body: serialized, signal: AbortSignal.timeout(Math.max(1, Math.min(165_000, deadline - Date.now()))) });
      networkFailures = 0;
    } catch (error) {
      if (++networkFailures >= 3 || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (response.status === 202 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    const terminalFailure = response.status === 503
      && ["TUTOR_REQUEST_FAILED", "TUTOR_REQUEST_CANCELLED", "TUTOR_REQUEST_TIMEOUT"].includes((await response.clone().json().catch(() => ({}))).error);
    if ((response.ok && response.status !== 202) || response.status === 409 || terminalFailure) {
      try { sessionStorage.removeItem(key); } catch { /* no persistent cache */ }
    }
    return response;
  }
}

type TutorAudioSettings = {
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
};

type AudioQueueItem = { id: string; text: string; audioUrl?: string; allowSynthesis: boolean };

function normalizedBoardText(value: string): string {
  return value.replace(/[\s，。；：、,.!?！？;:]/g, "").toLowerCase();
}

function explanationText(attempt: KnowledgeLectureAttempt, questionIndex: number): string {
  const question = attempt.questions[questionIndex];
  if (!question) return "";
  return [
    `我们来看第${questionIndex + 1}题。${question.prompt}`,
    question.options?.length
      ? `选项：${question.options.map((option) => `${option.value}. ${option.label}`).join("；")}`
      : question.matchingOptions
        ? `左侧项目：${question.matchingOptions.left.join("；")}。右侧候选：${question.matchingOptions.right.join("；")}`
        : "",
    `你的回答是：${question.answer || "没有作答"}。`,
    question.feedback,
    question.referenceAnswer ? `参考思路是：${question.referenceAnswer}` : "",
  ].filter(Boolean).join("\n");
}

function boardItems(
  question: KnowledgeLectureAttempt["questions"][number],
  thread: KnowledgeLectureTutorThread | undefined,
  explanation: KnowledgeLectureExplanation | undefined,
  shared: boolean,
): Array<{ id: string; title: string; body: string }> {
  const candidates = [
    ...(!shared ? [{ id: "grading", title: question.gradingStatus === "failed" || question.gradingStatus === "pending"
      ? "批阅待完成" : question.questionType === "short_answer" ? "评分反馈" : question.correct ? "得分关键" : "问题定位", body: question.feedback },
    ...(question.referenceAnswer
      ? [{ id: "reference", title: "正确思路", body: question.referenceAnswer }]
      : [])] : []),
    ...(explanation?.boardNotes ?? []).map((note) => ({ id: `prepared:${note.id}`, title: note.title, body: note.body })),
    ...(shared && !explanation ? [
      ...(question.authoredAnalysis ? [{ id: "analysis", title: "原题解析", body: question.authoredAnalysis }] : []),
      ...(question.referenceAnswer ? [{ id: "reference", title: "参考答案", body: question.referenceAnswer }] : []),
    ] : []),
    ...(!shared || thread?.messages.some((item) => item.role === "student")
      ? (thread?.boardNotes ?? []).map((note) => ({ id: `private:${note.id}`, title: shared ? `追问补充 · ${note.title}` : note.title, body: note.body }))
      : []),
  ];
  const seen: string[] = explanation?.text ? [normalizedBoardText(explanation.text)] : [];
  return candidates.filter((item) => {
    const normalized = normalizedBoardText(item.body);
    const duplicate = seen.some((existing) =>
      existing === normalized
      || (existing.length > 12 && normalized.length > 12
        && (existing.includes(normalized) || normalized.includes(existing))),
    );
    if (!normalized || duplicate) return false;
    seen.push(normalized);
    return true;
  });
}

export function KnowledgeLectureBoard({
  attempt,
  courseId,
  studentId,
  knowledgePointNames,
  initialThreads,
  initialQuestionId,
  onClose,
}: {
  attempt: KnowledgeLectureAttempt;
  courseId: string;
  studentId: string;
  knowledgePointNames: ReadonlyMap<string, string>;
  initialThreads: KnowledgeLectureTutorThread[];
  initialQuestionId?: string;
  onClose: () => void;
}) {
  const preferredIndex = initialQuestionId
    ? attempt.questions.findIndex((question) => question.questionId === initialQuestionId)
    : attempt.questions.findIndex((question) => question.correct === false);
  const [questionIndex, setQuestionIndex] = useState(Math.max(0, preferredIndex));
  const [threads, setThreads] = useState(initialThreads);
  const [explanations, setExplanations] = useState<Record<string, KnowledgeLectureExplanation>>({});
  const [loadedQuestions, setLoadedQuestions] = useState<string[]>([]);
  const [failedQuestions, setFailedQuestions] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingExplanations, setPendingExplanations] = useState<string[]>([]);
  const [explanationRetry, setExplanationRetry] = useState(0);
  const [error, setError] = useState<string>();
  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const audioSettingsRef = useRef<Promise<TutorAudioSettings | undefined> | undefined>(undefined);
  const activeSynthesisAbortRef = useRef<AbortController | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const audioQueueRef = useRef<AudioQueueItem[]>([]);
  const queuedAudioIdsRef = useRef(new Set<string>());
  const drainingAudioRef = useRef(false);
  const playbackGenerationRef = useRef(0);
  const activePlaybackResolveRef = useRef<(() => void) | undefined>(undefined);
  const audioSequenceRef = useRef(0);
  const requestedExplanationRef = useRef(new Set<string>());
  const viewedExplanationsRef = useRef(new Set<string>());
  const question = attempt.questions[questionIndex] ?? attempt.questions[0];
  const activeQuestionRef = useRef(question?.questionId);
  useEffect(() => { activeQuestionRef.current = question?.questionId; }, [question?.questionId]);
  const initialExplaining = pendingExplanations.includes(question?.questionId ?? "");
  const thread = threads.find((item) =>
    item.attemptId === attempt.id && item.questionId === question?.questionId,
  );
  const explanation = explanations[question?.questionId ?? ""];
  const sharedExplanation = Boolean(explanation) || question?.questionType !== "short_answer"
    || question?.questionFormat === "fill_blank"
    || (!question?.questionFormat && !loadedQuestions.includes(question?.questionId ?? ""));
  const knowledgePoints = useMemo(
    () => question?.knowledgePointIds.map((id) => knowledgePointNames.get(id) ?? id) ?? [],
    [knowledgePointNames, question],
  );
  const items = useMemo(() => question ? boardItems(question, thread, explanation, sharedExplanation) : [], [question, thread, explanation, sharedExplanation]);

  useEffect(() => {
    dispatchPlaybackModalBlock({ blocked: true, source: "knowledge-lecture-tutor" });
    return () => dispatchPlaybackModalBlock({ blocked: false, source: "knowledge-lecture-tutor" });
  }, []);

  useEffect(() => {
    if (!question) return;
    const key = `${attempt.id}:${question.questionId}`;
    if (requestedExplanationRef.current.has(key)) return;
    requestedExplanationRef.current.add(key);
    const questionId = question.questionId;
    setPendingExplanations(current => [...current, questionId]);
    setFailedQuestions(current => current.filter(id => id !== questionId));
    setError(undefined);
    const body = {
        action: "tutor-explain",
        courseId,
        studentId,
        attemptId: attempt.id,
        questionId: question.questionId,
        options: question.options,
        matchingOptions: question.matchingOptions,
    };
    // Unknown legacy short answers may still need durable deep-answer polling.
    // Legacy fill blanks return their shared resource before any personal claim.
    const needsTutorReceipt = question.questionType === "short_answer" && question.questionFormat !== "fill_blank";
    const request = needsTutorReceipt ? fetchTutor(body) : fetch("/api/knowledge-lecture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    void request.then(async (response) => {
      const payload = await response.json() as { explanation?: KnowledgeLectureExplanation; thread?: KnowledgeLectureTutorThread; error?: string };
      if (!response.ok || (!payload.explanation && !payload.thread)) throw new Error(payload.error || "助教讲解暂时不可用");
      if (payload.explanation) {
        setExplanations((current) => ({ ...current, [questionId]: payload.explanation! }));
      }
      if (payload.thread) setThreads((current) => [
          ...current.filter((item) => item.id !== payload.thread!.id),
          payload.thread!,
        ]);
      setLoadedQuestions((current) => [...current, questionId]);
    }).catch(() => {
      requestedExplanationRef.current.delete(key);
      setFailedQuestions(current => [...current, questionId]);
      if (activeQuestionRef.current === questionId) setError("助教讲解暂时无法加载，原题仍可查看。请点击重试讲解重新加载。");
    }).finally(() => setPendingExplanations(current => current.filter(id => id !== questionId)));
  }, [attempt.id, courseId, question, studentId, explanationRetry]);

  useEffect(() => {
    if (!question || !explanation) return;
    const key = `${attempt.id}:${question.questionId}:${explanation.id}`;
    if (viewedExplanationsRef.current.has(key)) return;
    viewedExplanationsRef.current.add(key);
    void postLearningEvents({ courseId, studentId, events: [createLearningEvent("knowledge_explanation_view", {
      courseId, studentId, stageKey: "ai-learning", sceneId: attempt.runtimeSceneId,
      content: { knowledgePointIds: question.knowledgePointIds },
      metadata: { attemptId: attempt.id, questionId: question.questionId, explanationId: explanation.id,
        questionFingerprint: explanation.questionFingerprint, source: explanation.source },
    })] }).catch(() => undefined);
  }, [attempt.id, attempt.runtimeSceneId, courseId, studentId, question, explanation]);

  useEffect(() => {
    return () => {
      playbackGenerationRef.current += 1;
      audioQueueRef.current = [];
      activeSynthesisAbortRef.current?.abort();
      activePlaybackResolveRef.current?.();
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
    };
  }, []);

  async function playAudioUrl(url: string, generation: number): Promise<void> {
    const audio = new Audio(url);
    audioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        activePlaybackResolveRef.current = undefined;
        if (error) reject(error);
        else resolve();
      };
      activePlaybackResolveRef.current = () => finish();
      audio.onplay = () => {
        if (generation === playbackGenerationRef.current) setAudioState("playing");
      };
      audio.onpause = () => {
        if (!audio.ended && generation === playbackGenerationRef.current) setAudioState("paused");
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("语音播放失败"));
      void audio.play().catch((error: unknown) => finish(error instanceof Error ? error : new Error("语音播放失败")));
    });
  }

  async function speakInBrowser(text: string, generation: number, speed = 1): Promise<void> {
    if (!("speechSynthesis" in window)) throw new Error("当前设备不支持语音播放");
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activePlaybackResolveRef.current = undefined;
        resolve();
      };
      activePlaybackResolveRef.current = finish;
      utterance.lang = "zh-CN";
      utterance.rate = speed;
      utterance.onstart = () => {
        if (generation === playbackGenerationRef.current) setAudioState("playing");
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  }

  async function playAudioItem(item: AudioQueueItem, generation: number): Promise<void> {
    const clean = item.text.trim();
    if (!clean || generation !== playbackGenerationRef.current) return;
    setAudioState("loading");
    try {
      if (item.audioUrl) {
        try {
          await playAudioUrl(item.audioUrl, generation);
          return;
        } catch {
          if (generation !== playbackGenerationRef.current) return;
          audioRef.current = undefined;
          // Prepared narration stays local when its stored audio is unavailable.
        }
      }
      const audioSettings = item.allowSynthesis
        ? await (audioSettingsRef.current ??= fetch("/api/knowledge-lecture/settings")
          .then(async (response) => response.ok ? (await response.json()).settings as TutorAudioSettings : undefined)
          .catch(() => undefined))
        : undefined;
      if (generation !== playbackGenerationRef.current) return;
      if (item.allowSynthesis && audioSettings?.ttsProviderId && audioSettings.ttsProviderId !== "browser-native-tts" && audioSettings.ttsVoice) {
        const controller = new AbortController();
        activeSynthesisAbortRef.current = controller;
        const response = await fetch("/api/openmaic/generate/tts", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: clean.slice(0, 3_500),
            audioId: `knowledge_tutor_${attempt.id}_${question.questionId}_${audioSequenceRef.current++}`,
            ttsProviderId: audioSettings.ttsProviderId,
            ttsScenario: "realtime-interaction",
            ttsModelId: audioSettings.ttsModelId,
            ttsVoice: audioSettings.ttsVoice,
            ttsSpeed: audioSettings.ttsSpeed ?? 1,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (activeSynthesisAbortRef.current === controller) activeSynthesisAbortRef.current = undefined;
        const base64 = payload?.base64 ?? payload?.data?.base64;
        const format = payload?.format ?? payload?.data?.format ?? "mp3";
        if (!response.ok || !base64) throw new Error("语音生成失败");
        if (generation !== playbackGenerationRef.current) return;
        await playAudioUrl(`data:audio/${format};base64,${base64}`, generation);
        return;
      }
      await speakInBrowser(clean, generation, audioSettings?.ttsSpeed);
    } catch (cause) {
      if (generation !== playbackGenerationRef.current) return;
      setAudioState("idle");
      setError(cause instanceof Error ? `${cause.message}，可点击播放按钮重试。` : "语音播放失败");
    }
  }

  async function drainAudioQueue() {
    if (drainingAudioRef.current) return;
    drainingAudioRef.current = true;
    const generation = playbackGenerationRef.current;
    try {
      while (generation === playbackGenerationRef.current && audioQueueRef.current.length) {
        const next = audioQueueRef.current.shift();
        if (next) await playAudioItem(next, generation);
      }
    } finally {
      drainingAudioRef.current = false;
      if (generation === playbackGenerationRef.current) {
        audioRef.current = undefined;
        setAudioState("idle");
      }
      if (audioQueueRef.current.length) void drainAudioQueue();
    }
  }

  function enqueueAudio(item: AudioQueueItem) {
    if (!item.text.trim() || queuedAudioIdsRef.current.has(item.id)) return;
    queuedAudioIdsRef.current.add(item.id);
    audioQueueRef.current.push(item);
    void drainAudioQueue();
  }

  function stopAudioQueue() {
    playbackGenerationRef.current += 1;
    audioQueueRef.current = [];
    activeSynthesisAbortRef.current?.abort();
    activeSynthesisAbortRef.current = undefined;
    activePlaybackResolveRef.current?.();
    activePlaybackResolveRef.current = undefined;
    audioRef.current?.pause();
    audioRef.current = undefined;
    window.speechSynthesis?.cancel();
    setAudioState("idle");
  }

  const firstAssistantMessage = thread?.messages[0]?.role === "assistant" ? thread.messages[0] : undefined;
  const coreNarration = explanation?.text
    || (!sharedExplanation && loadedQuestions.includes(question?.questionId ?? "")
      ? firstAssistantMessage?.content || explanationText(attempt, questionIndex)
      : "");

  useEffect(() => {
    if (!question || !coreNarration) return;
    enqueueAudio({ id: `core:${question.questionId}`, text: coreNarration,
      audioUrl: explanation?.audioUrl, allowSynthesis: !sharedExplanation });
    // Historical follow-ups remain readable; only sendMessage queues a new reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.questionId, coreNarration, explanation?.audioUrl, sharedExplanation]);

  async function sendMessage() {
    const content = message.trim();
    const sendingQuestionId = question?.questionId;
    if (!content || !question || sending || initialExplaining) return;
    stopAudioQueue();
    setSending(true);
    setError(undefined);
    try {
      const response = await fetchTutor({
        action: "tutor-message", courseId, studentId, attemptId: attempt.id,
        questionId: question.questionId, options: question.options,
        matchingOptions: question.matchingOptions, message: content,
      });
      const payload = await response.json() as { thread?: KnowledgeLectureTutorThread; error?: string };
      if (!response.ok || !payload.thread) throw new Error(payload.error || "助教暂时没有回应");
      const existingMessageIds = new Set(thread?.messages.map((item) => item.id));
      setThreads((current) => [
        ...current.filter((item) => item.id !== payload.thread!.id),
        payload.thread!,
      ]);
      if (activeQuestionRef.current === sendingQuestionId) {
        setMessage("");
        const reply = payload.thread.messages.findLast((item) => item.role === "assistant");
        if (reply && !existingMessageIds.has(reply.id)) {
          enqueueAudio({ id: `message:${reply.id}`, text: reply.content, allowSynthesis: true });
        }
      }
    } catch (cause) {
      if (activeQuestionRef.current === sendingQuestionId) setError(cause instanceof Error ? cause.message : "助教暂时没有回应");
    } finally {
      setSending(false);
    }
  }

  function toggleAudio() {
    if (audioRef.current) {
      if (audioState === "playing") audioRef.current.pause();
      else void audioRef.current.play();
      return;
    }
    if (audioState === "playing") {
      window.speechSynthesis.pause();
      setAudioState("paused");
    } else if (audioState === "paused") {
      window.speechSynthesis.resume();
      setAudioState("playing");
    } else {
      enqueueAudio({ id: `manual:${question.questionId}:${audioSequenceRef.current++}`, text: coreNarration,
        audioUrl: explanation?.audioUrl, allowSynthesis: !sharedExplanation });
    }
  }

  function replayCoreExplanation() {
    stopAudioQueue();
    enqueueAudio({ id: `replay:${question.questionId}:${audioSequenceRef.current++}`, text: coreNarration,
      audioUrl: explanation?.audioUrl, allowSynthesis: !sharedExplanation });
  }

  function selectQuestion(index: number) {
    if (index === questionIndex) return;
    stopAudioQueue();
    const nextQuestion = attempt.questions[index];
    activeQuestionRef.current = nextQuestion?.questionId;
    if (nextQuestion) queuedAudioIdsRef.current.delete(`core:${nextQuestion.questionId}`);
    setError(undefined);
    setQuestionIndex(index);
  }

  function closeBoard() {
    stopAudioQueue();
    onClose();
  }

  const firstStudentMessageIndex = thread?.messages.findIndex((item) => item.role === "student") ?? -1;
  const chatMessages = sharedExplanation
    ? firstStudentMessageIndex >= 0 ? thread!.messages.slice(firstStudentMessageIndex) : []
    : thread?.messages ?? [];

  if (!question) return null;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) closeBoard(); }}>
      {/* Keep the dialog inside the player so native fullscreen contains it too. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-[140] grid place-items-center bg-stone-950/55 p-2 backdrop-blur-sm sm:p-5">
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(styles.dialog, "flex h-[min(900px,calc(100dvh-16px))] w-full max-w-[1500px] flex-col overflow-hidden rounded-[18px] border border-white/20 bg-[#eef0eb] shadow-2xl sm:h-[min(900px,calc(100dvh-40px))]")}
        onOpenAutoFocus={(event) => {
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          closeButtonRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <DialogPrimitive.Title className="sr-only">助教题目讲解</DialogPrimitive.Title>
        <header className={cn(styles.header, "flex min-h-16 shrink-0 items-center gap-3 border-b border-stone-300 bg-white px-4 py-3 sm:px-5")}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-950 text-white"><Bot size={19} /></span>
          <div className="shrink-0">
            <h2 className="text-sm font-black text-stone-950 sm:text-base">伴学助教</h2>
          </div>
          <nav className={cn(styles.questions, "mx-auto flex min-w-0 flex-1 justify-center gap-1.5 overflow-x-auto px-2")} aria-label="小测题目切换">
            {attempt.questions.map((item, index) => (
                  <button className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-bold", index === questionIndex ? "border-cyan-900 bg-cyan-950 text-white" : item.gradingStatus === "pending" || item.gradingStatus === "failed" ? "border-sky-200 bg-sky-50 text-sky-800" : item.questionType === "short_answer" ? "border-cyan-200 bg-cyan-50 text-cyan-800" : item.correct ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800")} key={item.questionId} onClick={() => selectQuestion(index)} type="button">
                {item.correct ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}第 {index + 1} 题
              </button>
            ))}
          </nav>
          <div className={cn(styles.audioControls, "flex shrink-0 items-center gap-2")}>
            {failedQuestions.includes(question.questionId) && !initialExplaining && (
              <button className="inline-flex h-9 items-center rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-900" type="button"
                onClick={() => { requestedExplanationRef.current.delete(`${attempt.id}:${question.questionId}`); setExplanationRetry(value => value + 1); }}>重试讲解</button>
            )}
            <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-xs font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-60" disabled={!coreNarration} onClick={replayCoreExplanation} type="button">
              <RotateCcw size={15} />再听一遍
            </button>
            <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 text-xs font-bold text-cyan-900 disabled:opacity-60" disabled={audioState === "loading" || !coreNarration} onClick={toggleAudio} type="button">
              {audioState === "loading" ? <Loader2 className="animate-spin" size={15} /> : audioState === "playing" ? <Pause size={15} /> : <Play size={15} />}
              {audioState === "playing" ? "暂停播放" : audioState === "paused" ? "继续播放" : audioState === "loading" ? "正在准备" : "播放讲解"}
            </button>
          </div>
          <button ref={closeButtonRef} className={cn(styles.close, "grid size-9 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100")} onClick={closeBoard} type="button" aria-label="关闭讲解"><X size={19} /></button>
        </header>

        <div className={styles.body}>
          <main className={cn(styles.board, "flex min-h-0 flex-col p-3 sm:p-4")}>
            <section aria-label="题目与板书解析" className={cn(styles.notes, "relative min-h-0 flex-1 overflow-y-auto rounded-xl border-[10px] border-[#6f4b32] bg-[#153d35] px-5 py-6 text-[#f5f2df] shadow-[inset_0_0_30px_rgba(0,0,0,.35),0_12px_30px_rgba(31,41,35,.18)] sm:px-8 sm:py-7")}>
              <div className="pointer-events-none absolute inset-0 opacity-[.07]" style={{ backgroundImage: "radial-gradient(circle at 20% 30%,white 0,transparent 1px)", backgroundSize: "17px 19px" }} />
              <div className="relative mx-auto max-w-5xl space-y-7 font-editorial">
                <section className="border-b border-dashed border-white/30 pb-5">
                  <p className="text-xs font-bold tracking-[.16em] text-emerald-200">原始题目</p>
                  <p className="mt-2 whitespace-pre-wrap text-lg font-semibold leading-8 sm:text-xl">{question.prompt}</p>
                  {question.options?.length ? (
                    <ol aria-label="题目选项" className="mt-4 grid gap-2 text-sm leading-6 sm:text-base">
                      {question.options.map((option) => (
                        <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2" key={option.value}>
                          <span className="font-bold text-emerald-200">{option.value}</span>
                          <span className="whitespace-pre-wrap text-white/90">{option.label}</span>
                        </li>
                      ))}
                    </ol>
                  ) : question.matchingOptions ? (
                    <div aria-label="题目匹配项" className="mt-4 grid gap-3 text-sm leading-6 sm:grid-cols-2 sm:text-base">
                      {(["left", "right"] as const).map((side) => (
                        <div className="rounded-lg border border-white/15 bg-white/5 p-3" key={side}>
                          <p className="mb-2 font-bold text-emerald-200">{side === "left" ? "左侧项目" : "右侧候选"}</p>
                          <ol className="space-y-1.5">{question.matchingOptions![side].map((label, index) => <li className="whitespace-pre-wrap text-white/90" key={`${side}-${index}`}>{label}</li>)}</ol>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
                <section className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-bold tracking-[.16em] text-sky-200">{sharedExplanation ? "题目讲解" : "板书解析"}</p>
                    {knowledgePoints.map((name) => <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70" key={name}>{name}</span>)}
                  </div>
                  {explanation ? <p aria-label="统一题目讲解" className="whitespace-pre-wrap text-base leading-8 text-white/95">{explanation.text}</p> : null}
                  <ol className="space-y-5 text-base leading-8">
                    {items.map((item, index) => (
                      <li className="grid grid-cols-[34px_minmax(0,1fr)] gap-3" key={item.id}>
                        <span className="pt-0.5 font-mono text-sm font-bold text-amber-200">{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <p className="text-sm font-bold text-sky-200">{item.title}</p>
                          <p className="mt-1 whitespace-pre-wrap text-white/90">{item.body}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {sending || initialExplaining ? <p role="status" className="inline-flex items-center gap-2 text-sm text-emerald-200"><Loader2 className="animate-spin" size={16} />{initialExplaining ? "正在加载题目讲解…" : "助教正在回答你的追问…"}</p> : null}
                </section>
                <section className="rounded-lg border border-white/15 bg-white/5 px-4 py-3">
                  <p className="text-xs font-bold tracking-[.16em] text-amber-200">你的回答 · 对照查看</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-7 text-white/80">{question.answer || "未作答"}</p>
                </section>
              </div>
            </section>
          </main>

          <aside aria-label="助教追问" className={cn(styles.chat, "flex flex-col border-t border-stone-300 bg-white lg:border-l lg:border-t-0")}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <p className="text-xs font-bold text-stone-500">针对这道题继续追问</p>
              {chatMessages.length ? chatMessages.map((item) => <div className={cn("max-w-[92%] whitespace-pre-wrap rounded-xl p-3 text-sm leading-6", item.role === "student" ? "ml-auto rounded-tr-sm bg-cyan-950 text-white" : "rounded-tl-sm bg-stone-100 text-stone-800")} key={item.id}>{item.content}</div>)
                : <p className="text-sm leading-6 text-stone-500">听完讲解后，可以告诉助教你对哪个选项或解题步骤还有疑问。</p>}
            </div>
            <div className="border-t border-stone-100 p-3">
              <div className="mb-2 flex gap-1.5 overflow-x-scroll pb-2 [scrollbar-color:#94a3b8_#e7e5e4] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-stone-200">{["我错在哪一步？", "请换个简单例子", "帮我梳理答题关键词"].map((prompt) => <button className="inline-flex h-7 min-w-[124px] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-stone-100 px-2.5 text-[10px] font-bold text-stone-600 hover:bg-stone-200" key={prompt} onClick={() => setMessage(prompt)} type="button"><MessageCircleQuestion size={11} />{prompt}</button>)}</div>
              <div className="flex gap-2">
                <textarea className="min-h-20 min-w-0 flex-1 resize-none rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm outline-none focus:border-cyan-700 focus:bg-white" maxLength={1000} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); } }} placeholder="把不明白的地方告诉助教…" value={message} />
                <button className="grid w-11 shrink-0 place-items-center rounded-xl bg-cyan-950 text-white disabled:opacity-40" disabled={!message.trim() || sending || initialExplaining} onClick={() => void sendMessage()} type="button" aria-label="发送追问">{sending || initialExplaining ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}</button>
              </div>
              {error ? <p className="mt-2 text-xs font-semibold text-rose-700">{error}</p> : null}
            </div>
          </aside>
        </div>
      </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Root>
  );
}

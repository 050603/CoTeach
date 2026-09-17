"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import { dispatchPlaybackModalBlock } from "@openmaic/lib/playback/activity-events";

type TutorAudioSettings = {
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
};

type AudioQueueItem = { id: string; text: string };

function normalizedBoardText(value: string): string {
  return value.replace(/[\s，。；：、,.!?！？;:]/g, "").toLowerCase();
}

function explanationText(attempt: KnowledgeLectureAttempt, questionIndex: number): string {
  const question = attempt.questions[questionIndex];
  if (!question) return "";
  return [
    `我们来看第${questionIndex + 1}题。${question.prompt}`,
    `你的回答是：${question.answer || "没有作答"}。`,
    question.feedback,
    question.referenceAnswer ? `参考思路是：${question.referenceAnswer}` : "",
  ].filter(Boolean).join("\n");
}

function boardItems(
  question: KnowledgeLectureAttempt["questions"][number],
  thread: KnowledgeLectureTutorThread | undefined,
): Array<{ id: string; title: string; body: string }> {
  const candidates = [
    { id: "grading", title: question.correct ? "得分关键" : "问题定位", body: question.feedback },
    ...(question.referenceAnswer
      ? [{ id: "reference", title: "正确思路", body: question.referenceAnswer }]
      : []),
    ...(thread?.boardNotes ?? []).map((note) => ({ id: note.id, title: note.title, body: note.body })),
  ];
  const seen: string[] = [];
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
    : attempt.questions.findIndex((question) => !question.correct);
  const [questionIndex, setQuestionIndex] = useState(Math.max(0, preferredIndex));
  const [threads, setThreads] = useState(initialThreads);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [initialExplaining, setInitialExplaining] = useState(false);
  const [error, setError] = useState<string>();
  const [audioSettings, setAudioSettings] = useState<TutorAudioSettings>();
  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const audioQueueRef = useRef<AudioQueueItem[]>([]);
  const queuedAudioIdsRef = useRef(new Set<string>());
  const drainingAudioRef = useRef(false);
  const playbackGenerationRef = useRef(0);
  const activePlaybackResolveRef = useRef<(() => void) | undefined>(undefined);
  const audioSequenceRef = useRef(0);
  const requestedExplanationRef = useRef(new Set<string>());
  const question = attempt.questions[questionIndex] ?? attempt.questions[0];
  const thread = threads.find((item) =>
    item.attemptId === attempt.id && item.questionId === question?.questionId,
  );
  const knowledgePoints = useMemo(
    () => question?.knowledgePointIds.map((id) => knowledgePointNames.get(id) ?? id) ?? [],
    [knowledgePointNames, question],
  );
  const items = useMemo(() => question ? boardItems(question, thread) : [], [question, thread]);

  useEffect(() => {
    dispatchPlaybackModalBlock({ blocked: true, source: "knowledge-lecture-tutor" });
    return () => dispatchPlaybackModalBlock({ blocked: false, source: "knowledge-lecture-tutor" });
  }, []);

  useEffect(() => {
    if (!question || thread?.messages.some((item) => item.role === "assistant")) return;
    const key = `${attempt.id}:${question.questionId}`;
    if (requestedExplanationRef.current.has(key)) return;
    requestedExplanationRef.current.add(key);
    setInitialExplaining(true);
    void fetch("/api/knowledge-lecture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify({
        action: "tutor-explain",
        courseId,
        studentId,
        attemptId: attempt.id,
        questionId: question.questionId,
      }),
    }).then(async (response) => {
      const payload = await response.json() as { thread?: KnowledgeLectureTutorThread; error?: string };
      if (!response.ok || !payload.thread) throw new Error(payload.error || "助教讲解生成失败");
      setThreads((current) => [
        ...current.filter((item) => item.id !== payload.thread!.id),
        payload.thread!,
      ]);
    }).catch((cause) => {
      requestedExplanationRef.current.delete(key);
      setError(cause instanceof Error ? cause.message : "助教讲解生成失败");
    }).finally(() => setInitialExplaining(false));
  }, [attempt.id, courseId, question, studentId, thread?.messages]);

  useEffect(() => {
    void fetch("/api/knowledge-lecture/settings")
      .then((response) => response.ok ? response.json() : undefined)
      .then((payload) => setAudioSettings(payload?.settings))
      .catch(() => undefined);
    return () => {
      playbackGenerationRef.current += 1;
      audioQueueRef.current = [];
      activePlaybackResolveRef.current?.();
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
    };
  }, []);

  async function playAudioItem(text: string, generation: number): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    setAudioState("loading");
    try {
      if (audioSettings?.ttsProviderId && audioSettings.ttsProviderId !== "browser-native-tts" && audioSettings.ttsVoice) {
        const response = await fetch("/api/openmaic/generate/tts", {
          method: "POST",
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
        const base64 = payload?.base64 ?? payload?.data?.base64;
        const format = payload?.format ?? payload?.data?.format ?? "mp3";
        if (!response.ok || !base64) throw new Error("语音生成失败");
        if (generation !== playbackGenerationRef.current) return;
        const audio = new Audio(`data:audio/${format};base64,${base64}`);
        audioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            activePlaybackResolveRef.current = undefined;
            resolve();
          };
          activePlaybackResolveRef.current = finish;
          audio.onplay = () => setAudioState("playing");
          audio.onpause = () => {
            if (!audio.ended && generation === playbackGenerationRef.current) setAudioState("paused");
          };
          audio.onended = finish;
          audio.onerror = () => reject(new Error("语音播放失败"));
          void audio.play().catch(reject);
        });
        return;
      }
      if ("speechSynthesis" in window) {
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(clean);
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            activePlaybackResolveRef.current = undefined;
            resolve();
          };
          activePlaybackResolveRef.current = finish;
          utterance.lang = "zh-CN";
          utterance.rate = audioSettings?.ttsSpeed ?? 1;
          utterance.onstart = () => setAudioState("playing");
          utterance.onend = finish;
          utterance.onerror = finish;
          window.speechSynthesis.speak(utterance);
        });
        return;
      }
      throw new Error("当前设备不支持语音播放");
    } catch (cause) {
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
        if (next) await playAudioItem(next.text, generation);
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
    activePlaybackResolveRef.current?.();
    activePlaybackResolveRef.current = undefined;
    audioRef.current?.pause();
    audioRef.current = undefined;
    window.speechSynthesis?.cancel();
    setAudioState("idle");
  }

  const firstAssistantMessage = thread?.messages.find((item) => item.role === "assistant");
  const coreNarration = firstAssistantMessage?.content
    || (!initialExplaining ? explanationText(attempt, questionIndex) : "");

  useEffect(() => {
    if (!audioSettings || !question) return;
    enqueueAudio({ id: `core:${question.questionId}`, text: coreNarration });
    const spokenAssistantTexts = new Set(
      firstAssistantMessage ? [normalizedBoardText(firstAssistantMessage.content)] : [],
    );
    for (const item of thread?.messages ?? []) {
      if (item.role === "assistant" && item.id !== firstAssistantMessage?.id) {
        const normalized = normalizedBoardText(item.content);
        if (spokenAssistantTexts.has(normalized)) continue;
        spokenAssistantTexts.add(normalized);
        enqueueAudio({ id: `message:${item.id}`, text: item.content });
      }
    }
    // Queue helpers intentionally serialize the configured TTS and new tutor replies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSettings, attempt, question, questionIndex, thread?.messages]);

  async function sendMessage() {
    const content = message.trim();
    if (!content || !question || sending || initialExplaining) return;
    setSending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/knowledge-lecture", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
        body: JSON.stringify({
          action: "tutor-message",
          courseId,
          studentId,
          attemptId: attempt.id,
          questionId: question.questionId,
          message: content,
        }),
      });
      const payload = await response.json() as { thread?: KnowledgeLectureTutorThread; error?: string };
      if (!response.ok || !payload.thread) throw new Error(payload.error || "助教暂时没有回应");
      setThreads((current) => [
        ...current.filter((item) => item.id !== payload.thread!.id),
        payload.thread!,
      ]);
      setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "助教暂时没有回应");
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
      enqueueAudio({ id: `manual:${question.questionId}:${audioSequenceRef.current++}`, text: coreNarration });
    }
  }

  function replayCoreExplanation() {
    stopAudioQueue();
    enqueueAudio({ id: `replay:${question.questionId}:${audioSequenceRef.current++}`, text: coreNarration });
  }

  function selectQuestion(index: number) {
    if (index === questionIndex) return;
    stopAudioQueue();
    const nextQuestion = attempt.questions[index];
    if (nextQuestion) queuedAudioIdsRef.current.delete(`core:${nextQuestion.questionId}`);
    setQuestionIndex(index);
  }

  if (!question) return null;

  return (
    <div className="fixed inset-0 z-[140] grid place-items-center bg-stone-950/55 p-2 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label="助教题目讲解">
      <div className="flex h-[min(900px,calc(100dvh-16px))] w-full max-w-[1500px] flex-col overflow-hidden rounded-[18px] border border-white/20 bg-[#eef0eb] shadow-2xl sm:h-[min(900px,calc(100dvh-40px))]">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-stone-300 bg-white px-4 py-3 sm:px-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-cyan-950 text-white"><Bot size={19} /></span>
          <div className="shrink-0">
            <h2 className="text-sm font-black text-stone-950 sm:text-base">伴学助教</h2>
          </div>
          <nav className="mx-auto flex min-w-0 flex-1 justify-center gap-1.5 overflow-x-auto px-2" aria-label="小测题目切换">
            {attempt.questions.map((item, index) => (
              <button className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-bold", index === questionIndex ? "border-cyan-900 bg-cyan-950 text-white" : item.correct ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800")} key={item.questionId} onClick={() => selectQuestion(index)} type="button">
                {item.correct ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}第 {index + 1} 题
              </button>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-xs font-bold text-stone-700 hover:bg-stone-50" onClick={replayCoreExplanation} type="button">
              <RotateCcw size={15} />重新讲解
            </button>
            <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-200 bg-cyan-50 px-3 text-xs font-bold text-cyan-900 disabled:opacity-60" disabled={audioState === "loading"} onClick={toggleAudio} type="button">
              {audioState === "loading" ? <Loader2 className="animate-spin" size={15} /> : audioState === "playing" ? <Pause size={15} /> : <Play size={15} />}
              {audioState === "playing" ? "暂停播放" : audioState === "paused" ? "继续播放" : audioState === "loading" ? "正在准备" : "继续播放"}
            </button>
          </div>
          <button className="grid size-9 place-items-center rounded-full text-stone-500 hover:bg-stone-100" onClick={onClose} type="button" aria-label="关闭讲解"><X size={19} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_340px]">
          <main className="flex min-h-0 flex-col p-3 sm:p-4">
            <section className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border-[10px] border-[#6f4b32] bg-[#153d35] px-5 py-6 text-[#f5f2df] shadow-[inset_0_0_30px_rgba(0,0,0,.35),0_12px_30px_rgba(31,41,35,.18)] sm:px-8 sm:py-7">
              <div className="pointer-events-none absolute inset-0 opacity-[.07]" style={{ backgroundImage: "radial-gradient(circle at 20% 30%,white 0,transparent 1px)", backgroundSize: "17px 19px" }} />
              <div className="relative mx-auto max-w-5xl space-y-7 font-editorial">
                <section className="border-b border-dashed border-white/30 pb-5">
                  <p className="text-xs font-bold tracking-[.16em] text-emerald-200">原始题目</p>
                  <p className="mt-2 text-lg font-semibold leading-8 sm:text-xl">{question.prompt}</p>
                </section>
                <section className="border-b border-dashed border-white/30 pb-5">
                  <p className="text-xs font-bold tracking-[.16em] text-amber-200">学生回答</p>
                  <p className="mt-2 whitespace-pre-wrap text-base leading-8 text-white/90">{question.answer || "未作答"}</p>
                </section>
                <section className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-bold tracking-[.16em] text-sky-200">板书解析</p>
                    {knowledgePoints.map((name) => <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/70" key={name}>{name}</span>)}
                  </div>
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
                    {sending || initialExplaining ? <p className="inline-flex items-center gap-2 text-sm text-emerald-200"><Loader2 className="animate-spin" size={16} />助教正在继续书写和讲解…</p> : null}
                  </ol>
                </section>
              </div>
            </section>
          </main>

          <aside className="flex min-h-[280px] flex-col border-t border-stone-300 bg-white lg:min-h-0 lg:border-l lg:border-t-0">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {(thread?.messages ?? []).map((item) => <div className={cn("max-w-[92%] rounded-xl p-3 text-sm leading-6", item.role === "student" ? "ml-auto rounded-tr-sm bg-cyan-950 text-white" : "rounded-tl-sm bg-stone-100 text-stone-800")} key={item.id}>{item.content}</div>)}
            </div>
            <div className="border-t border-stone-100 p-3">
              <div className="mb-2 flex gap-1.5 overflow-x-scroll pb-2 [scrollbar-color:#94a3b8_#e7e5e4] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-stone-200">{["我错在哪一步？", "请换个简单例子", "帮我梳理答题关键词"].map((prompt) => <button className="inline-flex h-7 min-w-[124px] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-stone-100 px-2.5 text-[10px] font-bold text-stone-600 hover:bg-stone-200" key={prompt} onClick={() => setMessage(prompt)} type="button"><MessageCircleQuestion size={11} />{prompt}</button>)}</div>
              <div className="flex gap-2">
                <textarea className="min-h-20 flex-1 resize-none rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm outline-none focus:border-cyan-700 focus:bg-white" maxLength={1000} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="把不明白的地方告诉助教…" value={message} />
                <button className="grid w-11 place-items-center rounded-xl bg-cyan-950 text-white disabled:opacity-40" disabled={!message.trim() || sending || initialExplaining} onClick={() => void sendMessage()} type="button" aria-label="发送追问">{sending || initialExplaining ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}</button>
              </div>
              {error ? <p className="mt-2 text-xs font-semibold text-rose-700">{error}</p> : null}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

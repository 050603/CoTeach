"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  Send,
  X,
} from "lucide-react";
import { dispatchPlaybackModalBlock } from "@openmaic/lib/playback/activity-events";
import { cn } from "@/lib/utils";
import type { PublicDiscussionSnapshot, PublicDiscussionStatus } from "@/lib/public-discussion/types";
import { subscribePublicDiscussionUpdates } from "@/lib/public-discussion/realtime-client";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const studentStatusLabels: Partial<Record<PublicDiscussionStatus, string>> = {
  inviting: "等待接受邀请",
  "awaiting-student": "等待回答",
  recording: "正在回答",
  transcribing: "正在识别",
  "awaiting-retry": "请重新回答",
  "awaiting-confirmation": "请重新回答",
  "ai-generating": "AI 正在思考",
  "ai-ready": "AI 回应待播放",
  "ai-completion-ready": "AI 回应待播放",
  "awaiting-teacher-confirmation": "等待教师确认",
  "ai-failed": "AI 回应失败",
  "awaiting-replacement": "等待重新点名",
  paused: "讨论已暂停",
  summarizing: "正在生成总结",
  ended: "讨论已结束",
};

function uuid(): string {
  return crypto.randomUUID();
}

async function parseResponse(response: Response): Promise<PublicDiscussionSnapshot> {
  const payload = await response.json().catch(() => ({})) as PublicDiscussionSnapshot & { message?: string };
  if (!response.ok) throw new Error(payload.message || "课堂讨论操作失败");
  return payload;
}

export function PublicDiscussionStudentOverlay({ courseId }: { courseId: string }) {
  const [snapshot, setSnapshot] = useState<PublicDiscussionSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState("");
  const [textFallbackMode, setTextFallbackMode] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [dismissedSessionId, setDismissedSessionId] = useState<string>();
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const recordingVersionRef = useRef<number | undefined>(undefined);
  const discardRecordingRef = useRef(false);
  const startingRecordingRef = useRef(false);
  const autoStartedVersionsRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/public-discussion`, {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": "student" },
    });
    if (response.status === 404) return;
    setSnapshot(await parseResponse(response));
  }, [courseId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load().catch(() => undefined), 0);
    const unsubscribe = subscribePublicDiscussionUpdates(courseId, () => void load().catch(() => undefined));
    const timer = window.setInterval(() => void load().catch(() => undefined), 2_500);
    return () => {
      unsubscribe();
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [courseId, load]);

  const session = snapshot?.session;
  const visible = Boolean(
    snapshot?.enabled
    && session
    && (session.status !== "ended" || dismissedSessionId !== session.id),
  );

  useEffect(() => {
    if (!session?.id || activeSessionIdRef.current === session.id) return;
    activeSessionIdRef.current = session.id;
    const timer = window.setTimeout(() => {
      setTextFallbackMode(false);
      setAnswer("");
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [session?.id]);

  useEffect(() => {
    if (!visible) return;
    dispatchPlaybackModalBlock({ blocked: true, source: "public-discussion" });
    document.querySelectorAll("audio").forEach((audio) => audio.pause());
    window.speechSynthesis?.cancel();
    return () => dispatchPlaybackModalBlock({ blocked: false, source: "public-discussion" });
  }, [visible]);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    setRecordingSeconds(0);
  }, []);

  useEffect(() => () => {
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopTracks();
  }, [stopTracks]);

  useEffect(() => {
    if (startingRecordingRef.current) return;
    if (!session || (session.status === "recording" && session.isCurrentStudent)) return;
    if (recorderRef.current?.state === "recording") {
      discardRecordingRef.current = true;
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = undefined;
  }, [session]);

  async function post(body: Record<string, unknown>): Promise<PublicDiscussionSnapshot> {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/public-discussion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "student" },
      body: JSON.stringify(body),
    });
    return parseResponse(response);
  }

  async function respondToInvitation(response: "accept" | "decline", useText = false) {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      if (response === "accept" && !useText) {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("当前浏览器或连接不支持麦克风录音，请改用 HTTPS 入口或文字回答。");
        }
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        permissionStream.getTracks().forEach((track) => track.stop());
        setTextFallbackMode(false);
      } else if (response === "accept") {
        setTextFallbackMode(true);
      }
      setSnapshot(await post({ action: response, requestId: uuid(), expectedVersion: session.version }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "邀请响应失败");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function uploadRecording(blob: Blob, expectedVersion: number) {
    if (discardRecordingRef.current) return;
    setBusy(true);
    setError(undefined);
    try {
      const form = new FormData();
      form.append("audio", blob, "classroom-answer.webm");
      form.append("requestId", uuid());
      form.append("expectedVersion", String(expectedVersion));
      const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/public-discussion/transcription`, {
        method: "POST",
        headers: { "X-OpenPBL-Role": "student" },
        body: form,
      });
      const payload = await response.json().catch(() => ({})) as {
        text?: string;
        snapshot?: PublicDiscussionSnapshot;
        message?: string;
      };
      if (payload.snapshot) setSnapshot(payload.snapshot);
      if (!response.ok || !payload.text) throw new Error(payload.message || "语音识别失败");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语音识别失败，请重新回答或改用文字");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    const current = snapshot?.session;
    if (
      !current
      || !current.isCurrentStudent
      || !["awaiting-student", "awaiting-retry", "awaiting-confirmation"].includes(current.status)
      || startingRecordingRef.current
    ) return;
    startingRecordingRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器或连接不支持麦克风录音，请改用 HTTPS 入口。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      streamRef.current = stream;
      const next = await post({ action: "start-recording", requestId: uuid(), expectedVersion: current.version });
      setSnapshot(next);
      recordingVersionRef.current = next.session?.version;
      discardRecordingRef.current = false;
      chunksRef.current = [];
      const supportedType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: supportedType });
      recorderRef.current = recorder;
      setRecordingSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const discarded = discardRecordingRef.current;
        const blob = new Blob(chunksRef.current, { type: supportedType });
        const version = recordingVersionRef.current;
        stopTracks();
        recorderRef.current = undefined;
        if (!discarded && version && blob.size) void uploadRecording(blob, version);
      };
      recorder.start(500);
      timerRef.current = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1_000);
    } catch (cause) {
      stopTracks();
      setTextFallbackMode(true);
      setError(cause instanceof Error ? cause.message : "无法使用麦克风，请检查权限");
    } finally {
      startingRecordingRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (
      !session
      || !session.isCurrentStudent
      || session.status !== "awaiting-student"
      || textFallbackMode
    ) return;
    const key = `${session.id}:${session.version}`;
    if (autoStartedVersionsRef.current.has(key)) return;
    autoStartedVersionsRef.current.add(key);
    const timer = window.setTimeout(() => void startRecording(), 150);
    return () => window.clearTimeout(timer);
    // Automatic capture is keyed to the server's semantic session version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.isCurrentStudent, session?.status, session?.version, textFallbackMode]);

  function stopRecording() {
    if (recorderRef.current?.state !== "recording") return;
    discardRecordingRef.current = false;
    recorderRef.current.stop();
  }

  async function submitTextAnswer() {
    if (!session || !answer.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await post({
        action: "submit-answer",
        requestId: uuid(),
        expectedVersion: session.version,
        content: answer.trim(),
        source: "text",
      });
      setSnapshot(next);
      setAnswer("");
      setTextFallbackMode(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回答提交失败");
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (!visible || !session) return null;
  const canRetry = session.isCurrentStudent
    && ["awaiting-retry", "awaiting-confirmation"].includes(session.status);
  const canAnswer = session.isCurrentStudent
    && ["awaiting-student", "awaiting-retry", "awaiting-confirmation"].includes(session.status);
  const teacherState = session.status === "ended"
    ? "本次公开讨论已结束"
    : session.status === "paused"
      ? "讨论暂时停在这里"
      : session.status === "awaiting-replacement"
        ? "等待老师点名下一位同学"
        : session.status === "ai-generating"
          ? "虚拟老师正在快速思考…"
          : session.status === "ai-ready" || session.status === "ai-completion-ready"
            ? "请听教师大屏上的虚拟老师回应"
            : session.status === "awaiting-teacher-confirmation"
              ? "正在等待老师确认是否结束"
              : session.status === "recording"
                ? "虚拟老师正在认真聆听"
                : session.status === "transcribing"
                  ? "正在理解你的回答…"
                  : session.status === "summarizing"
                    ? "正在整理本次讨论总结…"
                    : session.status === "inviting" && session.isCurrentStudent
                      ? "老师邀请你参加公开讨论"
                      : session.status === "awaiting-student" && session.isCurrentStudent
                        ? "现在轮到你回答"
                        : "虚拟老师将通过教师大屏与你对话";
  const stageDescription = session.status === "ended"
    ? "关键结论、误解澄清和迁移问题已经同步到右侧。"
    : session.status === "paused"
      ? "请等待老师恢复讨论。"
      : session.status === "awaiting-replacement"
        ? "老师完成点名后，新同学的设备会负责收音。"
        : session.status === "recording"
          ? "请自然作答，完成后在右侧点击“结束回答”。"
          : session.status === "awaiting-teacher-confirmation"
            ? "教师可以确认结束，也可以让虚拟老师继续追问。"
            : "AI 语音由教师端统一播放，全班只会听到一个声音源。";
  const latestAssistantTurn = [...session.turns].reverse().find((turn) => turn.role === "assistant");
  const currentPrompt = latestAssistantTurn?.content ?? session.openingPrompt;

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-stone-950/55 p-2 backdrop-blur-sm sm:p-4 md:p-6" role="dialog" aria-modal="true" aria-label="全班公开讨论">
      <div className="mx-auto flex min-h-[calc(100dvh-1rem)] max-w-5xl flex-col overflow-hidden rounded-[14px] bg-white shadow-2xl sm:min-h-[calc(100dvh-2rem)] md:h-[min(46rem,calc(100dvh-3rem))] md:min-h-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4 md:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-ai)] text-white"><MessageSquareText size={19} /></span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold tracking-[.12em] text-[var(--pbl-ai)]">全班公开{session.mode === "debate" ? "辩论" : "追问"}</p>
              <h2 className="mt-0.5 truncate text-lg font-bold text-stone-950 md:text-xl">{session.topic}</h2>
              <StudentRoundProgress roundCount={session.roundCount} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("rounded-full px-3 py-1.5 text-xs font-bold", session.status === "ended" ? "bg-emerald-50 text-emerald-800" : session.status === "paused" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-900")}>{studentStatusLabels[session.status] ?? "公开讨论中"}</span>
            {session.status === "ended" ? (
              <button className="grid size-11 place-items-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900" onClick={() => setDismissedSessionId(session.id)} type="button" aria-label="返回学习"><X size={19} /></button>
            ) : null}
          </div>
        </header>

        <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="flex min-h-[25rem] flex-col overflow-y-auto border-b border-stone-200 lg:border-b-0 lg:border-r">
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center md:px-10">
              <StudentStageIcon status={session.status} />
              <h3 className="mt-4 text-xl font-bold text-stone-950">{teacherState}</h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">{stageDescription}</p>
              <div className="mt-6 w-full max-w-2xl rounded-[10px] border border-stone-200 bg-stone-50 px-5 py-4 text-left">
                <p className="text-[11px] font-bold tracking-[.1em] text-stone-400">当前问题</p>
                <p className="mt-2 text-base font-semibold leading-7 text-stone-900">{currentPrompt}</p>
              </div>
            </div>
            <details className="group border-t border-stone-200 bg-white">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-5 text-sm font-bold text-stone-700 md:px-6">
                <span>文字记录 · {session.turns.length} 条</span>
                <ChevronDown className="transition group-open:rotate-180" size={16} />
              </summary>
              <div className="max-h-64 space-y-3 overflow-y-auto border-t border-stone-100 bg-stone-50/60 p-4" aria-live="polite">
                {!session.turns.length ? <p className="text-sm leading-6 text-stone-600">{session.openingPrompt}</p> : null}
                {session.turns.map((turn) => <StudentDiscussionTurn key={turn.id} turn={turn} />)}
              </div>
            </details>
          </section>

          <aside className="overflow-y-auto bg-stone-50 p-5">
            <div className="flex items-center gap-3 border-b border-stone-200 pb-4"><span className="grid size-9 place-items-center rounded-full bg-[var(--pbl-student)] text-sm font-bold text-white">{session.currentStudent?.name?.slice(0, 1) ?? "?"}</span><div><p className="text-xs text-stone-500">当前发言</p><p className="text-sm font-bold text-stone-900">{session.currentStudent?.name ?? "等待点名"}</p></div></div>
            {!session.isCurrentStudent && session.status !== "ended" ? <p className="mt-3 rounded-xl bg-white p-3 text-sm leading-6 text-stone-600 ring-1 ring-stone-200">请关注教师大屏和现场发言。当前由被点名同学的设备负责收音。</p> : null}
            {session.isCurrentStudent && session.status === "inviting" ? (
              <div className="mt-4">
                <p className="text-base font-bold text-stone-950">老师邀请你回答</p>
                <p className="mt-1 text-xs leading-5 text-stone-600">接受后会申请麦克风权限，并在轮到你时自动开始录音。</p>
                <div className="mt-4 space-y-2">
                  <button className="min-h-12 w-full rounded-lg bg-[var(--pbl-student)] px-3 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("accept")} type="button">接受并使用麦克风</button>
                  <button className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-2 text-xs font-bold text-stone-700 disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("accept", true)} type="button">使用文字回答</button>
                  <button className="min-h-11 w-full px-2 text-xs font-bold text-stone-500 disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("decline")} type="button">暂不参与</button>
                </div>
              </div>
            ) : null}
            {session.isCurrentStudent && session.status === "recording" ? (
              <div className="mt-4 text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-full bg-rose-100 text-rose-700"><Mic className="animate-pulse" size={25} /></span>
                <p className="mt-3 text-lg font-bold tabular-nums text-stone-950">{recordingSeconds}s</p>
                <p className="mt-1 text-xs text-stone-500">麦克风正在收音</p>
                <button className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-rose-700 px-3 text-sm font-bold text-white" onClick={stopRecording} type="button"><MicOff size={17} />结束回答</button>
              </div>
            ) : null}
            {session.isCurrentStudent && session.status === "transcribing" ? <p className="mt-3 flex items-center gap-2 rounded-xl bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200"><Loader2 className="animate-spin" size={16} />正在理解并提交你的回答…</p> : null}
            {session.isCurrentStudent && session.status === "ai-generating" ? <p className="mt-3 flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-900"><Loader2 className="animate-spin" size={16} />虚拟老师正在快速思考…</p> : null}
            {session.isCurrentStudent && ["ai-ready", "ai-completion-ready"].includes(session.status) ? <p className="mt-3 rounded-xl bg-blue-50 p-3 text-sm leading-6 text-blue-900">请听教师大屏上的 AI 语音，播放结束后系统会自动进入下一步。</p> : null}
            {session.isCurrentStudent && session.status === "awaiting-teacher-confirmation" ? <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-900">AI 认为你已达到本次提问目标，正在等待老师确认是否结束。</p> : null}
            {session.isCurrentStudent && session.status === "awaiting-student" && !textFallbackMode && !busy ? (
              <button className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white text-sm font-bold text-[var(--pbl-student)]" onClick={() => void startRecording()} type="button"><Mic size={17} />点击开始回答</button>
            ) : null}
            {canRetry && !textFallbackMode ? (
              <div className="mt-3 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm font-bold text-amber-950">刚才没有听清，请重新回答</p>
                <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--pbl-student)] text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void startRecording()} type="button"><Mic size={17} />重新回答</button>
                <button className="h-9 w-full rounded-lg border border-amber-300 bg-white text-xs font-bold text-amber-900" onClick={() => setTextFallbackMode(true)} type="button">改用文字</button>
              </div>
            ) : null}
            {canAnswer && textFallbackMode ? (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-bold text-stone-600" htmlFor={`public-answer-${session.id}`}>文字回答</label>
                <textarea className="min-h-28 w-full resize-y rounded-lg border border-stone-300 bg-white p-3 text-sm leading-6 outline-none focus:border-cyan-700" id={`public-answer-${session.id}`} maxLength={3_000} onChange={(event) => setAnswer(event.target.value)} placeholder="输入你的回答…" value={answer} />
                <button className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--pbl-student)] text-sm font-bold text-white disabled:opacity-50" disabled={busy || !answer.trim()} onClick={() => void submitTextAnswer()} type="button">{busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}提交回答</button>
                <button className="h-9 w-full rounded-lg border border-stone-300 bg-white text-xs font-bold text-stone-700" onClick={() => setTextFallbackMode(false)} type="button">返回语音回答</button>
              </div>
            ) : null}
            {session.status === "ai-failed" ? <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">AI 回应暂时生成失败，老师可以重试或继续引导。</p> : null}
            {session.status === "paused" ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-900">教师已暂停讨论，请等待恢复。</p> : null}
            {session.status === "awaiting-replacement" ? <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-700">等待教师选择下一位同学。</p> : null}
            {session.status === "summarizing" ? <p className="mt-3 flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-900"><Loader2 className="animate-spin" size={16} />正在整理全班总结…</p> : null}
            {session.summary ? (
              <div className="mt-3 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">
                <p><strong>关键结论：</strong>{session.summary.keyConclusion}</p>
                <p><strong>误解澄清：</strong>{session.summary.misconceptionRepair}</p>
                <p><strong>迁移问题：</strong>{session.summary.transferQuestion}</p>
              </div>
            ) : null}
            {error ? <p className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-xs leading-5 text-rose-700" role="alert"><CircleAlert className="mt-0.5 shrink-0" size={14} />{error}</p> : null}
          </aside>
        </main>
      </div>
    </div>,
    document.body,
  );
}

function StudentRoundProgress({ roundCount }: { roundCount: number }) {
  return <div className="mt-1.5 flex items-center gap-2"><span className="text-xs text-stone-500">已完成 {roundCount} / 3 轮</span><div className="flex gap-1" aria-hidden="true">{[1, 2, 3].map((round) => <span className={cn("h-1.5 w-6 rounded-full", round <= roundCount ? "bg-[var(--pbl-student)]" : "bg-stone-200")} key={round} />)}</div></div>;
}

function StudentStageIcon({ status }: { status: PublicDiscussionStatus }) {
  const loading = ["transcribing", "ai-generating", "summarizing"].includes(status);
  const ended = status === "ended";
  const recording = status === "recording";
  return <span className={cn("grid size-16 place-items-center rounded-full", ended ? "bg-emerald-50 text-emerald-700" : recording ? "bg-rose-50 text-rose-700" : "bg-blue-50 text-[var(--pbl-ai)]")}>{loading ? <Loader2 className="animate-spin" size={28} /> : ended ? <CheckCircle2 size={29} /> : recording ? <Mic size={28} /> : <AudioLines size={29} />}</span>;
}

function StudentDiscussionTurn({ turn }: { turn: NonNullable<PublicDiscussionSnapshot["session"]>["turns"][number] }) {
  const isAssistant = turn.role === "assistant";
  const isTeacher = turn.role === "teacher";
  return <article className={cn("max-w-[90%] rounded-[10px] border px-4 py-3 text-sm leading-6", isAssistant ? "border-blue-100 bg-white text-stone-900" : isTeacher ? "ml-auto border-amber-100 bg-amber-50 text-amber-950" : "ml-auto border-emerald-100 bg-emerald-50 text-emerald-950")}><p className="mb-1 text-[10px] font-bold text-stone-500">{isAssistant ? "AI 主持" : isTeacher ? "教师引导" : turn.studentName ?? "学生"}</p>{turn.content}</article>;
}

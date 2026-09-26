"use client";

import { browserRandomUUID } from "@/lib/browser/random-uuid";
import { audioRecordingFileName, createAudioRecorder } from "@/lib/browser/audio-recording";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Loader2, MessageCircleQuestion, Mic, MicOff, Send } from "lucide-react";
import { dispatchPlaybackModalBlock } from "@openmaic/lib/playback/activity-events";
import type { PublicDiscussionSnapshot, PublicDiscussionStatus } from "@/lib/public-discussion/types";
import { subscribePublicDiscussionUpdates } from "@/lib/public-discussion/realtime-client";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const statusLabels: Partial<Record<PublicDiscussionStatus, string>> = {
  inviting: "等待你的确认",
  "awaiting-student": "轮到你回答",
  recording: "正在收音",
  transcribing: "正在识别",
  "awaiting-retry": "请重新回答",
  "awaiting-confirmation": "请重新回答",
  "ai-generating": "AI 正在思考",
  "ai-ready": "请听教师大屏",
  "ai-completion-ready": "请听教师大屏",
  "awaiting-teacher-confirmation": "等待老师确认",
  "ai-failed": "等待老师重试",
  paused: "讨论已暂停",
};

function uuid(): string {
  return browserRandomUUID();
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
  const discussionActive = Boolean(snapshot?.enabled && session && session.status !== "ended");
  const visible = Boolean(discussionActive && session?.isCurrentStudent);

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
    if (!discussionActive) return;
    dispatchPlaybackModalBlock({ blocked: true, source: "public-discussion" });
    document.querySelectorAll("audio").forEach((audio) => audio.pause());
    window.speechSynthesis?.cancel();
    return () => dispatchPlaybackModalBlock({ blocked: false, source: "public-discussion" });
  }, [discussionActive]);

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
    if (session?.isCurrentStudent && session.status === "recording") return;
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
          throw new Error("当前浏览器或连接不支持麦克风，请使用 HTTPS 入口或改用文字回答。");
        }
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        permissionStream.getTracks().forEach((track) => track.stop());
        setTextFallbackMode(false);
      } else if (response === "accept") {
        setTextFallbackMode(true);
      }
      setSnapshot(await post({ action: response, requestId: uuid(), expectedVersion: session.version }));
    } catch (cause) {
      if (response === "accept") setTextFallbackMode(true);
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
      form.append("audio", blob, audioRecordingFileName(blob.type, "classroom-answer"));
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
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器或连接不支持麦克风，请使用 HTTPS 入口。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      streamRef.current = stream;
      const recorder = createAudioRecorder(stream);
      const next = await post({ action: "start-recording", requestId: uuid(), expectedVersion: current.version });
      setSnapshot(next);
      recordingVersionRef.current = next.session?.version;
      discardRecordingRef.current = false;
      chunksRef.current = [];
      recorderRef.current = recorder;
      setRecordingSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const discarded = discardRecordingRef.current;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || chunksRef.current[0]?.type });
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
    if (!session?.isCurrentStudent || session.status !== "awaiting-student" || textFallbackMode) return;
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
      setSnapshot(await post({
        action: "submit-answer",
        requestId: uuid(),
        expectedVersion: session.version,
        content: answer.trim(),
        source: "text",
      }));
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
  const canRetry = ["awaiting-retry", "awaiting-confirmation"].includes(session.status);
  const canAnswer = ["awaiting-student", "awaiting-retry", "awaiting-confirmation"].includes(session.status);
  const latestAssistantTurn = [...session.turns].reverse().find((turn) => turn.role === "assistant");
  const currentPrompt = latestAssistantTurn?.content ?? session.openingPrompt;
  const waitingMessage = session.status === "transcribing"
    ? "正在识别并提交你的回答…"
    : session.status === "ai-generating"
      ? "AI 正在根据你的回答组织追问…"
      : ["ai-ready", "ai-completion-ready"].includes(session.status)
        ? "请听教师大屏上的 AI 回应。"
        : session.status === "awaiting-teacher-confirmation"
          ? "AI 建议结束，正在等待老师确认。"
          : session.status === "paused"
            ? "老师已暂停讨论，请稍候。"
            : session.status === "ai-failed"
              ? "AI 回应生成失败，老师正在处理。"
              : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-stone-950/30 p-3 backdrop-blur-[2px] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label="回答课堂提问">
      <section className="w-full max-w-md overflow-hidden rounded-2xl border border-white/70 bg-white shadow-[0_24px_70px_rgba(28,25,23,.24)]">
        <header className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--pbl-student)] text-white"><MessageCircleQuestion size={20} /></span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold tracking-[.12em] text-[var(--pbl-student)]">老师点到你了</p>
              <h2 className="truncate text-base font-bold text-stone-950">{session.topic}</h2>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-bold text-cyan-900">{statusLabels[session.status] ?? "公开讨论中"}</span>
        </header>

        <div className="px-5 py-5">
          <p className="text-[11px] font-bold tracking-[.12em] text-stone-400">请回答</p>
          <p className="mt-2 text-base font-semibold leading-7 text-stone-950">{currentPrompt}</p>

          {session.status === "inviting" ? (
            <div className="mt-5 space-y-2">
              <button className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--pbl-student)] px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("accept")} type="button">
                {busy ? <Loader2 className="animate-spin" size={17} /> : <Mic size={17} />}接受并打开麦克风
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button className="min-h-10 rounded-xl border border-stone-200 bg-white text-xs font-bold text-stone-700 disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("accept", true)} type="button">使用文字回答</button>
                <button className="min-h-10 rounded-xl text-xs font-bold text-stone-500 disabled:opacity-50" disabled={busy} onClick={() => void respondToInvitation("decline")} type="button">暂不参与</button>
              </div>
              <p className="pt-1 text-center text-[11px] leading-5 text-stone-500">麦克风仅用于本次回答的语音识别。</p>
            </div>
          ) : null}

          {session.status === "recording" ? (
            <div className="mt-5 rounded-2xl bg-rose-50 p-4 text-center ring-1 ring-rose-100">
              <span className="mx-auto grid size-12 place-items-center rounded-full bg-rose-100 text-rose-700"><Mic className="animate-pulse" size={22} /></span>
              <p className="mt-2 text-xl font-bold tabular-nums text-stone-950">{recordingSeconds}s</p>
              <p className="mt-1 text-xs text-stone-600">请自然作答，完成后结束收音</p>
              <button className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-rose-700 text-sm font-bold text-white" onClick={stopRecording} type="button"><MicOff size={17} />结束回答</button>
            </div>
          ) : null}

          {session.status === "awaiting-student" && !textFallbackMode && !busy ? (
            <button className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--pbl-student)] text-sm font-bold text-white" onClick={() => void startRecording()} type="button"><Mic size={17} />开始回答</button>
          ) : null}

          {canRetry && !textFallbackMode ? (
            <div className="mt-5 grid grid-cols-[1fr_auto] gap-2">
              <button className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--pbl-student)] px-3 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void startRecording()} type="button"><Mic size={17} />重新回答</button>
              <button className="min-h-11 rounded-xl border border-stone-200 bg-white px-4 text-xs font-bold text-stone-700" onClick={() => setTextFallbackMode(true)} type="button">改用文字</button>
            </div>
          ) : null}

          {canAnswer && textFallbackMode ? (
            <div className="mt-5 space-y-2">
              <label className="sr-only" htmlFor={`public-answer-${session.id}`}>文字回答</label>
              <textarea className="min-h-28 w-full resize-y rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm leading-6 outline-none focus:border-cyan-700 focus:bg-white" id={`public-answer-${session.id}`} maxLength={3_000} onChange={(event) => setAnswer(event.target.value)} placeholder="输入你的回答…" value={answer} />
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <button className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--pbl-student)] px-3 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !answer.trim()} onClick={() => void submitTextAnswer()} type="button">{busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}提交回答</button>
                <button className="min-h-11 rounded-xl border border-stone-200 bg-white px-4 text-xs font-bold text-stone-700" onClick={() => setTextFallbackMode(false)} type="button">使用麦克风</button>
              </div>
            </div>
          ) : null}

          {waitingMessage ? <p className="mt-5 flex items-center gap-2 rounded-xl bg-stone-50 p-3 text-sm leading-6 text-stone-700">{["transcribing", "ai-generating"].includes(session.status) ? <Loader2 className="shrink-0 animate-spin text-cyan-700" size={17} /> : null}{waitingMessage}</p> : null}
          {error ? <p className="mt-4 flex items-start gap-2 rounded-xl bg-rose-50 p-3 text-xs leading-5 text-rose-800" role="alert"><CircleAlert className="mt-0.5 shrink-0" size={15} />{error}</p> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

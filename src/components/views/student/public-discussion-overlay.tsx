"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Mic, MicOff, Send, UserRound, X } from "lucide-react";
import { dispatchPlaybackModalBlock } from "@openmaic/lib/playback/activity-events";
import { cn } from "@/lib/utils";
import type { PublicDiscussionSnapshot } from "@/lib/public-discussion/types";
import { subscribePublicDiscussionUpdates } from "@/lib/public-discussion/realtime-client";

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
  const [answerSource, setAnswerSource] = useState<"voice" | "text">("text");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [dismissedSessionId, setDismissedSessionId] = useState<string>();
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const recordingVersionRef = useRef<number | undefined>(undefined);
  const discardRecordingRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/public-discussion`, {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": "student" },
    });
    if (response.status === 404) return;
    const payload = await parseResponse(response);
    setSnapshot(payload);
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

  async function act(action: "accept" | "decline") {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await post({ action, requestId: uuid(), expectedVersion: session.version }));
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
      const payload = await response.json().catch(() => ({})) as { text?: string; snapshot?: PublicDiscussionSnapshot; message?: string };
      if (payload.snapshot) setSnapshot(payload.snapshot);
      if (!response.ok || !payload.text) throw new Error(payload.message || "语音识别失败");
      setAnswer(payload.text);
      setAnswerSource("voice");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语音识别失败，请重录或改用文字");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    if (!session || !session.isCurrentStudent || session.status !== "awaiting-student") return;
    setBusy(true);
    setError(undefined);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器或连接不支持麦克风录音，请改用 HTTPS 入口。");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const next = await post({ action: "start-recording", requestId: uuid(), expectedVersion: session.version });
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
      setError(cause instanceof Error ? cause.message : "无法使用麦克风，请检查权限");
    } finally {
      setBusy(false);
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state !== "recording") return;
    discardRecordingRef.current = false;
    recorderRef.current.stop();
  }

  async function cancelRecording() {
    if (!session || session.status !== "recording") return;
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopTracks();
    setBusy(true);
    try {
      setSnapshot(await post({ action: "cancel-recording", requestId: uuid(), expectedVersion: session.version }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消录音失败");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer() {
    if (!session || !answer.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await post({
        action: "submit-answer",
        requestId: uuid(),
        expectedVersion: session.version,
        content: answer.trim(),
        source: answerSource,
      });
      setSnapshot(next);
      setAnswer("");
      setAnswerSource("text");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回答提交失败");
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (!visible || !session) return null;
  const canCompose = session.isCurrentStudent
    && ["awaiting-student", "awaiting-confirmation"].includes(session.status);
  const lastAssistant = [...session.turns].reverse().find((turn) => turn.role === "assistant");

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-stone-950/60 p-3 backdrop-blur-sm md:p-6" role="dialog" aria-modal="true" aria-label="全班公开讨论">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex flex-wrap items-start justify-between gap-3 bg-gradient-to-r from-cyan-950 to-blue-950 px-5 py-4 text-white">
          <div>
            <p className="text-xs font-bold tracking-[.14em] text-cyan-200">全班公开{session.mode === "debate" ? "辩论" : "追问"}</p>
            <h2 className="mt-1 text-xl font-bold">{session.topic}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-cyan-50">{session.openingPrompt}</p>
          </div>
          {session.status === "ended" ? (
            <button className="grid size-10 place-items-center rounded-full bg-white/10 hover:bg-white/20" onClick={() => setDismissedSessionId(session.id)} type="button" aria-label="返回学习"><X size={19} /></button>
          ) : null}
        </header>

        <main className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-h-[18rem] border-b border-stone-200 p-4 md:border-b-0 md:border-r">
            <div className="space-y-3" aria-live="polite">
              {!session.turns.length ? <div className="rounded-xl bg-blue-50 p-4 text-sm leading-6 text-blue-950"><Bot className="mb-2" size={20} />{session.openingPrompt}</div> : null}
              {session.turns.map((turn) => (
                <article className={cn("max-w-[90%] rounded-xl px-4 py-3 text-sm leading-6", turn.role === "assistant" ? "bg-blue-50 text-blue-950" : turn.role === "teacher" ? "ml-auto bg-amber-50 text-amber-950" : "ml-auto bg-cyan-950 text-white")} key={turn.id}>
                  <p className="mb-1 text-[10px] font-bold opacity-65">{turn.role === "assistant" ? "AI 主持" : turn.role === "teacher" ? "教师引导" : turn.studentName ?? "学生"}</p>
                  {turn.content}
                </article>
              ))}
              {session.status === "ai-generating" ? <p className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="animate-spin" size={16} />AI 正在思考并组织下一问…</p> : null}
            </div>
          </section>

          <aside className="bg-stone-50 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-stone-900"><UserRound size={17} />当前发言：{session.currentStudent?.name ?? "等待点名"}</div>
            {!session.isCurrentStudent && session.status !== "ended" ? <p className="mt-3 rounded-xl bg-white p-3 text-sm leading-6 text-stone-600 ring-1 ring-stone-200">请关注大屏和现场发言。当前由被点名同学的设备负责收音。</p> : null}
            {session.isCurrentStudent && session.status === "inviting" ? (
              <div className="mt-3 rounded-xl border border-cyan-200 bg-cyan-50 p-3">
                <p className="text-sm font-bold text-cyan-950">老师邀请你参加公开讨论</p>
                <p className="mt-1 text-xs leading-5 text-cyan-800">接受后再由你主动开启麦克风；暂不参与时老师可以换人。</p>
                <div className="mt-3 flex gap-2">
                  <button className="h-10 flex-1 rounded-lg bg-cyan-950 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void act("accept")} type="button">接受邀请</button>
                  <button className="h-10 rounded-lg border border-cyan-300 bg-white px-3 text-sm font-bold text-cyan-900 disabled:opacity-50" disabled={busy} onClick={() => void act("decline")} type="button">暂不参与</button>
                </div>
              </div>
            ) : null}
            {session.isCurrentStudent && session.status === "recording" ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-center">
                <Mic className="mx-auto animate-pulse text-rose-700" size={24} />
                <p className="mt-2 text-sm font-bold text-rose-900">正在录音 · {recordingSeconds}s</p>
                <div className="mt-3 flex gap-2">
                  <button className="h-10 flex-1 rounded-lg bg-rose-700 text-sm font-bold text-white" onClick={stopRecording} type="button"><MicOff className="mr-1 inline" size={15} />停止并识别</button>
                  <button className="h-10 rounded-lg border border-rose-300 bg-white px-3 text-sm font-bold text-rose-800" onClick={() => void cancelRecording()} type="button">取消</button>
                </div>
              </div>
            ) : null}
            {session.isCurrentStudent && session.status === "transcribing" ? <p className="mt-3 flex items-center gap-2 rounded-xl bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200"><Loader2 className="animate-spin" size={16} />正在识别你的发言…</p> : null}
            {canCompose ? (
              <div className="mt-3 space-y-2">
                <button className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-cyan-300 bg-white text-sm font-bold text-cyan-950 disabled:opacity-50" disabled={busy} onClick={() => void startRecording()} type="button"><Mic size={17} />点击开始录音</button>
                <label className="block text-xs font-bold text-stone-600" htmlFor={`public-answer-${session.id}`}>识别文字可修改，也可直接键入</label>
                <textarea className="min-h-28 w-full resize-y rounded-lg border border-stone-300 bg-white p-3 text-sm leading-6 outline-none focus:border-cyan-700" id={`public-answer-${session.id}`} maxLength={3_000} onChange={(event) => { setAnswer(event.target.value); if (event.isTrusted) setAnswerSource("text"); }} placeholder="确认你的回答…" value={answer} />
                <button className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-cyan-950 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !answer.trim()} onClick={() => void submitAnswer()} type="button">{busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}提交给 AI</button>
              </div>
            ) : null}
            {session.status === "ai-ready" ? <p className="mt-3 rounded-xl bg-blue-50 p-3 text-sm leading-6 text-blue-900">AI 回答已生成，等待教师端大屏播放。{lastAssistant ? "字幕已经同步到全班。" : ""}</p> : null}
            {session.status === "ai-failed" ? <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">AI 回答暂时生成失败，老师可以重试或继续引导。</p> : null}
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
            {error ? <p className="mt-3 rounded-lg bg-rose-50 p-2 text-xs text-rose-700" role="alert">{error}</p> : null}
          </aside>
        </main>
      </div>
    </div>,
    document.body,
  );
}

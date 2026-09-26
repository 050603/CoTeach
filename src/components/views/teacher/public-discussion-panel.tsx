"use client";

import { browserRandomUUID } from "@/lib/browser/random-uuid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  MessageCircleQuestion,
  MessageSquareText,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Square,
  UserRoundCheck,
  UsersRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Card, Pill } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Course } from "@/lib/session/types";
import type {
  PublicDiscussionCandidate,
  PublicDiscussionMode,
  PublicDiscussionRecommendation,
  PublicDiscussionSettings,
  PublicDiscussionSnapshot,
  PublicDiscussionTurn,
} from "@/lib/public-discussion/types";
import { subscribePublicDiscussionUpdates } from "@/lib/public-discussion/realtime-client";

function uuid(): string {
  return browserRandomUUID();
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || "课堂讨论操作失败");
  return body;
}

const statusLabels: Record<string, string> = {
  inviting: "等待学生接受",
  "awaiting-student": "等待学生发言",
  recording: "学生正在录音",
  transcribing: "正在识别语音",
  "awaiting-retry": "等待学生重新回答",
  "awaiting-confirmation": "等待学生重新回答",
  "ai-generating": "AI 正在回应",
  "ai-ready": "AI 回答待播放",
  "ai-completion-ready": "AI 达标建议待播放",
  "awaiting-teacher-confirmation": "等待教师确认结束",
  "ai-failed": "AI 回答失败",
  "awaiting-replacement": "等待教师换人",
  paused: "讨论已暂停",
  summarizing: "正在生成总结",
  ended: "讨论已结束",
};

export function PublicDiscussionTeacherPanel({
  course,
  recommendedKnowledgePointIds,
  immersive = false,
}: {
  course: Course;
  recommendedKnowledgePointIds: string[];
  immersive?: boolean;
}) {
  const defaultPointId = recommendedKnowledgePointIds[0] ?? course.content.knowledgePoints[0]?.id ?? "";
  const [snapshot, setSnapshot] = useState<PublicDiscussionSnapshot>();
  const [selectedPointId, setSelectedPointId] = useState(defaultPointId);
  const [mode, setMode] = useState<PublicDiscussionMode>("inquiry");
  const [recommendation, setRecommendation] = useState<PublicDiscussionRecommendation>();
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [openingPrompt, setOpeningPrompt] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [audioState, setAudioState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<PublicDiscussionSettings>();
  const [asrProviders, setAsrProviders] = useState<Record<string, { models?: string[]; defaultModel?: string }>>({});
  const soundClientIdRef = useRef(`teacher-sound-${uuid()}`);
  const playedTurnIdsRef = useRef(new Set<string>());
  const playingTurnIdRef = useRef<string | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);

  const endpoint = `/api/courses/${encodeURIComponent(course.id)}/public-discussion`;
  const load = useCallback(async () => {
    const response = await fetch(`${endpoint}?soundClientId=${encodeURIComponent(soundClientIdRef.current)}`, {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": "teacher" },
    });
    if (response.status === 404) return;
    setSnapshot(await responseJson<PublicDiscussionSnapshot>(response));
  }, [endpoint]);

  const loadSettings = useCallback(async () => {
    const response = await fetch(`${endpoint}/settings`, {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": "teacher" },
    });
    if (!response.ok) return;
    const payload = await response.json() as {
      settings?: PublicDiscussionSettings;
      asrProviders?: Record<string, { models?: string[]; defaultModel?: string }>;
    };
    setSettings(payload.settings);
    setAsrProviders(payload.asrProviders ?? {});
  }, [endpoint]);

  useEffect(() => {
    const initial = window.setTimeout(() => void Promise.all([load(), loadSettings()]), 0);
    const unsubscribe = subscribePublicDiscussionUpdates(course.id, () => void load().catch(() => undefined));
    const timer = window.setInterval(() => void load().catch(() => undefined), 2_500);
    return () => {
      unsubscribe();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
    };
  }, [course.id, load, loadSettings]);

  async function post(body: Record<string, unknown>): Promise<PublicDiscussionSnapshot> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
      body: JSON.stringify(body),
    });
    return responseJson(response);
  }

  async function withBusy(operation: () => Promise<PublicDiscussionSnapshot>) {
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function recommend() {
    if (!selectedPointId) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify({ action: "recommend", knowledgePointId: selectedPointId, mode }),
      });
      const next = await responseJson<PublicDiscussionRecommendation>(response);
      setRecommendation(next);
      setOpeningPrompt(next.openingPrompt);
      setSelectedStudentId(next.candidates[0]?.studentId ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "学生推荐生成失败");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const point = course.content.knowledgePoints.find((item) => item.id === selectedPointId);
    if (!point || !selectedStudentId || !openingPrompt.trim()) return;
    setBusy(true);
    setError(undefined);
    let discussionStarted = false;
    try {
      const started = await post({
        action: "start",
        requestId: uuid(),
        knowledgePointId: point.id,
        topic: recommendation?.topic ?? point.name,
        mode,
        openingPrompt: openingPrompt.trim(),
        studentId: selectedStudentId,
        candidates: recommendation?.candidates,
      });
      discussionStarted = true;
      setSnapshot(started);
      document.querySelectorAll("audio").forEach((audio) => audio.pause());
      window.speechSynthesis?.cancel();
      const sounded = await post({ action: "acquire-sound", clientId: soundClientIdRef.current });
      setSnapshot(sounded);
      setSoundEnabled(Boolean(sounded.teacher?.soundOwner));
      if (!sounded.teacher?.soundOwner) {
        setError("讨论已启动，但另一教师页面正在控制课堂声音，请先取得声音控制权。");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "课堂声音启用失败";
      setError(discussionStarted ? `讨论已启动，但课堂声音未能启用：${message}` : message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  const session = snapshot?.session;
  const active = Boolean(session && session.status !== "ended");
  async function action(actionName: string, extra: Record<string, unknown> = {}) {
    if (!session) return;
    await withBusy(() => post({
      action: actionName,
      requestId: uuid(),
      expectedVersion: session.version,
      ...extra,
    }));
  }

  async function acquireSound() {
    setError(undefined);
    try {
      document.querySelectorAll("audio").forEach((audio) => audio.pause());
      window.speechSynthesis?.cancel();
      const next = await post({ action: "acquire-sound", clientId: soundClientIdRef.current });
      setSnapshot(next);
      setSoundEnabled(Boolean(next.teacher?.soundOwner));
      if (!next.teacher?.soundOwner) setError("另一教师页面正在控制课堂声音，可在其租约释放后重试。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "课堂声音启用失败");
    }
  }

  useEffect(() => {
    if (!soundEnabled || !active) return;
    const heartbeat = window.setInterval(() => {
      void post({ action: "acquire-sound", clientId: soundClientIdRef.current })
        .then((next) => {
          setSnapshot(next);
          if (!next.teacher?.soundOwner) setSoundEnabled(false);
        })
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(heartbeat);
    // post is intentionally read from the current render; the endpoint is stable for a course.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, course.id, soundEnabled]);

  async function speak(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    if (settings?.ttsProviderId && settings.ttsProviderId !== "browser-native-tts" && settings.ttsVoice) {
      const response = await fetch("/api/openmaic/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify({
          text: clean.slice(0, 3_000),
          audioId: `public_discussion_${session?.id}_${Date.now()}`,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: settings.ttsModelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsScenario: "realtime-interaction",
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        base64?: string;
        format?: string;
        data?: { base64?: string; format?: string };
        error?: string;
      };
      const base64 = payload.base64 ?? payload.data?.base64;
      if (!response.ok || !base64) {
        throw new Error(payload.error ? `AI 语音生成失败：${payload.error}` : "AI 语音生成失败");
      }
      const audio = new Audio(`data:audio/${payload.format ?? payload.data?.format ?? "mp3"};base64,${base64}`);
      audioRef.current = audio;
      setAudioState("playing");
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("AI 语音播放失败"));
        void audio.play().catch(reject);
      });
      return;
    }
    if (!("speechSynthesis" in window)) throw new Error("当前浏览器不支持语音播放");
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "zh-CN";
      utterance.rate = settings?.ttsSpeed ?? 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("AI 语音播放失败"));
      setAudioState("playing");
      window.speechSynthesis.speak(utterance);
    });
  }

  const lastAssistant = useMemo(
    () => session ? [...session.turns].reverse().find((turn) => turn.role === "assistant") : undefined,
    [session],
  );

  useEffect(() => {
    if (
      !session
      || !["ai-ready", "ai-completion-ready"].includes(session.status)
      || !lastAssistant
      || !soundEnabled
      || !snapshot?.teacher?.soundOwner
      || playedTurnIdsRef.current.has(lastAssistant.id)
      || playingTurnIdRef.current === lastAssistant.id
    ) return;
    playingTurnIdRef.current = lastAssistant.id;
    setAudioState("loading");
    void speak(lastAssistant.content).then(async () => {
      playedTurnIdsRef.current.add(lastAssistant.id);
      setAudioState("idle");
      const next = await post({
        action: "complete-playback",
        requestId: uuid(),
        expectedVersion: session.version,
        clientId: soundClientIdRef.current,
      });
      setSnapshot(next);
    }).catch((cause) => {
      setAudioState("failed");
      setError(cause instanceof Error ? cause.message : "AI 语音播放失败；字幕仍可使用。");
    }).finally(() => {
      playingTurnIdRef.current = undefined;
    });
    // Playback is keyed to the latest assistant turn and semantic session version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAssistant?.id, session?.status, session?.version, snapshot?.teacher?.soundOwner, soundEnabled]);

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${endpoint}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify(settings),
      });
      const payload = await responseJson<{ settings: PublicDiscussionSettings }>(response);
      setSettings(payload.settings);
      setShowSettings(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语音识别设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (snapshot && !snapshot.enabled) return null;

  const Shell = immersive ? "section" : Card;

  return (
    <Shell
      className={cn(
        immersive
          ? "h-full min-h-0 overflow-auto"
          : "mx-4 mt-4 overflow-hidden border-stone-200 bg-[var(--pbl-surface)] p-0",
      )}
    >
      <header className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        immersive ? "px-1 pb-4 pt-1" : "border-b border-stone-200 bg-white px-5 py-4",
      )}>
        <div className="flex items-start gap-3">
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-[10px]", immersive ? "bg-cyan-100 text-cyan-800" : "bg-[var(--pbl-teacher)] text-white")}><MessageSquareText size={19} /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h4 className={cn("font-bold text-stone-950", immersive && "text-lg")}>{immersive ? "AI 公开讨论" : "全班公开讨论"}</h4><Pill tone={active ? "blue" : "gray"}>{active ? statusLabels[session!.status] : "尚未开始"}</Pill></div>
            <p className="mt-1 text-xs leading-5 text-stone-500">选择共性问题并点名学生，由学生设备收音，教师端统一播放 AI 回应。</p>
          </div>
        </div>
        <button
          aria-expanded={showSettings}
          className={cn(
            "flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-bold transition",
            immersive
              ? "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
              : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50",
          )}
          onClick={() => setShowSettings((value) => !value)}
          type="button"
        >
          <Settings2 size={15} />语音识别设置<ChevronDown className={cn("transition", showSettings && "rotate-180")} size={14} />
        </button>
      </header>

      {showSettings && settings ? (
        <div className={cn("grid gap-3 border-stone-200 px-5 py-4 md:grid-cols-[1fr_1fr_8rem_auto]", immersive ? "mb-4 border-y bg-white" : "border-b bg-stone-50")}>
          <label className="text-xs font-bold text-stone-600">服务端 ASR
            <select className="mt-1 h-9 w-full rounded-lg border border-stone-300 bg-white px-2 text-xs" onChange={(event) => {
              const providerId = event.target.value;
              setSettings((current) => current ? { ...current, asrProviderId: providerId, asrModelId: asrProviders[providerId]?.defaultModel ?? asrProviders[providerId]?.models?.[0] } : current);
            }} value={settings.asrProviderId ?? ""}>
              <option value="">请选择</option>
              {Object.keys(asrProviders).map((providerId) => <option key={providerId} value={providerId}>{providerId}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-stone-600">模型
            <input className="mt-1 h-9 w-full rounded-lg border border-stone-300 bg-white px-2 text-xs" onChange={(event) => setSettings((current) => current ? { ...current, asrModelId: event.target.value } : current)} value={settings.asrModelId ?? ""} />
          </label>
          <label className="text-xs font-bold text-stone-600">语言
            <input className="mt-1 h-9 w-full rounded-lg border border-stone-300 bg-white px-2 text-xs" onChange={(event) => setSettings((current) => current ? { ...current, asrLanguage: event.target.value } : current)} value={settings.asrLanguage} />
          </label>
          <button className="min-h-11 self-end rounded-lg bg-[var(--pbl-teacher)] px-4 text-xs font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void saveSettings()} type="button">保存设置</button>
        </div>
      ) : null}

      {!active ? (
        <div className={cn(immersive && "border-y border-stone-200 bg-white")}>
          <ol aria-label="启动公开讨论步骤" className="grid border-b border-stone-200 bg-stone-50 sm:grid-cols-3">
            <SetupStep complete={Boolean(selectedPointId)} label="确定主题" number={1} />
            <SetupStep complete={Boolean(selectedStudentId)} label="选择学生" number={2} />
            <SetupStep complete={Boolean(openingPrompt.trim())} label="确认开场" number={3} />
          </ol>
          <div className={cn("grid lg:grid-cols-3", immersive && "min-h-[32rem]")}>
            <section className={cn("space-y-4 border-b border-stone-200 p-5 lg:border-b-0 lg:border-r", immersive && "p-6")}>
              <SectionHeading icon={<MessageCircleQuestion size={17} />} number="01" title="讨论什么" />
              <label className="block text-xs font-bold text-stone-600">知识点
                <select className="mt-1.5 h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" onChange={(event) => { setSelectedPointId(event.target.value); setRecommendation(undefined); setSelectedStudentId(""); }} value={selectedPointId}>
                  {course.content.knowledgePoints.map((point) => <option key={point.id} value={point.id}>{recommendedKnowledgePointIds.includes(point.id) ? "共性问题 · " : ""}{point.name}</option>)}
                </select>
              </label>
              <fieldset>
                <legend className="text-xs font-bold text-stone-600">互动方式</legend>
                <div className="mt-1.5 grid grid-cols-2 rounded-lg bg-stone-100 p-1" role="group" aria-label="互动方式">
                  {([['inquiry', '公开追问'], ['debate', '观点辩论']] as const).map(([value, label]) => (
                    <button aria-pressed={mode === value} className={cn("min-h-10 rounded-md px-2 text-sm font-semibold transition", mode === value ? "bg-white text-stone-950 ring-1 ring-stone-200" : "text-stone-500 hover:text-stone-800")} key={value} onClick={() => { setMode(value); setRecommendation(undefined); }} type="button">{label}</button>
                  ))}
                </div>
              </fieldset>
              <p className="text-xs leading-5 text-stone-500">{mode === "debate" ? "围绕可讨论命题检查观点、论据与适用条件。" : "通过解释、举例和迁移逐步澄清共性问题。"}</p>
            </section>

            <section className={cn("space-y-4 border-b border-stone-200 p-5 lg:border-b-0 lg:border-r", immersive && "p-6")}>
              <SectionHeading icon={<UsersRound size={17} />} number="02" title="请谁回答" />
              <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--pbl-teacher)] bg-white px-3 text-sm font-bold text-[var(--pbl-teacher)] disabled:opacity-50" disabled={busy || !selectedPointId} onClick={() => void recommend()} type="button">{busy ? <Loader2 className="animate-spin" size={16} /> : <UsersRound size={16} />}推荐合适的在线学生</button>
              {recommendation ? (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {recommendation.candidates.length ? recommendation.candidates.map((candidate) => (
                    <CandidateOption candidate={candidate} checked={selectedStudentId === candidate.studentId} key={candidate.studentId} onSelect={setSelectedStudentId} />
                  )) : <p className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900">暂未找到在线候选人，请从班级名单手动点名。</p>}
                </div>
              ) : <p className="text-xs leading-5 text-stone-500">推荐会综合代表性误解、回答证据和既往参与次数，理由仅教师可见。</p>}
              <label className="block text-xs font-bold text-stone-600">班级名单
                <select className="mt-1.5 h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" onChange={(event) => setSelectedStudentId(event.target.value)} value={selectedStudentId}>
                  <option value="">请选择学生</option>
                  {course.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
                </select>
              </label>
            </section>

            <section className={cn("flex flex-col gap-4 p-5", immersive && "p-6")}>
              <SectionHeading icon={<AudioLines size={17} />} number="03" title="如何开场" />
              <label className="block text-xs font-bold text-stone-600">公开问题
                <textarea className="mt-1.5 min-h-32 w-full resize-y rounded-lg border border-stone-300 bg-white p-3 text-sm leading-6 outline-none focus:border-[var(--pbl-teacher)]" maxLength={2_000} onChange={(event) => setOpeningPrompt(event.target.value)} placeholder="输入开场问题，或先使用学生推荐自动生成" value={openingPrompt} />
              </label>
              <div className="mt-auto rounded-lg bg-stone-50 px-3 py-2.5 text-xs leading-5 text-stone-600">
                <span className="font-bold text-stone-800">将点名：</span>{course.students.find((student) => student.id === selectedStudentId)?.name ?? "尚未选择"}
              </div>
              <button className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || !selectedStudentId || !openingPrompt.trim() || course.status !== "teaching"} onClick={() => void start()} type="button"><UserRoundCheck size={18} />点名并开始讨论</button>
            </section>
          </div>
          {session?.summary ? <div className="border-t border-stone-200 p-5"><SummaryBlock snapshot={snapshot!} /></div> : null}
        </div>
      ) : session ? (
        <div className={cn("grid lg:grid-cols-[minmax(0,1fr)_21rem]", immersive && "min-h-[min(42rem,calc(100dvh-12rem))] border-y border-stone-200 bg-white lg:grid-cols-[minmax(0,1fr)_24rem]")}>
          <section className={cn("border-b border-stone-200 p-5 lg:border-b-0 lg:border-r", immersive && "flex min-h-0 flex-col p-7")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-xs font-bold text-[var(--pbl-teacher)]">{session.mode === "debate" ? "观点辩论" : "公开追问"}</p><h5 className={cn("mt-1 font-bold text-stone-950", immersive ? "text-2xl" : "text-lg")}>{session.topic}</h5><p className={cn("mt-2 max-w-3xl text-stone-600", immersive ? "text-base leading-7" : "text-sm leading-6")}>{session.openingPrompt}</p></div>
              <Pill tone={session.status === "ai-failed" || session.status === "awaiting-replacement" ? "red" : session.status === "paused" ? "orange" : "blue"}>{statusLabels[session.status]}</Pill>
            </div>
            <RoundProgress roundCount={session.roundCount} />
            <div className={cn("mt-4 min-h-56 space-y-4 overflow-y-auto border-y border-stone-200 py-4 pr-2", immersive ? "max-h-none flex-1" : "max-h-[28rem]")} aria-label="公开讨论记录" aria-live="polite">
              {session.turns.length ? session.turns.map((turn) => <DiscussionTurn key={turn.id} turn={turn} />) : <div className="grid min-h-40 place-items-center text-center"><div><MessageSquareText className="mx-auto text-stone-300" size={28} /><p className="mt-2 text-sm font-semibold text-stone-700">等待 {session.currentStudent?.name ?? "学生"} 接受邀请</p><p className="mt-1 text-xs text-stone-500">接受后，学生端会负责采集回答。</p></div></div>}
              {session.status === "ai-generating" || session.status === "summarizing" ? <p className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="animate-spin" size={15} />{session.status === "summarizing" ? "正在形成课堂总结…" : "AI 正在组织回应…"}</p> : null}
            </div>
            {session.shouldSuggestSummary ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs font-semibold leading-5 text-emerald-800">3 轮回答已完成，可以结束讨论并生成全班总结。</p> : null}
          </section>
          <aside className={cn("space-y-4 bg-stone-50/70 p-5", immersive && "border-l border-stone-200 bg-stone-100/80 p-6")} aria-label="教师讨论控制">
            <div><p className="text-[11px] font-bold uppercase tracking-[.12em] text-stone-400">课堂控制</p><div className="mt-2 flex items-center gap-3"><span className="grid size-9 place-items-center rounded-full bg-[var(--pbl-student)] text-sm font-bold text-white">{session.currentStudent?.name?.slice(0, 1) ?? "?"}</span><div><p className="text-xs text-stone-500">当前发言学生</p><p className="font-bold text-stone-950">{session.currentStudent?.name ?? "未选择"}</p></div></div></div>
            {!soundEnabled ? <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] text-sm font-bold text-white" onClick={() => void acquireSound()} type="button"><Volume2 size={17} />启用此页面的课堂声音</button> : <p className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs font-semibold text-blue-900"><Volume2 size={16} />课堂声音已连接{audioState === "loading" ? " · 正在生成" : audioState === "playing" ? " · 正在播放" : ""}</p>}
            {soundEnabled && !snapshot.teacher?.soundOwner ? <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800"><VolumeX className="mr-1 inline" size={14} />声音控制权已由其他页面取得。</p> : null}
            {audioState === "failed" && ["ai-ready", "ai-completion-ready"].includes(session.status) ? <button className="h-10 w-full rounded-lg border border-blue-300 bg-white text-xs font-bold text-blue-900" onClick={() => void action("complete-playback", { clientId: soundClientIdRef.current })} type="button">语音失败，按字幕继续</button> : null}
            {session.status === "awaiting-teacher-confirmation" ? (
              <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-bold text-emerald-950">AI 判断本次提问目标已经达到</p>
                <p className="text-xs leading-5 text-emerald-800">请确认结束；如尚未达到第 3 轮，也可以让虚拟老师继续追问。</p>
                <button className="flex h-10 w-full items-center justify-center gap-1 rounded-lg bg-emerald-800 text-xs font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void action("finish")} type="button"><Square size={13} />确认结束并总结</button>
                {session.roundCount < 3 ? <button className="flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-stone-300 bg-white text-xs font-bold text-stone-800 disabled:opacity-50" disabled={busy} onClick={() => void action("continue-questioning")} type="button"><MessageCircleQuestion size={15} />继续追问</button> : null}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {session.status === "paused" ? <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-emerald-300 bg-white text-xs font-bold text-emerald-800" disabled={busy} onClick={() => void action("resume")} type="button"><Play size={14} />恢复</button> : <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-amber-300 bg-white text-xs font-bold text-amber-800" disabled={busy} onClick={() => void action("pause")} type="button"><Pause size={14} />暂停</button>}
                <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-rose-300 bg-white text-xs font-bold text-rose-800" disabled={busy} onClick={() => void action("finish")} type="button"><Square size={13} />结束并总结</button>
              </div>
            )}
            {session.status === "ai-failed" ? <button className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-rose-700 text-xs font-bold text-white" disabled={busy} onClick={() => void action("retry-ai")} type="button"><RefreshCw size={14} />重试 AI 回答</button> : null}
            <label className="block border-t border-stone-200 pt-4 text-xs font-bold text-stone-600">换一位学生
              <select className="mt-1.5 h-11 w-full rounded-lg border border-stone-300 bg-white px-2 text-sm" onChange={(event) => { if (event.target.value) void action("invite", { studentId: event.target.value }); }} value="">
                <option value="">选择并点名…</option>
                {course.students.filter((student) => student.id !== session.currentStudent?.id).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-stone-600">教师文字引导
              <textarea className="mt-1 min-h-20 w-full rounded-lg border border-stone-300 bg-white p-2 text-sm" maxLength={1_500} onChange={(event) => setGuidance(event.target.value)} placeholder="补充条件、澄清任务或引导下一步" value={guidance} />
            </label>
            <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--pbl-teacher)] bg-white text-xs font-bold text-[var(--pbl-teacher)] disabled:opacity-50" disabled={busy || !guidance.trim()} onClick={() => { const content = guidance; setGuidance(""); void action("teacher-guide", { content }); }} type="button"><Send size={14} />发布教师引导</button>
          </aside>
        </div>
      ) : <p className="p-4 text-sm text-stone-500"><Loader2 className="mr-2 inline animate-spin" size={15} />正在读取公开讨论状态…</p>}
      {error ? <p className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-xs leading-5 text-rose-800" role="alert"><CircleAlert className="mt-0.5 shrink-0" size={14} />{error}</p> : null}
    </Shell>
  );
}

function CandidateOption({ candidate, checked, onSelect }: { candidate: PublicDiscussionCandidate; checked: boolean; onSelect: (studentId: string) => void }) {
  return <button aria-pressed={checked} className={cn("w-full rounded-lg border bg-white p-3 text-left transition", checked ? "border-[var(--pbl-teacher)] ring-2 ring-blue-100" : "border-stone-200 hover:border-stone-400")} onClick={() => onSelect(candidate.studentId)} type="button"><div className="flex items-center justify-between gap-2"><span className="font-bold text-stone-900">{candidate.studentName}</span><span className="flex items-center gap-1 text-[10px] font-bold text-emerald-700"><Check size={12} />在线</span></div><p className="mt-1 text-xs leading-5 text-[var(--pbl-teacher)]">{candidate.reason}</p><p className="mt-1 text-[11px] leading-5 text-stone-500">{candidate.evidence} · 已参与 {candidate.participationCount} 轮</p></button>;
}

function SetupStep({ complete, label, number }: { complete: boolean; label: string; number: number }) {
  return <li className="flex items-center gap-2 border-b border-stone-200 px-5 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><span className={cn("grid size-6 place-items-center rounded-full text-xs font-bold", complete ? "bg-[var(--pbl-teacher)] text-white" : "bg-stone-200 text-stone-600")}>{complete ? <Check size={13} /> : number}</span><span className={cn("text-xs font-bold", complete ? "text-stone-800" : "text-stone-500")}>{label}</span></li>;
}

function SectionHeading({ icon, number, title }: { icon: ReactNode; number: string; title: string }) {
  return <div className="flex items-center gap-2"><span className="text-[10px] font-bold tracking-[.12em] text-stone-400">{number}</span><span className="text-[var(--pbl-teacher)]">{icon}</span><h5 className="font-bold text-stone-950">{title}</h5></div>;
}

function RoundProgress({ roundCount }: { roundCount: number }) {
  return <div className="mt-4 flex items-center gap-3 border-t border-stone-200 pt-3"><span className="text-xs font-semibold text-stone-500">已完成 {roundCount} / 3 轮</span><div className="flex gap-1.5" aria-hidden="true">{[1, 2, 3].map((round) => <span className={cn("h-1.5 w-8 rounded-full", round <= roundCount ? "bg-[var(--pbl-teacher)]" : "bg-stone-200")} key={round} />)}</div></div>;
}

function DiscussionTurn({ turn }: { turn: PublicDiscussionTurn }) {
  const isAssistant = turn.role === "assistant";
  const isTeacher = turn.role === "teacher";
  return <article className={cn("flex gap-3", !isAssistant && "flex-row-reverse")}><span className={cn("grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-bold", isAssistant ? "bg-[var(--pbl-ai)] text-white" : isTeacher ? "bg-amber-100 text-amber-900" : "bg-[var(--pbl-student)] text-white")}>{isAssistant ? "AI" : isTeacher ? "师" : turn.studentName?.slice(0, 1) ?? "生"}</span><div className={cn("max-w-[82%] rounded-[10px] border px-3 py-2.5 text-sm leading-6", isAssistant ? "border-blue-100 bg-blue-50/70 text-stone-900" : isTeacher ? "border-amber-100 bg-amber-50 text-amber-950" : "border-emerald-100 bg-emerald-50 text-emerald-950")}><p className="mb-0.5 text-[10px] font-bold text-stone-500">{isAssistant ? "AI 主持" : isTeacher ? "教师" : turn.studentName ?? "学生"}</p>{turn.content}</div></article>;
}

function SummaryBlock({ snapshot }: { snapshot: PublicDiscussionSnapshot }) {
  const summary = snapshot.session?.summary;
  if (!summary) return null;
  return <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-950"><p className="font-bold">上一次公开讨论总结</p><p>{summary.keyConclusion}</p><p>{summary.misconceptionRepair}</p><p>{summary.transferQuestion}</p></div>;
}

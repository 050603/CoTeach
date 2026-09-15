"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Square,
  UserRoundCheck,
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
} from "@/lib/public-discussion/types";
import { subscribePublicDiscussionUpdates } from "@/lib/public-discussion/realtime-client";

function uuid(): string {
  return crypto.randomUUID();
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
  "awaiting-confirmation": "学生确认文字",
  "ai-generating": "AI 正在回应",
  "ai-ready": "AI 回答待播放",
  "ai-failed": "AI 回答失败",
  "awaiting-replacement": "等待教师换人",
  paused: "讨论已暂停",
  summarizing: "正在生成总结",
  ended: "讨论已结束",
};

export function PublicDiscussionTeacherPanel({
  course,
  recommendedKnowledgePointIds,
}: {
  course: Course;
  recommendedKnowledgePointIds: string[];
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
    await withBusy(() => post({
      action: "start",
      requestId: uuid(),
      knowledgePointId: point.id,
      topic: recommendation?.topic ?? point.name,
      mode,
      openingPrompt: openingPrompt.trim(),
      studentId: selectedStudentId,
      candidates: recommendation?.candidates,
    }));
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
        }),
      });
      const payload = await response.json().catch(() => ({})) as { base64?: string; format?: string; data?: { base64?: string; format?: string } };
      const base64 = payload.base64 ?? payload.data?.base64;
      if (!response.ok || !base64) throw new Error("AI 语音生成失败");
      const audio = new Audio(`data:audio/${payload.format ?? payload.data?.format ?? "mp3"};base64,${base64}`);
      audioRef.current = audio;
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
      || session.status !== "ai-ready"
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

  return (
    <Card className="mx-4 mt-4 overflow-hidden border-cyan-200 bg-cyan-50/30 p-0">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-cyan-100 bg-white px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-cyan-950 text-white"><Sparkles size={18} /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-stone-950">AI 公开追问与辩论</h4><Pill tone={active ? "blue" : "gray"}>{active ? statusLabels[session!.status] : "等待教师启动"}</Pill></div>
            <p className="mt-1 text-xs leading-5 text-stone-500">从共性问题中选择主题，AI 推荐人选，教师确认后由学生设备收音。</p>
          </div>
        </div>
        <button className="flex h-9 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-xs font-bold text-stone-700 hover:bg-stone-50" onClick={() => setShowSettings((value) => !value)} type="button"><Settings2 size={14} />识别设置<ChevronDown className={cn("transition", showSettings && "rotate-180")} size={13} /></button>
      </header>

      {showSettings && settings ? (
        <div className="grid gap-3 border-b border-cyan-100 bg-stone-50 px-4 py-3 md:grid-cols-[1fr_1fr_8rem_auto]">
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
          <button className="self-end rounded-lg bg-cyan-950 px-3 py-2 text-xs font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void saveSettings()} type="button">保存设置</button>
        </div>
      ) : null}

      {!active ? (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,.8fr)]">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold text-stone-600">讨论知识点
                <select className="mt-1 h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" onChange={(event) => { setSelectedPointId(event.target.value); setRecommendation(undefined); setSelectedStudentId(""); }} value={selectedPointId}>
                  {course.content.knowledgePoints.map((point) => <option key={point.id} value={point.id}>{recommendedKnowledgePointIds.includes(point.id) ? "共性问题 · " : ""}{point.name}</option>)}
                </select>
              </label>
              <label className="text-xs font-bold text-stone-600">互动方式
                <select className="mt-1 h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" onChange={(event) => { setMode(event.target.value as PublicDiscussionMode); setRecommendation(undefined); }} value={mode}>
                  <option value="inquiry">公开追问</option>
                  <option value="debate">观点辩论</option>
                </select>
              </label>
            </div>
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-cyan-300 bg-white text-sm font-bold text-cyan-950 disabled:opacity-50" disabled={busy || !selectedPointId} onClick={() => void recommend()} type="button">{busy ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />}AI 推荐在线学生与开场问题</button>
            {recommendation ? (
              <div className="space-y-2">
                {recommendation.candidates.length ? recommendation.candidates.map((candidate) => (
                  <CandidateOption candidate={candidate} checked={selectedStudentId === candidate.studentId} key={candidate.studentId} onSelect={setSelectedStudentId} />
                )) : <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">当前没有检测到在线学生。可从右侧名单手动选择，并先确认该生设备已进入课堂。</p>}
              </div>
            ) : null}
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-stone-600">手动选择学生
              <select className="mt-1 h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm" onChange={(event) => setSelectedStudentId(event.target.value)} value={selectedStudentId}>
                <option value="">请选择学生</option>
                {course.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-stone-600">公开开场问题
              <textarea className="mt-1 min-h-28 w-full resize-y rounded-lg border border-stone-300 bg-white p-3 text-sm leading-6" maxLength={2_000} onChange={(event) => setOpeningPrompt(event.target.value)} placeholder="先生成推荐，或由教师直接输入开场问题" value={openingPrompt} />
            </label>
            <button className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-cyan-950 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !selectedStudentId || !openingPrompt.trim() || course.status !== "teaching"} onClick={() => void start()} type="button"><UserRoundCheck size={17} />确认点名并开始</button>
            {session?.summary ? <SummaryBlock snapshot={snapshot!} /> : null}
          </div>
        </div>
      ) : session ? (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="border-b border-cyan-100 p-4 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-xs font-bold text-cyan-800">{session.mode === "debate" ? "观点辩论" : "公开追问"} · 第 {session.roundCount} 轮</p><h5 className="mt-1 text-lg font-bold text-stone-950">{session.topic}</h5><p className="mt-1 text-sm leading-6 text-stone-600">{session.openingPrompt}</p></div>
              <Pill tone={session.status === "ai-failed" || session.status === "awaiting-replacement" ? "red" : session.status === "paused" ? "orange" : "blue"}>{statusLabels[session.status]}</Pill>
            </div>
            <div className="mt-4 max-h-96 space-y-3 overflow-y-auto rounded-xl bg-stone-50 p-3" aria-live="polite">
              {session.turns.length ? session.turns.map((turn) => <article className={cn("max-w-[88%] rounded-xl px-3 py-2 text-sm leading-6", turn.role === "assistant" ? "bg-blue-100 text-blue-950" : turn.role === "teacher" ? "ml-auto bg-amber-100 text-amber-950" : "ml-auto bg-cyan-950 text-white")} key={turn.id}><p className="text-[10px] font-bold opacity-60">{turn.role === "assistant" ? "AI 主持" : turn.role === "teacher" ? "教师" : turn.studentName ?? "学生"}</p>{turn.content}</article>) : <p className="text-sm text-stone-500">等待 {session.currentStudent?.name ?? "学生"} 接受邀请并回答开场问题。</p>}
              {session.status === "ai-generating" || session.status === "summarizing" ? <p className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="animate-spin" size={15} />{session.status === "summarizing" ? "正在形成课堂总结…" : "AI 正在组织回应…"}</p> : null}
            </div>
            {session.shouldSuggestSummary ? <p className="mt-3 rounded-lg bg-emerald-50 p-2 text-xs font-semibold text-emerald-800">已完成 3 轮学生回答，可以结束并形成课堂总结，也可继续追问。</p> : null}
          </section>
          <aside className="space-y-3 p-4">
            <div className="rounded-xl bg-white p-3 ring-1 ring-stone-200"><p className="text-xs text-stone-500">当前学生</p><p className="mt-1 font-bold text-stone-950">{session.currentStudent?.name ?? "未选择"}</p></div>
            {!soundEnabled ? <button className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-950 text-sm font-bold text-white" onClick={() => void acquireSound()} type="button"><Volume2 size={17} />启用此页面的课堂声音</button> : <p className="flex items-center gap-2 rounded-lg bg-blue-50 p-3 text-xs font-semibold text-blue-900"><Volume2 size={16} />此页面控制 AI 语音{audioState === "loading" ? " · 正在生成" : audioState === "playing" ? " · 正在播放" : ""}</p>}
            {soundEnabled && !snapshot.teacher?.soundOwner ? <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800"><VolumeX className="mr-1 inline" size={14} />声音控制权已由其他页面取得。</p> : null}
            {audioState === "failed" && session.status === "ai-ready" ? <button className="h-10 w-full rounded-lg border border-blue-300 bg-white text-xs font-bold text-blue-900" onClick={() => void action("complete-playback", { clientId: soundClientIdRef.current })} type="button">语音失败，按字幕继续</button> : null}
            <div className="grid grid-cols-2 gap-2">
              {session.status === "paused" ? <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-emerald-300 bg-white text-xs font-bold text-emerald-800" disabled={busy} onClick={() => void action("resume")} type="button"><Play size={14} />恢复</button> : <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-amber-300 bg-white text-xs font-bold text-amber-800" disabled={busy} onClick={() => void action("pause")} type="button"><Pause size={14} />暂停</button>}
              <button className="flex h-10 items-center justify-center gap-1 rounded-lg border border-rose-300 bg-white text-xs font-bold text-rose-800" disabled={busy} onClick={() => void action("finish")} type="button"><Square size={13} />结束并总结</button>
            </div>
            {session.status === "ai-failed" ? <button className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-rose-700 text-xs font-bold text-white" disabled={busy} onClick={() => void action("retry-ai")} type="button"><RefreshCw size={14} />重试 AI 回答</button> : null}
            <label className="text-xs font-bold text-stone-600">换一位学生
              <select className="mt-1 h-10 w-full rounded-lg border border-stone-300 bg-white px-2 text-sm" onChange={(event) => { if (event.target.value) void action("invite", { studentId: event.target.value }); }} value="">
                <option value="">选择并点名…</option>
                {course.students.filter((student) => student.id !== session.currentStudent?.id).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-stone-600">教师文字引导
              <textarea className="mt-1 min-h-20 w-full rounded-lg border border-stone-300 bg-white p-2 text-sm" maxLength={1_500} onChange={(event) => setGuidance(event.target.value)} placeholder="补充条件、澄清任务或引导下一步" value={guidance} />
            </label>
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 text-xs font-bold text-amber-900 disabled:opacity-50" disabled={busy || !guidance.trim()} onClick={() => { const content = guidance; setGuidance(""); void action("teacher-guide", { content }); }} type="button"><Send size={14} />发布引导</button>
          </aside>
        </div>
      ) : <p className="p-4 text-sm text-stone-500"><Loader2 className="mr-2 inline animate-spin" size={15} />正在读取公开讨论状态…</p>}
      {error ? <p className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-xs leading-5 text-rose-800" role="alert"><CircleAlert className="mt-0.5 shrink-0" size={14} />{error}</p> : null}
    </Card>
  );
}

function CandidateOption({ candidate, checked, onSelect }: { candidate: PublicDiscussionCandidate; checked: boolean; onSelect: (studentId: string) => void }) {
  return <button className={cn("w-full rounded-xl border bg-white p-3 text-left transition", checked ? "border-cyan-700 ring-2 ring-cyan-200" : "border-stone-200 hover:border-cyan-300")} onClick={() => onSelect(candidate.studentId)} type="button"><div className="flex items-center justify-between gap-2"><span className="font-bold text-stone-900">{candidate.studentName}</span><span className="flex items-center gap-1 text-[10px] font-bold text-emerald-700"><Check size={12} />在线</span></div><p className="mt-1 text-xs leading-5 text-cyan-900">{candidate.reason}</p><p className="mt-1 text-[11px] leading-5 text-stone-500">证据：{candidate.evidence} · 已参与 {candidate.participationCount} 轮</p></button>;
}

function SummaryBlock({ snapshot }: { snapshot: PublicDiscussionSnapshot }) {
  const summary = snapshot.session?.summary;
  if (!summary) return null;
  return <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-950"><p className="font-bold">上一次公开讨论总结</p><p>{summary.keyConclusion}</p><p>{summary.misconceptionRepair}</p><p>{summary.transferQuestion}</p></div>;
}

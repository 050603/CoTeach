"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import Image from "next/image";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Circle,
  CircleDot,
  Eye,
  EyeOff,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Mic,
  Plug,
  RefreshCw,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  Users,
  Video,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { TeacherPlatformPage, TeacherPlatformHeader } from "@/components/platform/teacher-shell";
import { TeacherProfilePanel } from "./teacher-profile-panel";
import { SurveyKeywordSettings } from "@/components/platform/survey-keyword-settings";
import {
  Pill,
  PrimaryButton,
  TextArea,
  TextInput,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getProviderConnectionPresentation,
  getProviderStatePresentation,
} from "@/lib/teacher/ai-service-settings";
import type { ProviderSection } from "@/lib/openmaic-bridge/provider-config-editor";
import { qualifyModelForProvider, splitModelIds } from "@/lib/openmaic-bridge/model-id";

import { PROVIDERS } from "@openmaic/lib/ai/providers";
import { ASR_PROVIDERS, DEFAULT_TTS_VOICES, TTS_PROVIDERS, getTTSVoices } from "@openmaic/lib/audio/constants";
import {
  type TtsVoiceTimingCalibration,
} from "@openmaic/lib/audio/tts-timing";
import { getEnabledProvidersWithVoices } from "@openmaic/lib/audio/voice-resolver";
import { useSettingsStore } from "@openmaic/lib/store/settings";
import { AI_COMPANIONS } from "@/lib/ai-companions";
import { IMAGE_PROVIDERS } from "@openmaic/lib/media/image-providers";
import { VIDEO_PROVIDERS } from "@openmaic/lib/media/video-providers";
import { PDF_PROVIDERS } from "@openmaic/lib/pdf/constants";
import { WEB_SEARCH_PROVIDERS } from "@openmaic/lib/web-search/constants";
import { ServerProvidersInit } from "@openmaic/components/server-providers-init";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { ThemeProvider } from "@openmaic/lib/hooks/use-theme";

type TabKey = "llm" | "tts" | "asr" | "image" | "video" | "web-search" | "pdf" | "agent-voice" | "knowledge-tutor";

type ProviderMeta = {
  id: string;
  name: string;
  type?: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  baseUrlPlaceholder?: string;
  alternateBaseUrls?: Array<{ label: string; url: string }>;
  icon?: string;
  models: Array<{ id: string; name: string }>;
  defaultModelId?: string;
  description?: string;
};

type SavedConfig = {
  hasApiKey: boolean;
  baseUrl?: string;
  models?: string[];
  enabled?: boolean;
  defaultModel?: string;
  priority?: number;
  defaultVoice?: string;
  timingCalibrations?: TtsVoiceTimingCalibration[];
};

function getProviderRequestPreview(provider: ProviderMeta, baseUrl: string): string {
  if (provider.type === "bedrock") return "AWS SDK · Converse API";

  const endpoint = (baseUrl.trim() || provider.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!endpoint) return "保存服务地址后显示";

  switch (provider.type) {
    case "anthropic":
      return `${endpoint}/messages`;
    case "google":
      return `${endpoint}/models/{model}:generateContent`;
    case "azure":
      return `${endpoint}/deployments/{deployment}`;
    default:
      return `${endpoint}/chat/completions`;
  }
}

const TTS_CALIBRATION_TEXT =
  "在项目学习中，我们先观察现象，再提出可以验证的问题。接着收集证据、比较不同解释，并用清楚的语言说明判断依据。遇到复杂概念时，可以借助一个贴近生活的例子，逐步连接已有经验与新知识。最后，请停下来检查结论是否符合证据，并思考还有哪些条件可能影响结果。";

async function measureBase64AudioDuration(base64: string, format = "mp3"): Promise<number> {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: `audio/${format}` });
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = new Audio(url);
      const timeout = window.setTimeout(() => reject(new Error("无法读取标定音频时长。")), 15000);
      audio.addEventListener("loadedmetadata", () => {
        window.clearTimeout(timeout);
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
        else reject(new Error("标定音频时长无效。"));
      }, { once: true });
      audio.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("标定音频无法解码。"));
      }, { once: true });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ResultState = {
  ok: boolean;
  message: string;
  detail?: string;
  audioUrl?: string;
  previewUrl?: string;
} | null;

const TABS: Array<{
  key: TabKey;
  label: string;
  shortLabel: string;
  section: ProviderSection;
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  { key: "llm", label: "AI 大模型", shortLabel: "AI 模型", section: "providers", icon: Bot },
  { key: "tts", label: "语音朗读", shortLabel: "语音朗读", section: "tts", icon: Volume2 },
  { key: "asr", label: "语音识别", shortLabel: "语音识别", section: "asr", icon: Mic },
  { key: "image", label: "图像生成", shortLabel: "图像", section: "image", icon: ImageIcon },
  { key: "video", label: "视频生成", shortLabel: "视频", section: "video", icon: Video },
  { key: "web-search", label: "联网搜索", shortLabel: "搜索", section: "web-search", icon: Search },
  { key: "pdf", label: "PDF 解析", shortLabel: "PDF", section: "pdf", icon: FileText },
  { key: "agent-voice", label: "智能体音色", shortLabel: "音色", section: "tts", icon: Users },
  { key: "knowledge-tutor", label: "知识讲授助教", shortLabel: "知识助教", section: "providers", icon: GraduationCap },
];

const TAB_COPY: Record<TabKey, { title: string }> = {
  llm: {
    title: "AI 大模型",
  },
  tts: {
    title: "语音朗读",
  },
  asr: {
    title: "语音识别",
  },
  image: {
    title: "图像生成",
  },
  video: {
    title: "视频生成",
  },
  "web-search": {
    title: "联网搜索",
  },
  pdf: {
    title: "PDF 解析",
  },
  "agent-voice": {
    title: "智能体音色",
  },
  "knowledge-tutor": {
    title: "知识讲授助教",
  },
};

function getProvidersForTab(tab: TabKey): ProviderMeta[] {
  switch (tab) {
    case "llm":
      return Object.values(PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        baseUrlPlaceholder: provider.baseUrlPlaceholder,
        alternateBaseUrls: provider.alternateBaseUrls,
        icon: provider.icon,
        models: provider.models.map((model) => ({ id: model.id, name: model.name })),
        defaultModelId: provider.models[0]?.id,
      }));
    case "tts":
      return Object.values(TTS_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        icon: provider.icon,
        models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
        defaultModelId: provider.defaultModelId,
      }));
    case "asr":
      return Object.values(ASR_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        icon: provider.icon,
        models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
        defaultModelId: provider.defaultModelId,
      }));
    case "image":
      return Object.values(IMAGE_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        icon: provider.icon,
        models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
      }));
    case "video":
      return Object.values(VIDEO_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        icon: provider.icon,
        models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
      }));
    case "web-search":
      return Object.values(WEB_SEARCH_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: provider.defaultBaseUrl,
        icon: provider.icon,
        models: [],
      }));
    case "pdf":
      return Object.values(PDF_PROVIDERS).map((provider) => ({
        id: provider.id,
        name: provider.name,
        requiresApiKey: provider.requiresApiKey,
        defaultBaseUrl: (provider as { baseUrl?: string }).baseUrl,
        icon: provider.icon,
        models: [],
        description: (provider as { features?: string[] }).features?.join("、"),
      }));
    case "agent-voice":
    case "knowledge-tutor":
      return [];
  }
}

function configKey(section: ProviderSection, providerId: string) {
  return `${section}:${providerId}`;
}

function modelsToText(models: string[] | undefined, provider: ProviderMeta) {
  return [...new Set([
    ...provider.models.map((model) => model.id),
    ...(models ?? []),
  ])].join("\n");
}

function getInitialDefaultModel(provider: ProviderMeta, saved?: SavedConfig) {
  return saved?.defaultModel || saved?.models?.[0] || provider.defaultModelId || provider.models[0]?.id || "";
}

function getReadableError(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const record = data as { error?: unknown; message?: unknown; details?: unknown };
  const primary = typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : fallback;
  return typeof record.details === "string" && record.details !== primary
    ? `${primary}\n${record.details}`
    : primary;
}

/**
 * 推荐的 Qwen TTS 音色配置（按智能体性格匹配）。
 * 仅在当前 TTS 服务商为 qwen-tts 时作为一键推荐。
 */
const RECOMMENDED_QWEN_VOICES: Record<string, { voiceId: string; reason: string }> = {
  knowledge: { voiceId: "Ethan", reason: "沉稳男声，适合知识讲解的权威感" },
  ideation: { voiceId: "Maia", reason: "活泼女声，适合创意启发的灵动" },
  critic: { voiceId: "Aiden", reason: "锐利男声，适合质疑检验的穿透力" },
  planner: { voiceId: "Kai", reason: "干练男声，适合方案规划的条理" },
  reviewer: { voiceId: "Serena", reason: "温和女声，适合评审反馈的亲切" },
  recorder: { voiceId: "Chelsie", reason: "平稳女声，适合过程记录的沉静" },
};

function AgentVoiceConfig() {
  const { ttsProvidersConfig, ttsProviderId, agentVoiceOverrides, setAgentVoiceOverride } =
    useSettingsStore();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ResultState>(null);

  const enabledProviders = useMemo(
    () => getEnabledProvidersWithVoices(ttsProvidersConfig),
    [ttsProvidersConfig],
  );

  const currentProvider = enabledProviders.find((p) => p.providerId === ttsProviderId);
  const availableVoices = currentProvider?.voices ?? [];
  const availableModelGroups = currentProvider?.modelGroups ?? [];

  const isQwenProvider = ttsProviderId === "qwen-tts";
  const hasVoices = availableVoices.length > 0;

  function handleApplyRecommended() {
    if (!isQwenProvider) return;
    for (const companion of AI_COMPANIONS) {
      const rec = RECOMMENDED_QWEN_VOICES[companion.id];
      if (rec) {
        setAgentVoiceOverride(companion.id, {
          providerId: ttsProviderId,
          voiceId: rec.voiceId,
        });
      }
    }
  }

  function handleClearAll() {
    for (const companion of AI_COMPANIONS) {
      setAgentVoiceOverride(companion.id, undefined);
    }
  }

  async function handleTestVoice(companionId: string, voiceId: string) {
    setTestingId(companionId);
    setTestResult(null);
    try {
      const providerConfig = ttsProvidersConfig[ttsProviderId];
      const modelId = providerConfig?.modelId || undefined;
      const companion = AI_COMPANIONS.find((c) => c.id === companionId);
      const response = await fetch("/api/openmaic/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `大家好，我是${companion?.name ?? "智能体"}，很高兴和大家一起学习。`,
          audioId: `agent_voice_test_${companionId}`,
          ttsProviderId,
          ttsModelId: modelId,
          ttsVoice: voiceId,
          ttsSpeed: 1,
        }),
      });
      const data = await response.json().catch(() => null);
      const audioBase64 = data?.base64 ?? data?.data?.base64;
      if (!response.ok || data?.success === false || !audioBase64) {
        throw new Error(getReadableError(data, "试听失败，请检查语音服务配置。"));
      }
      const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
      await audio.play();
      setTestResult({ ok: true, message: `正在试听：${companion?.name}` });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : "试听失败，请稍后重试。",
      });
    } finally {
      setTestingId(null);
    }
  }

  if (enabledProviders.length === 0) {
    return (
      <EmptyPanel text="请先在「语音朗读」中配置 TTS 服务商，再回到此处设置智能体音色。" />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-stone-200 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
            <Volume2 size={17} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-stone-900">
              {currentProvider?.providerName ?? ttsProviderId}
            </span>
            <span className="block text-xs text-stone-500">{availableVoices.length} 个可用音色</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isQwenProvider ? (
            <PrimaryButton
              variant="outline"
              onClick={handleApplyRecommended}
              className="h-8 px-3 text-xs"
            >
              <SlidersHorizontal size={13} />
              应用推荐音色
            </PrimaryButton>
          ) : null}
          <PrimaryButton
            variant="outline"
            onClick={handleClearAll}
            className="h-8 px-3 text-xs"
          >
            <Trash2 size={13} />
            清空全部
          </PrimaryButton>
        </div>
      </div>

      <div className="divide-y divide-stone-100 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
        {AI_COMPANIONS.map((companion) => {
          const override = agentVoiceOverrides[companion.id];
          const selectedVoiceId = override?.voiceId ?? "";
          const rec = RECOMMENDED_QWEN_VOICES[companion.id];
          const isRecommended = isQwenProvider && rec && selectedVoiceId === rec.voiceId;

          return (
            <div key={companion.id} className="px-4 py-3.5 transition-colors hover:bg-stone-50/70">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg"
                    style={{ backgroundColor: companion.color + "20", color: companion.color }}
                  >
                    {companion.emoji}
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-bold text-stone-950">{companion.name}</span>
                      <Pill tone="blue" className="h-5 shrink-0 px-1.5 text-[10px]">
                        {companion.role}
                      </Pill>
                      {isRecommended ? (
                        <span className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--pbl-success-soft)] px-2 text-[10px] font-bold text-[var(--pbl-success)]">
                          <CheckCircle2 size={10} />
                          推荐
                        </span>
                      ) : null}
                  </div>
                </div>

                <div className="flex min-w-0 items-center gap-2 sm:w-[280px]">
                  <select
                    value={selectedVoiceId}
                    onChange={(e) => {
                      const voiceId = e.target.value;
                      if (voiceId) {
                        setAgentVoiceOverride(companion.id, {
                          providerId: ttsProviderId,
                          voiceId,
                        });
                      } else {
                        setAgentVoiceOverride(companion.id, undefined);
                      }
                    }}
                    className="h-9 min-w-0 flex-1 rounded-[6px] border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition focus:border-[var(--pbl-teacher)] focus:outline-none focus:ring-2 focus:ring-[var(--pbl-teacher)]/20"
                  >
                    <option value="">跟随默认音色</option>
                    {availableModelGroups.length > 1
                      ? availableModelGroups.map((group) => (
                          <optgroup key={group.modelId} label={group.modelName}>
                            {group.voices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </optgroup>
                        ))
                      : availableVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleTestVoice(companion.id, selectedVoiceId || availableVoices[0]?.id || "")}
                    disabled={!hasVoices || testingId === companion.id}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] border border-stone-300 bg-white text-stone-500 transition hover:border-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)] disabled:opacity-40"
                    title="试听"
                  >
                    {testingId === companion.id ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Volume2 size={15} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {testResult ? <ResultNotice result={testResult} /> : null}
    </div>
  );
}

type KnowledgeTutorSettings = {
  modelString?: string;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
};

function KnowledgeTutorConfig() {
  const { ttsProvidersConfig } = useSettingsStore();
  const [settings, setSettings] = useState<KnowledgeTutorSettings>({ ttsSpeed: 1 });
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ResultState>(null);
  const voiceProviders = useMemo(
    () => getEnabledProvidersWithVoices(ttsProvidersConfig),
    [ttsProvidersConfig],
  );
  const selectedVoiceProvider = voiceProviders.find((item) => item.providerId === settings.ttsProviderId);

  useEffect(() => {
    void Promise.all([
      fetch("/api/knowledge-lecture/settings").then((response) => response.json()),
      fetch("/api/openmaic/provider-config?section=providers").then((response) => response.json()),
    ]).then(([settingsPayload, providerPayload]) => {
      const configured = (providerPayload?.providers ?? {}) as Record<string, SavedConfig>;
      const options = Object.entries(configured).flatMap(([providerId, config]) => {
        if (!config.hasApiKey && config.enabled === undefined) return [];
        const provider = PROVIDERS[providerId as keyof typeof PROVIDERS];
        const models = config.models?.length ? config.models : provider?.models.map((model) => model.id) ?? [];
        return models.map((modelId) => ({
          value: `${providerId}:${modelId}`,
          label: `${provider?.name ?? providerId} · ${provider?.models.find((item) => item.id === modelId)?.name ?? modelId}`,
        }));
      });
      setModelOptions(options);
      setSettings(settingsPayload?.settings ?? { ttsSpeed: 1 });
    }).catch(() => setResult({ ok: false, message: "知识助教配置读取失败。" }))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const response = await fetch("/api/knowledge-lecture/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.settings) throw new Error("保存失败");
      setSettings(payload.settings);
      setResult({ ok: true, message: "知识讲授助教的模型与音色已保存。" });
    } catch (cause) {
      setResult({ ok: false, message: cause instanceof Error ? cause.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function testVoice() {
    if (!settings.ttsProviderId || !settings.ttsVoice) return;
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch("/api/openmaic/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "这是一段知识讲授助教的示范讲解。我们先看题目条件，再梳理判断依据。",
          audioId: `knowledge_tutor_test_${Date.now()}`,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: settings.ttsModelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed ?? 1,
        }),
      });
      const payload = await response.json().catch(() => null);
      const base64 = payload?.base64 ?? payload?.data?.base64;
      const format = payload?.format ?? payload?.data?.format ?? "mp3";
      if (!response.ok || !base64) throw new Error("试听生成失败");
      await new Audio(`data:audio/${format};base64,${base64}`).play();
      setResult({ ok: true, message: "正在试听知识助教音色。" });
    } catch (cause) {
      setResult({ ok: false, message: cause instanceof Error ? cause.message : "试听失败" });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <EmptyPanel text="正在读取知识助教配置…" />;

  return (
    <section className="overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <div className="border-b border-stone-200 bg-stone-50/70 px-5 py-4">
        <h3 className="font-bold text-stone-950">错题讲解模型与声音</h3>
        <p className="mt-1 text-xs leading-5 text-stone-500">学生打开逐题讲解时，助教会用这里指定的模型生成板书，并用所选音色自动朗读。</p>
      </div>
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <Field label="讲解模型" helper="仅显示已在 AI 大模型页完成配置的模型。" icon={Bot}>
          <select className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]" value={settings.modelString ?? ""} onChange={(event) => setSettings((current) => ({ ...current, modelString: event.target.value || undefined }))}>
            <option value="">跟随系统默认模型</option>
            {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <Field label="语音服务" helper="请先在语音朗读页配置并启用服务。" icon={Volume2}>
          <select className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]" value={settings.ttsProviderId ?? ""} onChange={(event) => {
            const provider = voiceProviders.find((item) => item.providerId === event.target.value);
            setSettings((current) => ({ ...current, ttsProviderId: event.target.value || undefined, ttsModelId: provider?.modelGroups[0]?.modelId, ttsVoice: provider?.voices[0]?.id }));
          }}>
            <option value="">浏览器默认语音（兜底）</option>
            {voiceProviders.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.providerName}</option>)}
          </select>
        </Field>
        <Field label="讲解音色" icon={Users}>
          <select disabled={!selectedVoiceProvider} className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm outline-none disabled:bg-stone-100" value={settings.ttsVoice ?? ""} onChange={(event) => setSettings((current) => ({ ...current, ttsVoice: event.target.value || undefined }))}>
            <option value="">选择音色</option>
            {(selectedVoiceProvider?.modelGroups.length ?? 0) > 1
              ? selectedVoiceProvider?.modelGroups.map((group) => <optgroup key={group.modelId} label={group.modelName}>{group.voices.map((voice) => <option key={`${group.modelId}:${voice.id}`} value={voice.id}>{voice.name}</option>)}</optgroup>)
              : selectedVoiceProvider?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </select>
        </Field>
        <Field label="讲解语速" helper={`${(settings.ttsSpeed ?? 1).toFixed(1)} 倍速`} icon={SlidersHorizontal}>
          <input className="w-full accent-[var(--pbl-teacher)]" type="range" min="0.7" max="1.3" step="0.1" value={settings.ttsSpeed ?? 1} onChange={(event) => setSettings((current) => ({ ...current, ttsSpeed: Number(event.target.value) }))} />
        </Field>
      </div>
      <div className="border-t border-stone-200 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <PrimaryButton className="h-10" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}保存配置</PrimaryButton>
          <PrimaryButton className="h-10" variant="outline" disabled={testing || !settings.ttsProviderId || !settings.ttsVoice} onClick={() => void testVoice()}>{testing ? <Loader2 className="animate-spin" size={15} /> : <Volume2 size={15} />}试听音色</PrimaryButton>
        </div>
        <ResultNotice result={result} />
      </div>
    </section>
  );
}

export default function TeacherSettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("llm");
  const [savedConfigs, setSavedConfigs] = useState<Record<string, SavedConfig>>({});
  const [configLoading, setConfigLoading] = useState(true);
  const [selectedLlmId, setSelectedLlmId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [editApiKey, setEditApiKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editModels, setEditModels] = useState("");
  const [editDefaultModel, setEditDefaultModel] = useState("");
  const [editDefaultVoice, setEditDefaultVoice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [calibratingProviderId, setCalibratingProviderId] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<ResultState>(null);
  const [testResult, setTestResult] = useState<ResultState>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderMeta | null>(null);
  const [deleting, setDeleting] = useState(false);

  const currentTab = TABS.find((tab) => tab.key === activeTab)!;
  const tabCopy = TAB_COPY[activeTab];
  const providers = useMemo(() => getProvidersForTab(activeTab), [activeTab]);
  const filteredProviders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return providers;
    return providers.filter((provider) =>
      `${provider.name} ${provider.id}`.toLowerCase().includes(needle),
    );
  }, [providers, query]);

  const getSavedConfig = useCallback(
    (section: ProviderSection, providerId: string) => savedConfigs[configKey(section, providerId)],
    [savedConfigs],
  );

  const fillForm = useCallback(
    (provider: ProviderMeta) => {
      const saved = getSavedConfig(currentTab.section, provider.id);
      setEditApiKey("");
      setEditBaseUrl(saved?.baseUrl || provider.defaultBaseUrl || "");
      setEditModels(modelsToText(saved?.models, provider));
      setEditDefaultModel(getInitialDefaultModel(provider, saved));
      setEditDefaultVoice(
        saved?.defaultVoice ||
          DEFAULT_TTS_VOICES[provider.id as keyof typeof DEFAULT_TTS_VOICES] ||
          "default",
      );
      setShowApiKey(false);
      setSaveResult(null);
      setTestResult(null);
    },
    [currentTab.section, getSavedConfig],
  );

  const fetchConfigs = useCallback(async (section: ProviderSection) => {
    setConfigLoading(true);
    try {
      const response = await fetch(`/api/openmaic/provider-config?section=${section}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      const providersData =
        (data?.providers as Record<string, SavedConfig> | undefined) ??
        (data?.data?.providers as Record<string, SavedConfig> | undefined);

      if (!response.ok || !providersData) throw new Error(getReadableError(data, "读取已保存配置失败，请重试。"));
      if (providersData) {
        setSavedConfigs((current) => ({
          ...current,
          ...Object.fromEntries(
            Object.entries(providersData).map(([providerId, value]) => [
              configKey(section, providerId),
              value,
            ]),
          ),
        }));
      }
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchConfigs(currentTab.section).catch((error: Error) => setSaveResult({ ok: false, message: error.message }));
  }, [currentTab.section, fetchConfigs]);

  useEffect(() => {
    if (activeTab !== "llm" || selectedLlmId || configLoading || providers.length === 0) return;

    const configured = providers.find(
      (provider) => getSavedConfig("providers", provider.id)?.hasApiKey,
    );
    const initialProvider = configured ?? providers[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedLlmId(initialProvider.id);
    fillForm(initialProvider);
  }, [activeTab, configLoading, fillForm, getSavedConfig, providers, selectedLlmId]);

  function selectProvider(provider: ProviderMeta) {
    fillForm(provider);
    if (activeTab === "llm") {
      setSelectedLlmId(provider.id);
    } else {
      setExpandedId(provider.id);
    }
  }

  function handleModelTextChange(value: string) {
    setEditModels(value);
    const modelIds = splitModelIds(value);
    if (!modelIds.includes(editDefaultModel)) {
      setEditDefaultModel(modelIds[0] || "");
    }
  }

  async function handleSave(provider: ProviderMeta, makeDefault = true) {
    const saved = getSavedConfig(currentTab.section, provider.id);
    const modelIds = splitModelIds(editModels);

    if (provider.requiresApiKey && !saved?.hasApiKey && !editApiKey.trim()) {
      setSaveResult({ ok: false, message: "请先填写密钥。" });
      return false;
    }

    if (activeTab === "llm" && modelIds.length === 0) {
      setSaveResult({ ok: false, message: "请至少保留一个模型。" });
      return false;
    }

    setSavingProviderId(provider.id);
    setSaveResult(null);
    try {
      const response = await fetch("/api/openmaic/provider-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: currentTab.section,
          providerId: provider.id,
          apiKey: editApiKey.trim(),
          baseUrl: editBaseUrl.trim() || undefined,
          enabled: true,
          models: modelIds.length > 0 ? modelIds : undefined,
          defaultModel: editDefaultModel || modelIds[0] || undefined,
          ...(activeTab === "tts" ? { defaultVoice: editDefaultVoice || "default" } : {}),
          ...(makeDefault ? { priority: 0 } : {}),
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || data?.success === false) {
        throw new Error(getReadableError(data, "保存失败，请检查配置。"));
      }

      // The save receipt is authoritative; a later failed refresh must not forget the key.
      if (!data?.provider || typeof data.provider.hasApiKey !== "boolean") {
        throw new Error("配置已提交，但未收到保存状态，请刷新页面确认后再修改密钥。");
      }
      setSavedConfigs((current) => ({ ...current, [configKey(currentTab.section, provider.id)]: data.provider }));

      if (makeDefault) {
        await Promise.all(
          providers
            .filter((item) => item.id !== provider.id)
            .map(async (item) => {
              const otherSaved = getSavedConfig(currentTab.section, item.id);
              if (!otherSaved?.hasApiKey && otherSaved?.enabled === undefined) return;
              const otherModels = otherSaved?.models?.length
                ? otherSaved.models
                : item.models.map((model) => model.id);
              await fetch("/api/openmaic/provider-config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  section: currentTab.section,
                  providerId: item.id,
                  apiKey: "",
                  baseUrl: otherSaved?.baseUrl || item.defaultBaseUrl || undefined,
                  enabled: otherSaved?.enabled ?? true,
                  models: otherModels.length > 0 ? otherModels : undefined,
                  defaultModel:
                    otherSaved?.defaultModel ||
                    otherModels[0] ||
                    item.defaultModelId ||
                    undefined,
                  priority: 100,
                  ...(activeTab === "tts"
                    ? {
                        defaultVoice: otherSaved?.defaultVoice,
                        timingCalibrations: otherSaved?.timingCalibrations,
                      }
                    : {}),
                }),
              });
            }),
        );
      }

      setSaveResult({
        ok: true,
        message:
          activeTab === "tts" && makeDefault
            ? "语音朗读配置已保存，并设为默认服务。"
            : makeDefault
              ? "配置已保存，并设为当前默认。"
            : "配置已保存。",
      });
      setEditApiKey("");
      try { await fetchConfigs(currentTab.section); }
      catch { setSaveResult({ ok: true, message: "配置已保存；列表刷新失败，请稍后刷新页面。" }); }
      return true;
    } catch (error) {
      setSaveResult({
        ok: false,
        message: error instanceof Error ? error.message : "保存失败，请稍后重试。",
      });
      return false;
    } finally {
      setSavingProviderId(null);
    }
  }

  async function handleTestConnection(provider: ProviderMeta) {
    const saved = getSavedConfig(currentTab.section, provider.id);
    const modelId = editDefaultModel || splitModelIds(editModels)[0] || "";

    if (!modelId && activeTab !== "tts" && provider.models.length > 0) {
      setTestResult({ ok: false, message: "请先选择或填写一个模型 ID。" });
      return;
    }
    if (provider.requiresApiKey && !saved?.hasApiKey && !editApiKey.trim()) {
      setTestResult({ ok: false, message: "请先填写密钥，或保存已有配置后再测试。" });
      return;
    }

    if (activeTab === "tts") {
      if (provider.id === "browser-native-tts") {
        setTestResult({
          ok: false,
          message: "浏览器本地语音不能用于课程生成，请选择云端语音服务。",
        });
        return;
      }

      const voice = editDefaultVoice ||
        DEFAULT_TTS_VOICES[provider.id as keyof typeof DEFAULT_TTS_VOICES] || "default";
      setTestingProviderId(provider.id);
      setTestResult(null);
      try {
        const configResponse = await fetch("/api/openmaic/provider-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            section: "tts",
            providerId: provider.id,
            apiKey: editApiKey.trim(),
            baseUrl: editBaseUrl.trim() || undefined,
            enabled: true,
            models: splitModelIds(editModels).length ? splitModelIds(editModels) : undefined,
            defaultModel: modelId || undefined,
            defaultVoice: voice,
            priority: saved?.priority,
          }),
        });
        if (!configResponse.ok) {
          const configError = await configResponse.json().catch(() => null);
          throw new Error(getReadableError(configError, "语音配置保存失败，未开始测试。"));
        }
        const response = await fetch("/api/openmaic/generate/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: TTS_CALIBRATION_TEXT,
            audioId: `settings_test_${provider.id}`,
            ttsProviderId: provider.id,
            ttsModelId: modelId || undefined,
            ttsVoice: voice,
            ttsSpeed: 1,
            ttsApiKey: editApiKey.trim() || undefined,
            ttsBaseUrl: editBaseUrl.trim() || undefined,
          }),
        });
        const data = await response.json().catch(() => null);
        const audioBase64 = data?.base64 ?? data?.data?.base64;
        const format = data?.format ?? data?.data?.format ?? "mp3";

        if (!response.ok || data?.success === false || !audioBase64) {
          throw new Error(getReadableError(data, "语音测试失败，请检查密钥、服务地址、模型和音色。"));
        }

        const measuredDurationSec = await measureBase64AudioDuration(audioBase64, format);
        const calibrationResponse = await fetch("/api/openmaic/tts-calibration", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: provider.id,
            modelId,
            voiceId: voice,
            language: "zh-CN",
            speed: 1,
            text: TTS_CALIBRATION_TEXT,
            measuredDurationSec,
            apiKey: editApiKey.trim(),
            baseUrl: editBaseUrl.trim() || undefined,
            models: splitModelIds(editModels),
          }),
        });
        const calibrationData = await calibrationResponse.json().catch(() => null);
        if (!calibrationResponse.ok || calibrationData?.success === false) {
          throw new Error(getReadableError(calibrationData, "音频生成成功，但语速建模保存失败。"));
        }
        const calibration = calibrationData?.calibration ?? calibrationData?.data?.calibration;
        const audioUrl = `data:audio/${format};base64,${audioBase64}`;
        const audio = new Audio(audioUrl);
        void audio.play().catch(() => undefined);
        setTestResult({
          ok: true,
          message: "语音测试成功，已自动试听并完成自然语速建模。",
          detail: `模型：${modelId || "默认"}；音色：${voice}；实测 ${measuredDurationSec.toFixed(2)} 秒；共享平均约 ${Number(calibration?.cjkCharsPerMinute ?? 0).toFixed(1)} 字/分钟（${calibration?.sampleCount ?? 1} 次样本）`,
          audioUrl,
        });
        await fetchConfigs("tts");
      } catch (error) {
        setTestResult({
          ok: false,
          message: error instanceof Error ? error.message : "语音测试失败，请稍后重试。",
          detail: `测试模型：${modelId || "默认"}；音色：${voice}`,
        });
      } finally {
        setTestingProviderId(null);
      }
      return;
    }

    if (activeTab === "llm") {
      const savedSuccessfully = await handleSave(provider, false);
      if (!savedSuccessfully) return;
    }

    const qualifiedModel = qualifyModelForProvider(modelId, provider.id);
    const isCapabilityTest = activeTab === "asr"
      || activeTab === "image"
      || activeTab === "video"
      || activeTab === "web-search"
      || activeTab === "pdf";
    setTestingProviderId(provider.id);
    setTestResult(null);

    try {
      const response = await fetch(isCapabilityTest ? "/api/openmaic/test-provider" : "/api/openmaic/verify-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: isCapabilityTest ? modelId : qualifiedModel,
          section: currentTab.section,
          providerId: provider.id,
          apiKey: editApiKey.trim() || undefined,
          baseUrl: editBaseUrl.trim() || undefined,
          providerType: provider.type,
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || data?.success === false) {
        throw new Error(getReadableError(data, "连接失败，请检查密钥、服务地址和模型。"));
      }

      setTestResult({
        ok: true,
        message: data?.message || "连接成功。",
        detail: data?.detail || `测试模型：${isCapabilityTest ? modelId : qualifiedModel}`,
        previewUrl: typeof data?.previewUrl === "string" ? data.previewUrl : undefined,
      });
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : "连接失败，请稍后重试。",
        detail: `服务：${provider.name}；模型：${isCapabilityTest ? modelId : qualifiedModel}`,
      });
    } finally {
      setTestingProviderId(null);
    }
  }

  async function handleCalibrateTts(provider: ProviderMeta) {
    setCalibratingProviderId(provider.id);
    try {
      await handleTestConnection(provider);
    } finally {
      setCalibratingProviderId(null);
    }
  }

  const selectedLlmProvider = providers.find((provider) => provider.id === selectedLlmId) ?? null;
  const selectedModalityProvider = providers.find((provider) => provider.id === expandedId) ?? null;
  const selectedProviderName = activeTab === "llm"
    ? selectedLlmProvider?.name
    : selectedModalityProvider?.name;
  const configuredProvidersCount = providers.filter((provider) => {
    const saved = savedConfigs[configKey(currentTab.section, provider.id)];
    return saved?.hasApiKey || saved?.enabled !== undefined;
  }).length;

  async function handleDelete(provider: ProviderMeta) {
    setDeleting(true);
    try {
      const response = await fetch("/api/openmaic/provider-config", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: currentTab.section, providerId: provider.id }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.success === false) {
        throw new Error(getReadableError(data, "删除失败。"));
      }
      setDeletingProvider(null);
      setSaveResult({ ok: true, message: `已删除 ${provider.name} 的配置。` });
      setTestResult(null);
      if (activeTab === "llm" && selectedLlmId === provider.id) {
        setSelectedLlmId(null);
      }
      if (expandedId === provider.id) {
        setExpandedId(null);
      }
      await fetchConfigs(currentTab.section);
    } catch (error) {
      setSaveResult({
        ok: false,
        message: error instanceof Error ? error.message : "删除失败，请稍后重试。",
      });
    } finally {
      setDeleting(false);
    }
  }

  function handleTabChange(tab: TabKey) {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setSaveResult(null);
    setTestResult(null);
    setQuery("");
    setConfigLoading(true);
    setSelectedLlmId(null);
    setExpandedId(null);
  }

  return (
    <TeacherPlatformPage><TeacherPlatformHeader active="settings" backHref="/teacher/classes" backLabel="返回教学班" /><div className="pbl-workspace-content pbl-settings-layout">
      <div className="pbl-page-heading"><div><p className="text-xs tracking-widest text-[var(--pbl-teacher)]">教师账号</p><h1 className="mt-3 font-semibold">个人中心</h1></div></div>
      <TeacherProfilePanel/>
      <SurveyKeywordSettings/>
      <section className="mb-5 border-t border-[var(--pbl-border)] pt-7" aria-labelledby="ai-service-settings-heading"><p className="text-xs tracking-widest text-[var(--pbl-teacher)]">教学能力配置</p><h2 id="ai-service-settings-heading" className="mt-2 text-xl font-semibold text-[var(--pbl-text-strong)]">AI 服务设置</h2><p className="mt-2 text-sm leading-6 text-[var(--pbl-text-muted)]">连接教学所需的模型与音视频服务，管理配置并验证可用性。</p></section>
      <ThemeProvider>
        <I18nProvider>
          <ServerProvidersInit />
          <div className="pbl-settings-workbench mb-8 min-w-0 overflow-hidden rounded-[14px] border border-stone-200 bg-white lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
            <aside className="min-w-0 border-b border-stone-200 bg-stone-50/70 lg:border-b-0 lg:border-r">
              <div className="border-b border-stone-200 px-4 py-4">
                <p className="text-[11px] font-semibold tracking-widest text-stone-500">服务类型</p>
                <h3 className="mt-1 text-base font-bold text-stone-900">模型与能力</h3>
              </div>
              <nav aria-label="AI 服务类型" className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.key;
                  const tabProviders = getProvidersForTab(tab.key);
                  const tabConfigured = tabProviders.filter((provider) => {
                    const saved = savedConfigs[configKey(tab.section, provider.id)];
                    return saved?.hasApiKey || saved?.enabled !== undefined;
                  }).length;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => handleTabChange(tab.key)}
                      className={cn(
                        "inline-flex min-h-11 min-w-[132px] items-center gap-2.5 rounded-[8px] px-3 text-left text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pbl-teacher)] lg:min-w-0",
                        active
                          ? "bg-[var(--pbl-teacher)] text-white"
                          : "text-stone-600 hover:bg-white hover:text-stone-950",
                      )}
                    >
                      <Icon size={16} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                      {tabConfigured > 0 ? (
                        <span className={cn(
                          "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold",
                          active
                            ? "bg-white/20 text-white"
                            : "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]",
                        )}>
                          {tabConfigured}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </nav>
            </aside>

            <section className="min-w-0">
              <header className="flex min-h-[73px] flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-stone-500">
                    <span>服务类型</span>
                    <span aria-hidden="true">/</span>
                    <span className="truncate text-[var(--pbl-teacher)]">{tabCopy.title}</span>
                    {selectedProviderName ? (
                      <><span aria-hidden="true">/</span><span className="truncate">{selectedProviderName}</span></>
                    ) : null}
                  </div>
                  <h2 className="mt-1 truncate text-lg font-bold text-stone-950">{tabCopy.title}</h2>
                </div>
                {activeTab !== "agent-voice" && activeTab !== "knowledge-tutor" ? (
                  <span className="shrink-0 text-xs font-medium tabular-nums text-stone-500">
                    {configuredProvidersCount}/{providers.length} 已配置
                  </span>
                ) : null}
              </header>

              <div className="min-w-0 p-3 sm:p-4">
                {configLoading ? (
                  <div className="mb-4 inline-flex items-center gap-2 rounded-[6px] bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-500">
                    <Loader2 size={16} className="animate-spin" />
                    正在读取服务端配置
                  </div>
                ) : null}

              {activeTab === "knowledge-tutor" ? (
                <KnowledgeTutorConfig />
              ) : activeTab === "agent-voice" ? (
                <AgentVoiceConfig />
              ) : activeTab === "llm" ? (
                <div className="grid items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                  <ProviderList
                    providers={filteredProviders}
                    totalCount={providers.length}
                    selectedId={selectedLlmId}
                    section={currentTab.section}
                    savedConfigs={savedConfigs}
                    query={query}
                    onQueryChange={setQuery}
                    onSelect={selectProvider}
                  />

                  {selectedLlmProvider ? (
                    <ProviderEditor
                      provider={selectedLlmProvider}
                      saved={getSavedConfig("providers", selectedLlmProvider.id)}
                      onDelete={() => setDeletingProvider(selectedLlmProvider)}
                    >
                      <LlmConfigForm
                        provider={selectedLlmProvider}
                        saved={getSavedConfig("providers", selectedLlmProvider.id)}
                        editApiKey={editApiKey}
                        editBaseUrl={editBaseUrl}
                        editModels={editModels}
                        editDefaultModel={editDefaultModel}
                        showApiKey={showApiKey}
                        saving={savingProviderId === selectedLlmProvider.id}
                        testing={testingProviderId === selectedLlmProvider.id}
                        saveResult={saveResult}
                        testResult={testResult}
                        onApiKeyChange={setEditApiKey}
                        onBaseUrlChange={setEditBaseUrl}
                        onModelsChange={handleModelTextChange}
                        onDefaultModelChange={setEditDefaultModel}
                        onShowApiKeyChange={setShowApiKey}
                        onSave={() => handleSave(selectedLlmProvider)}
                        onTest={() => handleTestConnection(selectedLlmProvider)}
                      />
                    </ProviderEditor>
                  ) : (
                    <EmptyPanel text="选择一个服务商后编辑连接信息。" />
                  )}
                </div>
              ) : (
                <div className="grid items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                  <ProviderList
                    providers={filteredProviders}
                    totalCount={providers.length}
                    selectedId={expandedId}
                    section={currentTab.section}
                    savedConfigs={savedConfigs}
                    query={query}
                    onQueryChange={setQuery}
                    onSelect={selectProvider}
                  />
                  {selectedModalityProvider ? (
                    <ProviderEditor
                      provider={selectedModalityProvider}
                      saved={getSavedConfig(currentTab.section, selectedModalityProvider.id)}
                      onDelete={() => setDeletingProvider(selectedModalityProvider)}
                    >
                      <ModalityConfigForm
                        provider={selectedModalityProvider}
                        saved={getSavedConfig(currentTab.section, selectedModalityProvider.id)}
                        editApiKey={editApiKey}
                        editBaseUrl={editBaseUrl}
                        editModels={editModels}
                        editDefaultModel={editDefaultModel}
                        editDefaultVoice={editDefaultVoice}
                        showApiKey={showApiKey}
                        saving={savingProviderId === selectedModalityProvider.id}
                        testing={testingProviderId === selectedModalityProvider.id}
                        calibrating={calibratingProviderId === selectedModalityProvider.id}
                        saveResult={saveResult}
                        testResult={testResult}
                        onApiKeyChange={setEditApiKey}
                        onBaseUrlChange={setEditBaseUrl}
                        onModelsChange={setEditModels}
                        onDefaultModelChange={setEditDefaultModel}
                        onDefaultVoiceChange={setEditDefaultVoice}
                        onShowApiKeyChange={setShowApiKey}
                        onSave={() => handleSave(selectedModalityProvider)}
                        onTest={() => handleTestConnection(selectedModalityProvider)}
                        onCalibrate={activeTab === "tts" ? () => handleCalibrateTts(selectedModalityProvider) : undefined}
                      />
                    </ProviderEditor>
                  ) : (
                    <EmptyPanel text="选择一个服务商后编辑连接信息。" />
                  )}
                </div>
              )}
              </div>
            </section>
          </div>
        </I18nProvider>
      </ThemeProvider>

      {/* 删除确认对话框 */}
      {deletingProvider ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-stone-900">确认删除配置</h3>
            <p className="mt-3 text-sm leading-6 text-stone-600">
              即将删除 <span className="font-bold text-stone-900">{deletingProvider.name}</span> 的密钥、
              服务地址、模型列表等全部配置。删除后需重新填写才能使用该服务。
            </p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeletingProvider(null)}
                disabled={deleting}
                className="h-9 rounded-[8px] border border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 transition hover:bg-stone-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deletingProvider)}
                disabled={deleting}
                className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--pbl-danger)] px-4 text-sm font-medium text-white transition hover:bg-[var(--pbl-danger-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-danger)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div></TeacherPlatformPage>
  );
}

function ProviderEditor({
  provider,
  saved,
  onDelete,
  children,
}: {
  provider: ProviderMeta;
  saved?: SavedConfig;
  onDelete: () => void;
  children: ReactNode;
}) {
  const hasSavedConfig = Boolean(saved?.hasApiKey || saved?.enabled !== undefined);

  return (
    <section className="pbl-settings-editor min-w-0 overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-stone-200 bg-stone-50/70 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo icon={provider.icon} name={provider.name} />
          <div className="min-w-0">
            <p className="mb-0.5 text-[10px] font-semibold tracking-widest text-stone-500">
              连接与模型
            </p>
            <h3 className="truncate text-base font-bold text-stone-950" title={provider.name}>
              {provider.name}
            </h3>
            <p className="truncate text-xs text-stone-500" title={provider.id}>{provider.id}</p>
          </div>
        </div>
        <div className="flex min-w-0 shrink items-center justify-end gap-2">
          <div className="min-w-0 max-w-[220px]">
            <ProviderStateBadge provider={provider} saved={saved} />
          </div>
          {hasSavedConfig ? (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-stone-400 transition hover:bg-[var(--pbl-danger-soft)] hover:text-[var(--pbl-danger)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-danger)]"
              title="删除配置"
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function ProviderList({
  providers,
  totalCount,
  selectedId,
  section,
  savedConfigs,
  query,
  onQueryChange,
  onSelect,
}: {
  providers: ProviderMeta[];
  totalCount: number;
  selectedId: string | null;
  section: ProviderSection;
  savedConfigs: Record<string, SavedConfig>;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (provider: ProviderMeta) => void;
}) {
  return (
    <aside className="pbl-settings-provider-list min-w-0 overflow-hidden rounded-[12px] border border-stone-200 bg-white lg:sticky lg:top-20">
      <div className="border-b border-stone-200 bg-stone-50/70 p-3">
        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <div>
            <p className="text-[10px] font-semibold tracking-widest text-stone-500">服务商与 API</p>
            <h3 className="mt-0.5 text-sm font-bold text-stone-800">选择接入服务</h3>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-stone-500">
            {providers.length === totalCount ? totalCount : `${providers.length}/${totalCount}`}
          </span>
        </div>
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400"
          />
          <TextInput
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索服务商"
            className="h-9 bg-white pl-9 text-sm"
          />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto p-2 lg:max-h-[calc(100vh-248px)]">
        {providers.length === 0 ? (
          <div className="grid min-h-28 place-items-center px-4 text-center text-sm text-stone-500">
            没有匹配的服务商
          </div>
        ) : (
          <div className="space-y-1">
            {providers.map((provider) => {
              const saved = savedConfigs[configKey(section, provider.id)];
              const selected = selectedId === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(provider)}
                  className={cn(
                    "group relative flex min-h-[64px] w-full min-w-0 items-center gap-3 overflow-hidden rounded-[8px] px-2.5 py-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pbl-teacher)]",
                    selected
                      ? "bg-[var(--pbl-teacher-soft)]"
                      : "hover:bg-stone-50",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--pbl-teacher)] transition-opacity",
                      selected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <ProviderLogo icon={provider.icon} name={provider.name} />
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="block truncate text-sm font-bold text-stone-900" title={provider.name}>
                      {provider.name}
                    </span>
                    <span className="mt-1.5 block min-w-0 overflow-hidden">
                      <ProviderStateBadge provider={provider} saved={saved} />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function LlmConfigForm({
  provider,
  saved,
  editApiKey,
  editBaseUrl,
  editModels,
  editDefaultModel,
  showApiKey,
  saving,
  testing,
  saveResult,
  testResult,
  onApiKeyChange,
  onBaseUrlChange,
  onModelsChange,
  onDefaultModelChange,
  onShowApiKeyChange,
  onSave,
  onTest,
}: {
  provider: ProviderMeta;
  saved?: SavedConfig;
  editApiKey: string;
  editBaseUrl: string;
  editModels: string;
  editDefaultModel: string;
  showApiKey: boolean;
  saving: boolean;
  testing: boolean;
  saveResult: ResultState;
  testResult: ResultState;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onShowApiKeyChange: (value: boolean) => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const modelIds = splitModelIds(editModels);
  const testModel = editDefaultModel || modelIds[0] || "";
  const connection = getProviderConnectionPresentation({
    providerId: provider.id,
    providerType: provider.type,
    baseUrl: editBaseUrl,
    defaultBaseUrl: provider.defaultBaseUrl,
  });

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "rounded-[8px] border px-3 py-3 text-sm",
          connection.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-800",
          connection.tone === "warning" && "border-amber-300 bg-amber-50 text-amber-900",
          connection.tone === "info" && "border-blue-200 bg-blue-50 text-blue-800",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-bold">
          <span>接入方式：{connection.label}</span>
          <span>接口协议：{connection.protocol}</span>
        </div>
        <p className="mt-1.5 leading-5 opacity-90">{connection.credentialHint}</p>
      </div>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <SecretField
          label="密钥"
          value={editApiKey}
          show={showApiKey}
          required={provider.requiresApiKey}
          saved={saved?.hasApiKey}
          placeholder={saved?.hasApiKey ? "密钥已保存（留空表示不修改）" : "输入密钥"}
          onChange={onApiKeyChange}
          onToggleShow={() => onShowApiKeyChange(!showApiKey)}
        />

        <Field label="服务地址" icon={Server}>
          <TextInput
            value={editBaseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder={provider.baseUrlPlaceholder || provider.defaultBaseUrl || "输入兼容服务地址"}
          />
          {provider.defaultBaseUrl ? (
            <button
              type="button"
              onClick={() => onBaseUrlChange(provider.defaultBaseUrl || "")}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)]"
            >
              <RefreshCw size={13} />
              {provider.id === "deepseek" ? "切换到 DeepSeek 官方地址" : "恢复官方默认地址"}
            </button>
          ) : null}
          <span className="mt-2 block break-all text-xs leading-5 text-stone-500">
            调用目标：{getProviderRequestPreview(provider, editBaseUrl)}
          </span>
        </Field>
      </div>

      <Field label="模型列表" helper="每行一个模型 ID。" icon={Bot}>
        <TextArea
          value={editModels}
          onChange={(event) => onModelsChange(event.target.value)}
          rows={4}
          placeholder="deepseek-v4-flash&#10;deepseek-v4-pro"
        />
      </Field>

      {modelIds.length > 0 ? (
        <Field
          label="默认模型"
          helper={`连接测试将使用 ${qualifyModelForProvider(testModel, provider.id)}`}
          icon={CircleDot}
        >
          <div className="grid gap-2 md:grid-cols-2">
            {modelIds.map((modelId) => {
              const modelMeta = provider.models.find((model) => model.id === modelId);
              const selected = editDefaultModel === modelId;
              return (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => onDefaultModelChange(modelId)}
                  className={cn(
                    "flex min-h-12 min-w-0 items-center gap-2 overflow-hidden rounded-[8px] border px-3 py-2 text-left text-sm transition",
                    selected
                      ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] ring-1 ring-[var(--pbl-teacher)]/20"
                      : "border-stone-200 bg-white text-stone-600 hover:border-stone-300",
                  )}
                >
                  {selected ? (
                    <Zap size={17} className="shrink-0 text-[var(--pbl-teacher)]" />
                  ) : (
                    <Circle size={17} className="shrink-0 text-stone-300" />
                  )}
                  <span className="min-w-0 overflow-hidden">
                    <span className="block truncate font-bold" title={modelMeta?.name || modelId}>{modelMeta?.name || modelId}</span>
                    {modelMeta ? <span className="block truncate text-xs opacity-75">{modelId}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      <ActionRow
        saving={saving}
        testing={testing}
        saveResult={saveResult}
        testResult={testResult}
        onSave={onSave}
        onTest={onTest}
      />
    </div>
  );
}

function ModalityConfigForm({
  provider,
  saved,
  editApiKey,
  editBaseUrl,
  editModels,
  editDefaultModel,
  editDefaultVoice,
  showApiKey,
  saving,
  testing,
  calibrating,
  saveResult,
  testResult,
  onApiKeyChange,
  onBaseUrlChange,
  onModelsChange,
  onDefaultModelChange,
  onDefaultVoiceChange,
  onShowApiKeyChange,
  onSave,
  onTest,
  onCalibrate,
}: {
  provider: ProviderMeta;
  saved?: SavedConfig;
  editApiKey: string;
  editBaseUrl: string;
  editModels: string;
  editDefaultModel: string;
  editDefaultVoice: string;
  showApiKey: boolean;
  saving: boolean;
  testing: boolean;
  calibrating: boolean;
  saveResult: ResultState;
  testResult: ResultState;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onDefaultVoiceChange: (value: string) => void;
  onShowApiKeyChange: (value: boolean) => void;
  onSave: () => void;
  onTest: () => void;
  onCalibrate?: () => void;
}) {
  const availableModels = provider.models ?? [];
  const modelIds = splitModelIds(editModels);
  const availableVoices = getTTSVoices(provider.id as keyof typeof TTS_PROVIDERS);
  const activeCalibration = saved?.timingCalibrations?.find(
    (item) => item.modelId === editDefaultModel
      && item.voiceId === editDefaultVoice
      && (item.language || "zh-CN").toLowerCase() === "zh-cn"
      && (item.speed ?? 1) === 1,
  );

  return (
    <div className="space-y-5">
      <div className="grid items-start gap-4 md:grid-cols-2">
        {provider.requiresApiKey ? (
          <SecretField
            label="密钥"
            value={editApiKey}
            show={showApiKey}
            required
            saved={saved?.hasApiKey}
            placeholder={saved?.hasApiKey ? "密钥已保存（留空表示不修改）" : "输入密钥"}
            onChange={onApiKeyChange}
            onToggleShow={() => onShowApiKeyChange(!showApiKey)}
          />
        ) : (
          <ResultNotice result={{ ok: true, message: "该服务不需要密钥。" }} />
        )}

        <Field label="服务地址" icon={Server}>
          <TextInput
            value={editBaseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder={provider.defaultBaseUrl || "可选：自定义服务地址"}
          />
          {provider.defaultBaseUrl ? (
            <button
              type="button"
              onClick={() => onBaseUrlChange(provider.defaultBaseUrl || "")}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--pbl-teacher)] hover:text-[var(--pbl-teacher)]"
            >
              <RefreshCw size={13} />
              恢复默认地址
            </button>
          ) : null}
        </Field>
      </div>

      {availableModels.length > 0 ? (
          <Field label="模型" helper="选择保存后使用的默认模型。" icon={Bot}>
            <div className="grid gap-2 sm:grid-cols-2">
              {availableModels.map((m) => {
                const isActive = editDefaultModel === m.id;
                const isSelected = modelIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onDefaultModelChange(m.id);
                      if (!isSelected) {
                        onModelsChange(editModels ? `${editModels}, ${m.id}` : m.id);
                      }
                    }}
                    className={cn(
                      "flex min-h-10 min-w-0 items-center gap-2 overflow-hidden rounded-[8px] border px-3 py-2 text-left text-xs font-medium transition",
                      isActive
                        ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)] ring-1 ring-[var(--pbl-teacher)]/20"
                        : isSelected
                          ? "border-stone-300 bg-stone-50 text-stone-700"
                          : "border-stone-200 bg-white text-stone-500 hover:border-stone-300",
                    )}
                  >
                    {isActive ? (
                      <Zap size={12} className="text-[var(--pbl-teacher)]" />
                    ) : (
                      <Circle size={12} />
                    )}
                    <span className="min-w-0 truncate" title={m.name || m.id}>{m.name || m.id}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

      {onCalibrate ? (
          <Field
            label="默认音色与自然语速"
            helper="基于当前模型与音色测量中文自然语速。"
            icon={Volume2}
          >
            <select
              value={editDefaultVoice}
              onChange={(event) => onDefaultVoiceChange(event.target.value)}
              className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none focus:border-[var(--pbl-teacher)]"
            >
              {availableVoices.length > 0 ? availableVoices.map((voice) => (
                <option key={voice.id} value={voice.id}>{voice.name}</option>
              )) : <option value="default">默认音色</option>}
            </select>
            {activeCalibration ? (
              <div className="mt-2 rounded-[8px] border border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] px-3 py-2 text-xs text-[var(--pbl-success)]">
                已建模：约 {activeCalibration.cjkCharsPerMinute.toFixed(1)} 字/分钟，累计 {activeCalibration.sampleCount ?? 1} 次测试
              </div>
            ) : (
              <div className="mt-2 text-xs text-[var(--pbl-warning)]">当前模型与音色尚未建模，将暂用内置保守语速。</div>
            )}
          </Field>
        ) : null}

      <ActionRow
        saving={saving}
        testing={testing}
        calibrating={calibrating}
        saveResult={saveResult}
        testResult={testResult}
        onSave={onSave}
        onTest={onTest}
        onCalibrate={onCalibrate}
      />

      {testResult?.audioUrl ? (
        <audio className="w-full" controls preload="metadata" src={testResult.audioUrl} />
      ) : null}
      {testResult?.previewUrl ? (
        <Image
          alt="图像模型测试结果"
          className="h-auto max-h-72 w-full rounded-[8px] border border-stone-200 object-contain"
          height={320}
          src={testResult.previewUrl}
          unoptimized
          width={640}
        />
      ) : null}
    </div>
  );
}

function ActionRow({
  saving,
  testing,
  calibrating = false,
  saveResult,
  testResult,
  onSave,
  onTest,
  onCalibrate,
}: {
  saving: boolean;
  testing: boolean;
  calibrating?: boolean;
  saveResult: ResultState;
  testResult: ResultState;
  onSave: () => void;
  onTest: () => void;
  onCalibrate?: () => void;
}) {
  return (
    <div className="space-y-3 border-t border-stone-200 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={onSave} disabled={saving || testing} className="h-10 px-4 text-sm">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          保存配置
        </PrimaryButton>
        <PrimaryButton
          variant="outline"
          onClick={onTest}
          disabled={saving || testing}
          className="h-10 px-4 text-sm"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
          {testing ? "正在测试" : "保存并测试连接"}
        </PrimaryButton>
        {onCalibrate ? (
          <PrimaryButton
            variant="outline"
            onClick={onCalibrate}
            disabled={saving || testing || calibrating}
            className="h-10 px-4 text-sm"
          >
            {calibrating ? <Loader2 size={15} className="animate-spin" /> : <SlidersHorizontal size={15} />}
            语速建模
          </PrimaryButton>
        ) : null}
      </div>
      <ResultNotice result={saveResult} />
      <ResultNotice result={testResult} />
    </div>
  );
}

function Field({
  label,
  helper,
  icon: Icon,
  children,
}: {
  label: string;
  helper?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-2 text-sm font-bold text-stone-800">
        {Icon ? <Icon size={16} className="text-stone-400" /> : null}
        {label}
      </span>
      {children}
      {helper ? <span className="mt-2 block text-xs leading-5 text-stone-500">{helper}</span> : null}
    </label>
  );
}

function SecretField({
  label,
  value,
  show,
  required,
  saved,
  placeholder,
  onChange,
  onToggleShow,
}: {
  label: string;
  value: string;
  show: boolean;
  required?: boolean;
  saved?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onToggleShow: () => void;
}) {
  return (
    <Field
      label={label}
      helper={
        saved
          ? "已保存的密钥不会回显；留空保存会继续保留原密钥。"
          : required
            ? "该服务需要有效密钥。"
            : "该服务可以不填写密钥。"
      }
      icon={KeyRound}
    >
      {saved && <span className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 size={13} />密钥已保存</span>}
      <div className="relative">
        <TextInput
          type={show ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="pr-11"
        />
        <button
          type="button"
          aria-label={show ? "隐藏密钥" : "显示密钥"}
          onClick={onToggleShow}
          className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-[6px] text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </Field>
  );
}

function ResultNotice({ result, compact = false }: { result: ResultState; compact?: boolean }) {
  if (!result) return null;

  return (
    <div
      className={cn(
        "flex gap-2 rounded-[8px] border text-sm",
        compact ? "mt-2 px-2 py-2 text-xs" : "px-3 py-2",
        result.ok
          ? "border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]"
          : "border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)]",
      )}
    >
      {result.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <X size={16} className="mt-0.5 shrink-0" />}
      <span className="min-w-0">
        <span className="block font-semibold">{result.message}</span>
        {result.detail ? <span className="mt-1 block break-all opacity-80">{result.detail}</span> : null}
      </span>
    </div>
  );
}

function ProviderStateBadge({ provider, saved }: { provider: ProviderMeta; saved?: SavedConfig }) {
  const state = getProviderStatePresentation({
    requiresApiKey: provider.requiresApiKey,
    saved,
  });

  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
      <span
        className={cn(
          "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[10px] font-bold",
          state.tone === "success" && "bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]",
          state.tone === "info" && "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]",
          state.tone === "neutral" && "bg-stone-100 text-stone-500",
        )}
      >
        {state.tone === "success" ? <CheckCircle2 size={10} className="shrink-0" /> : null}
        {state.label}
      </span>
      {state.model ? (
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-500"
          title={state.model}
        >
          {state.model}
        </span>
      ) : null}
    </span>
  );
}

function ProviderLogo({ icon, name }: { icon?: string; name: string }) {
  const src = icon?.startsWith("/logos/") ? `/openmaic${icon}` : icon;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src && failedSrc !== src) {
    return (
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[8px] border border-stone-200 bg-white">
        <Image
          src={src}
          alt={name}
          width={name === "DeepSeek" ? 36 : 28}
          height={name === "DeepSeek" ? 36 : 28}
          unoptimized
          onError={() => setFailedSrc(src)}
          className={cn("object-contain", name === "DeepSeek" ? "h-9 w-9" : "h-7 w-7")}
        />
      </span>
    );
  }

  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[8px] bg-stone-100 text-sm font-bold text-stone-600">
      {name.slice(0, 2)}
    </span>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="grid min-h-56 place-items-center rounded-[8px] border border-dashed border-stone-300 bg-stone-50 text-center text-sm text-stone-500">
      <div>
        <AlertCircle className="mx-auto mb-2 text-stone-400" size={22} />
        {text}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
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
  UserRound,
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
import {
  type LlmThinkingScenarioConfigs,
  type LlmThinkingScenarioId,
  type ThinkingScenarioPreset,
} from "@openmaic/lib/ai/thinking-scenarios";
import { ThinkingScenarioPanel } from "./thinking-scenario-panel";
import { ASR_PROVIDERS, DEFAULT_TTS_VOICES, TTS_PROVIDERS, getTTSVoices } from "@openmaic/lib/audio/constants";
import {
  type TtsVoiceTimingCalibration,
} from "@openmaic/lib/audio/tts-timing";
import { getEnabledProvidersWithVoices } from "@openmaic/lib/audio/voice-resolver";
import {
  qwenAudioTtsModelForVoice,
  qwenAudioTtsVoiceForModel,
} from "@openmaic/lib/audio/qwen-audio-tts-catalog";
import {
  TTS_SCENARIOS,
  type TtsScenarioConfig,
  type TtsScenarioConfigs,
  type TtsScenarioId,
} from "@openmaic/lib/audio/tts-scenarios";
import { useSettingsStore } from "@openmaic/lib/store/settings";
import { AI_COMPANIONS } from "@/lib/ai-companions";
import { IMAGE_PROVIDERS } from "@openmaic/lib/media/image-provider-config";
import { VIDEO_PROVIDERS } from "@openmaic/lib/media/video-provider-config";
import { PDF_PROVIDERS } from "@openmaic/lib/pdf/constants";
import { WEB_SEARCH_PROVIDERS } from "@openmaic/lib/web-search/constants";
import { ServerProvidersInit } from "@openmaic/components/server-providers-init";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { ThemeProvider } from "@openmaic/lib/hooks/use-theme";

type TabKey = "llm" | "tts" | "asr" | "image" | "video" | "web-search" | "pdf" | "embedding" | "agent-voice" | "knowledge-tutor" | "quality-review";
type SettingsSection = "account" | "teaching" | "ai";
type AiServiceView = "overview" | "detail";

const SETTINGS_SECTIONS: Array<{
  key: SettingsSection;
  label: string;
  description: string;
  eyebrow: string;
  title: string;
  intro: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    key: "account",
    label: "账号与安全",
    description: "姓名、登录账号与密码",
    eyebrow: "教师账号",
    title: "账号与安全",
    intro: "管理教师身份信息和登录凭据。",
    icon: UserRound,
  },
  {
    key: "teaching",
    label: "教学偏好",
    description: "问卷与课堂分析方式",
    eyebrow: "课堂工具",
    title: "教学偏好",
    intro: "设置适用于当前教师账号的课堂分析方式。",
    icon: SlidersHorizontal,
  },
  {
    key: "ai",
    label: "AI 服务",
    description: "模型、语音与生成能力",
    eyebrow: "教学能力配置",
    title: "AI 服务设置",
    intro: "连接教学所需的模型与音视频服务，管理配置并验证可用性。",
    icon: Bot,
  },
];

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
  thinkingScenarioConfigs?: LlmThinkingScenarioConfigs;
  priority?: number;
  defaultVoice?: string;
  scenarioConfigs?: TtsScenarioConfigs;
  timingCalibrations?: TtsVoiceTimingCalibration[];
  dimensions?: number;
};

function getInitialTtsScenarioConfigs(
  provider: ProviderMeta,
  saved: SavedConfig | undefined,
  defaultModel: string,
  defaultVoice: string,
): TtsScenarioConfigs {
  const fallback = { modelId: defaultModel, voiceId: defaultVoice };
  return Object.fromEntries(TTS_SCENARIOS.map(({ id }) => {
    const configured = saved?.scenarioConfigs?.[id] ?? fallback;
    if (provider.id !== "qwen-tts") return [id, configured];
    return [id, {
      modelId: configured.modelId,
      voiceId: qwenAudioTtsVoiceForModel(configured.modelId, configured.voiceId),
    }];
  })) as TtsScenarioConfigs;
}

function getProviderRequestPreview(provider: ProviderMeta, baseUrl: string): string {
  if (provider.type === "bedrock") return "AWS SDK · Converse API";

  const endpoint = (baseUrl.trim() || provider.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!endpoint) return "保存服务地址后显示";
  if (provider.id.includes("embedding")) return `${endpoint}/embeddings`;

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
  { key: "embedding", label: "教材语义检索", shortLabel: "向量检索", section: "embedding", icon: Server },
  { key: "agent-voice", label: "智能体音色", shortLabel: "音色", section: "tts", icon: Users },
  { key: "knowledge-tutor", label: "知识讲授助教", shortLabel: "知识助教", section: "providers", icon: GraduationCap },
  { key: "quality-review", label: "课程质量检验", shortLabel: "质量检验", section: "providers", icon: Eye },
];

const AI_SERVICE_DETAILS: Record<TabKey, {
  description: string;
  related: string[];
  group: "course" | "classroom" | "content";
}> = {
  llm: {
    description: "为课程设计、教学内容生成和课堂智能体提供基础推理能力。",
    related: ["课程备课", "课堂智能体", "教学内容生成"],
    group: "course",
  },
  "knowledge-tutor": {
    description: "为知识讲授环节指定模型和讲授策略，独立控制课堂讲解能力。",
    related: ["知识讲授", "课堂助教", "教学策略"],
    group: "course",
  },
  "quality-review": {
    description: "检查课程页面排版与内容质量，并配置独立的视觉检验模型。",
    related: ["课程质量检验", "页面排版检查", "发布前复核"],
    group: "course",
  },
  tts: {
    description: "将教学文本转换为语音，用于课件讲解、课堂播报和智能体发言。",
    related: ["课件旁白", "知识讲授", "智能体发言"],
    group: "classroom",
  },
  asr: {
    description: "把课堂语音转换为文本，为语音输入和课堂互动提供支持。",
    related: ["课堂语音输入", "互动记录", "语音转写"],
    group: "classroom",
  },
  "agent-voice": {
    description: "为不同教学智能体分配音色，让课堂角色表达更容易区分。",
    related: ["智能体角色", "课堂对话", "语音试听"],
    group: "classroom",
  },
  image: {
    description: "生成课程封面和教学插图，补充备课与课件中的视觉素材。",
    related: ["课程封面", "课件插图", "视觉素材"],
    group: "content",
  },
  video: {
    description: "生成教学短视频和动态素材，为课程内容提供补充说明。",
    related: ["教学视频", "动态素材", "课程内容"],
    group: "content",
  },
  "web-search": {
    description: "为需要外部资料的教学任务提供联网检索和信息补充能力。",
    related: ["资料检索", "内容生成", "事实补充"],
    group: "content",
  },
  pdf: {
    description: "解析上传的 PDF 教学资料，提取可用于备课和课堂的内容。",
    related: ["教学资料", "文档解析", "课程资源"],
    group: "content",
  },
  embedding: {
    description: "为永久教材库建立 1024 维语义索引，用于匹配表述和粒度不同的课程知识要求。",
    related: ["教材库", "知识图谱", "课程知识匹配"],
    group: "content",
  },
};

const AI_SERVICE_GROUPS: Array<{
  key: "course" | "classroom" | "content";
  eyebrow: string;
  title: string;
  description: string;
  tabs: TabKey[];
  links: Array<{ label: string; href: string }>;
}> = [
  {
    key: "course",
    eyebrow: "01 · 核心能力",
    title: "课程设计与质量",
    description: "先建立课程生成的基础模型，再按需配置知识讲授和质量检验。",
    tabs: ["llm", "knowledge-tutor", "quality-review"],
    links: [{ label: "前往课程库", href: "/teacher/templates" }],
  },
  {
    key: "classroom",
    eyebrow: "02 · 课堂互动",
    title: "语音与智能体",
    description: "管理课堂朗读、语音识别，以及不同教学智能体的专属音色。",
    tabs: ["tts", "asr", "agent-voice"],
    links: [{ label: "前往教学班", href: "/teacher/classes" }],
  },
  {
    key: "content",
    eyebrow: "03 · 内容扩展",
    title: "素材与信息处理",
    description: "按课程需要接入图像、视频、联网搜索和 PDF 解析能力。",
    tabs: ["image", "video", "web-search", "pdf", "embedding"],
    links: [{ label: "查看课程资源", href: "/teacher/templates" }],
  },
];

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
    case "embedding":
      return [
        {
          id: "ollama-embedding",
          name: "本地 Ollama 向量服务",
          requiresApiKey: false,
          defaultBaseUrl: "http://127.0.0.1:11434/v1",
          models: [{ id: "qwen3-embedding:0.6b", name: "Qwen3 Embedding 0.6B（本地，1024 维）" }],
          defaultModelId: "qwen3-embedding:0.6b",
          description: "在本机生成教材向量，由 PostgreSQL pgvector 保存和检索，不需要外部 API 密钥。",
        },
        {
          id: "qwen-embedding",
          name: "OpenAI 兼容向量服务",
          requiresApiKey: true,
          defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          models: [{ id: "text-embedding-v4", name: "text-embedding-v4（1024 维）" }],
          defaultModelId: "text-embedding-v4",
          description: "使用远程兼容接口生成教材向量，固定输出 1024 维。",
        },
      ];
    case "agent-voice":
    case "knowledge-tutor":
    case "quality-review":
      return [];
  }
}

function configKey(section: ProviderSection, providerId: string) {
  return `${section}:${providerId}`;
}

function modelsToText(models: string[] | undefined, provider: ProviderMeta) {
  return (models?.length ? models : provider.models.map((model) => model.id)).join("\n");
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
  knowledge: { voiceId: "longanlufeng", reason: "明亮男声，适合清晰讲解" },
  ideation: { voiceId: "longanxiaoxin", reason: "亲切活泼，适合创意启发" },
  critic: { voiceId: "longchuanshu_v3.6", reason: "鲜明男声，适合质疑检验" },
  planner: { voiceId: "longjielidou_v3.6", reason: "清晰有活力，适合方案规划" },
  reviewer: { voiceId: "longanfengyue", reason: "自然亲切，适合评审反馈" },
  recorder: { voiceId: "longanlingxin", reason: "知心温暖，适合过程记录" },
};

function modelIdForVoice(
  provider: { modelGroups: Array<{ modelId: string; voices: Array<{ id: string }> }> } | undefined,
  voiceId: string,
): string | undefined {
  return provider?.modelGroups.find((group) =>
    group.voices.some((voice) => voice.id === voiceId)
  )?.modelId || undefined;
}

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
          modelId: qwenAudioTtsModelForVoice(rec.voiceId),
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
      const modelId = modelIdForVoice(currentProvider, voiceId) || providerConfig?.modelId || undefined;
      const companion = AI_COMPANIONS.find((c) => c.id === companionId);
      const response = await fetch("/api/openmaic/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `大家好，我是${companion?.name ?? "智能体"}，很高兴和大家一起学习。`,
          audioId: `agent_voice_test_${companionId}`,
          ttsProviderId,
          ttsScenario: "realtime-interaction",
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
                          modelId: modelIdForVoice(currentProvider, voiceId),
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
          ttsScenario: "realtime-interaction",
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
          <select disabled={!selectedVoiceProvider} className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm outline-none disabled:bg-stone-100" value={settings.ttsVoice ?? ""} onChange={(event) => {
            const voiceId = event.target.value || undefined;
            setSettings((current) => ({
              ...current,
              ttsVoice: voiceId,
              ttsModelId: voiceId ? modelIdForVoice(selectedVoiceProvider, voiceId) : undefined,
            }));
          }}>
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

type QualityReviewSettings = {
  modelString?: string;
};

function QualityReviewConfig() {
  const [settings, setSettings] = useState<QualityReviewSettings>({});
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [generationModelLabel, setGenerationModelLabel] = useState("正在读取…");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ResultState>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/course-quality-review/settings", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/openmaic/provider-config?section=providers", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([settingsPayload, providerPayload]) => {
      const configured = (providerPayload?.providers ?? {}) as Record<string, SavedConfig>;
      const enabledProviders = Object.entries(configured).filter(([, config]) => config.enabled !== false);
      const defaultEntry = [...enabledProviders].sort((left, right) =>
        (left[1].priority ?? Number.MAX_SAFE_INTEGER) - (right[1].priority ?? Number.MAX_SAFE_INTEGER),
      )[0];
      if (defaultEntry) {
        const [providerId, config] = defaultEntry;
        const provider = PROVIDERS[providerId as keyof typeof PROVIDERS];
        const modelId = config.defaultModel || config.models?.[0] || provider?.models[0]?.id;
        setGenerationModelLabel(modelId
          ? `${provider?.name ?? providerId} · ${provider?.models.find((model) => model.id === modelId)?.name ?? modelId}`
          : "尚未选择默认模型");
      } else {
        setGenerationModelLabel("尚未配置默认模型");
      }

      const options = enabledProviders.flatMap(([providerId, config]) => {
        const provider = PROVIDERS[providerId as keyof typeof PROVIDERS];
        const modelIds = config.models?.length
          ? config.models
          : provider?.models.map((model) => model.id) ?? [];
        return modelIds.flatMap((modelId) => {
          const model = provider?.models.find((candidate) => candidate.id === modelId);
          if (model?.capabilities?.vision !== true) return [];
          return [{
            value: `${providerId}:${modelId}`,
            label: `${provider?.name ?? providerId} · ${model.name}`,
          }];
        });
      });
      setModelOptions(options);
      setSettings(settingsPayload?.settings ?? {});
    }).catch(() => setResult({ ok: false, message: "课程质量检验配置读取失败。" }))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const response = await fetch("/api/course-quality-review/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.settings) {
        throw new Error(typeof payload?.message === "string"
          ? payload.message
          : getReadableError(payload, "课程质量检验配置保存失败。"));
      }
      setSettings(payload.settings);
      setResult({
        ok: true,
        message: payload.settings.modelString
          ? "独立检验模型已保存；课程生成模型不会改变。"
          : "已关闭独立检验模型；质量核对将跟随每门课程锁定的生成模型。",
      });
    } catch (cause) {
      setResult({ ok: false, message: cause instanceof Error ? cause.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <EmptyPanel text="正在读取课程质量检验配置…" />;

  return (
    <section className="overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <div className="border-b border-stone-200 bg-stone-50/70 px-5 py-4">
        <h3 className="font-bold text-stone-950">生成模型与检验模型分离</h3>
        <p className="mt-1 text-xs leading-5 text-stone-500">
          课程大纲、PPT 页面、讲稿、动作与单次页面修复始终使用「AI 大模型」页选定的生成模型，不会因为页面含图片或需要视觉能力而自动换模。
        </p>
      </div>
      <div className="space-y-5 p-5">
        <div className="rounded-[8px] border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-xs font-semibold text-emerald-700">当前默认生成模型</p>
          <p className="mt-1 text-sm font-bold text-emerald-950">{generationModelLabel}</p>
          <p className="mt-1 text-xs leading-5 text-emerald-800">生成任务入队时会锁定该模型，任务执行期间修改默认设置也不会让同一门课程混用模型。</p>
        </div>
        <Field
          label="独立检验模型（可选）"
          helper="只显示已在 AI 大模型页配置、且模型目录明确标记支持视觉能力的模型。它仅用于生成完成后的质量核对，不参与课程创作。"
          icon={Eye}
        >
          <select
            className="h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm outline-none focus:border-[var(--pbl-teacher)]"
            value={settings.modelString ?? ""}
            onChange={(event) => setSettings({ modelString: event.target.value || undefined })}
          >
            <option value="">不单独配置（跟随本课程生成模型）</option>
            {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {modelOptions.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-amber-700">当前没有已配置且明确支持视觉能力的模型。可先到「AI 大模型」页启用此类模型；课程生成不会因此受阻。</p>
          ) : null}
        </Field>
        <div className="rounded-[8px] border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-5 text-stone-600">
          浏览器排版检查使用当前 OpenMAIC 渲染器测量溢出、裁切和遮挡，本身不调用第二个大模型。独立检验模型也不会反向改写页面。
        </div>
      </div>
      <div className="border-t border-stone-200 px-5 py-4">
        <PrimaryButton className="h-10" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
          保存检验设置
        </PrimaryButton>
        <ResultNotice result={result} />
      </div>
    </section>
  );
}

function formatConfiguredModel(modelString: string | undefined): string | null {
  if (!modelString) return null;
  const separator = modelString.indexOf(":");
  if (separator < 0) return modelString;
  const providerId = modelString.slice(0, separator);
  const modelId = modelString.slice(separator + 1);
  const provider = PROVIDERS[providerId as keyof typeof PROVIDERS];
  return `${provider?.name ?? providerId} · ${provider?.models.find((model) => model.id === modelId)?.name ?? modelId}`;
}

function getTtsProviderName(providerId: string): string {
  return (TTS_PROVIDERS as Record<string, { name: string }>)[providerId]?.name ?? providerId;
}

function getProviderOverview(
  tabKey: TabKey,
  savedConfigs: Record<string, SavedConfig>,
): { status: string; summary: string; configured: boolean } | null {
  const tab = TABS.find((item) => item.key === tabKey);
  if (!tab) return null;
  const providers = getProvidersForTab(tabKey);
  if (providers.length === 0) return null;
  const configured = providers.flatMap((provider) => {
    const saved = savedConfigs[configKey(tab.section, provider.id)];
    if (!saved?.hasApiKey && saved?.enabled === undefined) return [];
    const modelId = saved.defaultModel || saved.models?.[0] || provider.defaultModelId || provider.models[0]?.id;
    const modelName = provider.models.find((model) => model.id === modelId)?.name ?? modelId;
    const voice = tabKey === "tts" && saved.defaultVoice ? ` · ${saved.defaultVoice}` : "";
    return [`${provider.name}${modelName ? ` · ${modelName}` : ""}${voice}`];
  });
  return configured.length > 0
    ? { status: `${configured.length} 个连接`, summary: configured.join("；"), configured: true }
    : { status: "未配置", summary: "尚未保存可用的服务商连接", configured: false };
}

function AiServiceOverview({
  savedConfigs,
  loading,
  error,
  onOpen,
}: {
  savedConfigs: Record<string, SavedConfig>;
  loading: boolean;
  error?: string;
  onOpen: (tab: TabKey) => void;
}) {
  const { agentVoiceOverrides, ttsProviderId } = useSettingsStore();
  const [knowledgeSettings, setKnowledgeSettings] = useState<KnowledgeTutorSettings | null>(null);
  const [qualitySettings, setQualitySettings] = useState<QualityReviewSettings | null>(null);
  const [linkedSettingsLoading, setLinkedSettingsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/knowledge-lecture/settings", { cache: "no-store", signal: controller.signal }).then((response) => response.json()),
      fetch("/api/course-quality-review/settings", { cache: "no-store", signal: controller.signal }).then((response) => response.json()),
    ]).then(([knowledgePayload, qualityPayload]) => {
      if (controller.signal.aborted) return;
      setKnowledgeSettings(knowledgePayload?.settings ?? {});
      setQualitySettings(qualityPayload?.settings ?? {});
    }).catch(() => {
      if (!controller.signal.aborted) {
        setKnowledgeSettings({});
        setQualitySettings({});
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLinkedSettingsLoading(false);
    });
    return () => controller.abort();
  }, []);

  const voiceOverrideCount = Object.values(agentVoiceOverrides).filter((override) => override?.voiceId).length;
  const overviewItems = TABS.map((tab) => {
    const providerOverview = getProviderOverview(tab.key, savedConfigs);
    if (providerOverview) return { tab, ...providerOverview };
    if (tab.key === "agent-voice") {
      const providerName = getTtsProviderName(ttsProviderId);
      return {
        tab,
        configured: voiceOverrideCount > 0,
        status: voiceOverrideCount > 0 ? `${voiceOverrideCount} 个角色` : "跟随默认",
        summary: voiceOverrideCount > 0 ? `${providerName} · 已为部分智能体指定音色` : `${providerName} · 所有智能体使用默认音色`,
      };
    }
    if (tab.key === "knowledge-tutor") {
      const model = formatConfiguredModel(knowledgeSettings?.modelString);
      const voiceProvider = knowledgeSettings?.ttsProviderId
        ? getTtsProviderName(knowledgeSettings.ttsProviderId)
        : "浏览器默认语音";
      return {
        tab,
        configured: Boolean(knowledgeSettings?.modelString || knowledgeSettings?.ttsProviderId),
        status: linkedSettingsLoading ? "读取中" : model || knowledgeSettings?.ttsProviderId ? "已设置" : "跟随默认",
        summary: linkedSettingsLoading ? "正在读取知识讲授配置" : `${model ?? "系统默认模型"} · ${voiceProvider}`,
      };
    }
    const qualityModel = formatConfiguredModel(qualitySettings?.modelString);
    return {
      tab,
      configured: Boolean(qualityModel),
      status: linkedSettingsLoading ? "读取中" : qualityModel ? "独立模型" : "跟随课程",
      summary: linkedSettingsLoading ? "正在读取课程检验配置" : qualityModel ?? "使用每门课程锁定的生成模型",
    };
  });
  const overviewByKey = new Map(overviewItems.map((item) => [item.tab.key, item]));

  return <div className="min-w-0">
    <section aria-labelledby="ai-configuration-overview-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--pbl-border)] pb-3">
        <h3 id="ai-configuration-overview-heading" className="text-base font-semibold text-[var(--pbl-text-strong)]">配置概览</h3>
        <p className="text-xs text-[var(--pbl-text-muted)]">直接查看当前服务商、模型和默认策略</p>
      </div>
      <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
        {AI_SERVICE_GROUPS.map((group) => (
          <section key={group.key} className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[var(--pbl-border)] bg-white" aria-labelledby={`ai-service-group-${group.key}`}>
            <header className="min-h-[116px] border-b border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)]/45 px-4 py-3.5">
              <p className="text-[10px] font-semibold tracking-[.12em] text-[var(--pbl-teacher)]">{group.eyebrow}</p>
              <h4 id={`ai-service-group-${group.key}`} className="mt-1.5 text-base font-semibold text-[var(--pbl-text-strong)]">{group.title}</h4>
              <p className="mt-1.5 text-xs leading-5 text-[var(--pbl-text-muted)]">{group.description}</p>
            </header>
            <div className="divide-y divide-[var(--pbl-border)]">
              {group.tabs.map((tabKey) => {
                const item = overviewByKey.get(tabKey)!;
                const Icon = item.tab.icon;
                return <button key={tabKey} type="button" onClick={() => onOpen(tabKey)} className="group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--pbl-teacher-soft)]/30">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Icon size={16}/></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2"><strong className="truncate text-sm font-semibold text-[var(--pbl-text-strong)]">{item.tab.label}</strong><span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", item.configured ? "bg-emerald-50 text-emerald-700" : "bg-[var(--pbl-surface-soft)] text-[var(--pbl-text-muted)]")}>{loading && getProviderOverview(tabKey, savedConfigs) ? "读取中" : item.status}</span></span>
                    <small className="mt-1 block truncate text-[11px] text-[var(--pbl-text-muted)]" title={item.summary}>{item.summary}</small>
                  </span>
                  <ChevronRight className="shrink-0 text-[var(--pbl-border-strong)] group-hover:text-[var(--pbl-teacher)]" size={15}/>
                </button>;
              })}
            </div>
            <div className="mt-auto border-t border-[var(--pbl-border)] px-4 py-2">
              {group.links.map((link) => <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-[var(--pbl-teacher)]">{link.label}<ChevronRight size={14}/></Link>)}
            </div>
          </section>
        ))}
      </div>
    </section>
    {error ? <p role="alert" className="mt-4 rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-[var(--pbl-danger)]">{error}</p> : null}
  </div>;
}

function AiServiceDetailHeader({
  activeTab,
  onBack,
  onChange,
}: {
  activeTab: TabKey;
  onBack: () => void;
  onChange: (tab: TabKey) => void;
}) {
  const tab = TABS.find((item) => item.key === activeTab)!;
  const detail = AI_SERVICE_DETAILS[activeTab];
  const group = AI_SERVICE_GROUPS.find((item) => item.key === detail.group)!;
  const Icon = tab.icon;

  return <header className="pbl-settings-content-header min-w-0 border-b border-[var(--pbl-border)] pb-5" aria-labelledby="teacher-settings-section-heading">
    <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-4">
      <button type="button" aria-label="返回服务总览" onClick={onBack} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] px-2 text-sm font-semibold text-[var(--pbl-teacher)] hover:bg-[var(--pbl-teacher-soft)]"><ArrowLeft size={16}/><span className="hidden sm:inline">服务概览</span></button>
      <span aria-hidden="true" className="hidden h-11 w-px shrink-0 bg-[var(--pbl-border)] sm:block" />
      <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><Icon size={19}/></span>
      <div className="min-w-[220px] flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 id="teacher-settings-section-heading" className="text-xl font-semibold tracking-[-.02em] text-[var(--pbl-text-strong)]">{tab.label}</h2>
          <span className="text-[10px] font-semibold tracking-[.1em] text-[var(--pbl-teacher)]">{group.title}</span>
        </div>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--pbl-text-muted)]">{detail.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-[10px] font-medium text-[var(--pbl-text-subtle)]">关联功能</span>{detail.related.map((item) => <span key={item} className="text-[10px] font-medium text-[var(--pbl-text-muted)]">{item}</span>)}</div>
      </div>
      <label className="flex min-h-11 w-full shrink-0 items-center gap-2 text-xs font-medium text-[var(--pbl-text-muted)] sm:w-auto"><span className="shrink-0">当前能力</span><select aria-label="切换 AI 服务功能" value={activeTab} onChange={(event) => onChange(event.target.value as TabKey)} className="min-h-11 min-w-0 flex-1 rounded-[8px] border border-[var(--pbl-border)] bg-white px-3 text-sm font-semibold text-[var(--pbl-text-strong)] sm:w-[190px]">
        {AI_SERVICE_GROUPS.map((item) => <optgroup key={item.key} label={item.title}>{item.tabs.map((tabKey) => <option key={tabKey} value={tabKey}>{TABS.find((candidate) => candidate.key === tabKey)?.label}</option>)}</optgroup>)}
      </select></label>
    </div>
  </header>;
}

export default function TeacherSettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("account");
  const [aiServiceView, setAiServiceView] = useState<AiServiceView>("overview");
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
  const [editThinkingScenarioConfigs, setEditThinkingScenarioConfigs] =
    useState<LlmThinkingScenarioConfigs>({});
  const [editDefaultVoice, setEditDefaultVoice] = useState("");
  const [editTtsScenarioConfigs, setEditTtsScenarioConfigs] = useState<TtsScenarioConfigs>({});
  const [showApiKey, setShowApiKey] = useState(false);

  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [testingTtsScenario, setTestingTtsScenario] = useState<TtsScenarioId | null>(null);
  const [saveResult, setSaveResult] = useState<ResultState>(null);
  const [testResult, setTestResult] = useState<ResultState>(null);
  const [deletingProvider, setDeletingProvider] = useState<ProviderMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [restoringThinkingProviderId, setRestoringThinkingProviderId] = useState<string | null>(null);

  const currentTab = TABS.find((tab) => tab.key === activeTab)!;
  const currentSection = SETTINGS_SECTIONS.find((section) => section.key === activeSection)!;
  const CurrentSectionIcon = currentSection.icon;
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
      const defaultModel = getInitialDefaultModel(provider, saved);
      const defaultVoice = saved?.defaultVoice ||
        DEFAULT_TTS_VOICES[provider.id as keyof typeof DEFAULT_TTS_VOICES] ||
        "default";
      const scenarioConfigs = getInitialTtsScenarioConfigs(
        provider,
        saved,
        defaultModel,
        defaultVoice,
      );
      const realtimeConfig = scenarioConfigs["realtime-interaction"];
      setEditDefaultModel(realtimeConfig?.modelId || defaultModel);
      setEditThinkingScenarioConfigs(saved?.thinkingScenarioConfigs || {});
      setEditDefaultVoice(realtimeConfig?.voiceId || defaultVoice);
      setEditTtsScenarioConfigs(scenarioConfigs);
      setShowApiKey(false);
      setSaveResult(null);
      setTestResult(null);
    },
    [currentTab.section, getSavedConfig],
  );

  const fetchConfigs = useCallback(async (section: ProviderSection, showLoading = true) => {
    if (showLoading) setConfigLoading(true);
    try {
      const response = await fetch(`/api/openmaic/provider-config?section=${section}`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      const providersData =
        (data?.providers as Record<string, SavedConfig> | undefined) ??
        (data?.data?.providers as Record<string, SavedConfig> | undefined);

      if (!response.ok || !providersData) throw new Error(getReadableError(data, "读取已保存配置失败，请重试。"));
      if (providersData) {
        setSavedConfigs((current) => {
          const retained = Object.fromEntries(
            Object.entries(current).filter(([key]) => !key.startsWith(`${section}:`)),
          );
          return {
            ...retained,
            ...Object.fromEntries(
            Object.entries(providersData).map(([providerId, value]) => [
              configKey(section, providerId),
              value,
            ]),
          ),
          };
        });
      }
    } finally {
      if (showLoading) setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSection !== "ai") return;
    const sections = Array.from(new Set(
      TABS.filter((tab) => getProvidersForTab(tab.key).length > 0).map((tab) => tab.section),
    ));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfigLoading(true);
    void Promise.all(sections.map((section) => fetchConfigs(section, false)))
      .catch((error: Error) => setSaveResult({ ok: false, message: error.message }))
      .finally(() => setConfigLoading(false));
  }, [activeSection, fetchConfigs]);

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

  useEffect(() => {
    if (
      activeTab === "llm" ||
      activeTab === "agent-voice" ||
      activeTab === "knowledge-tutor" ||
      activeTab === "quality-review" ||
      expandedId ||
      configLoading ||
      providers.length === 0
    ) return;

    const configured = providers
      .filter((provider) => {
        const saved = getSavedConfig(currentTab.section, provider.id);
        return saved?.hasApiKey || saved?.enabled !== undefined;
      })
      .sort((left, right) => {
        const leftPriority = getSavedConfig(currentTab.section, left.id)?.priority;
        const rightPriority = getSavedConfig(currentTab.section, right.id)?.priority;
        return (leftPriority ?? Number.MAX_SAFE_INTEGER) -
          (rightPriority ?? Number.MAX_SAFE_INTEGER);
      });
    const initialProvider = configured[0] ?? providers[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize the editor after its server config has loaded.
    setExpandedId(initialProvider.id);
    fillForm(initialProvider);
  }, [
    activeTab,
    configLoading,
    currentTab.section,
    expandedId,
    fillForm,
    getSavedConfig,
    providers,
  ]);

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

  function handleTtsScenarioConfigChange(
    scenario: TtsScenarioId,
    config: TtsScenarioConfig,
  ) {
    setEditTtsScenarioConfigs((current) => ({ ...current, [scenario]: config }));
    if (scenario === "realtime-interaction") {
      setEditDefaultModel(config.modelId);
      setEditDefaultVoice(config.voiceId);
    }
  }

  async function handleSave(provider: ProviderMeta, makeDefault = true) {
    const saved = getSavedConfig(currentTab.section, provider.id);
    const modelIds = splitModelIds(editModels);
    const realtimeTtsConfig = editTtsScenarioConfigs["realtime-interaction"];

    if (provider.requiresApiKey && !saved?.hasApiKey && !editApiKey.trim()) {
      setSaveResult({ ok: false, message: "请先填写密钥。" });
      return false;
    }

    if ((activeTab === "llm" || activeTab === "embedding") && modelIds.length === 0) {
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
          defaultModel: activeTab === "tts"
            ? realtimeTtsConfig?.modelId || editDefaultModel || modelIds[0] || undefined
            : editDefaultModel || modelIds[0] || undefined,
          ...(activeTab === "embedding" ? { dimensions: 1024 } : {}),
          ...(activeTab === "llm" ? {
            thinkingScenarioConfigs: editThinkingScenarioConfigs,
          } : {}),
          ...(activeTab === "tts" ? {
            defaultVoice: realtimeTtsConfig?.voiceId || editDefaultVoice || "default",
            scenarioConfigs: editTtsScenarioConfigs,
          } : {}),
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
                  ...(activeTab === "embedding" ? { dimensions: 1024 } : {}),
                  ...(activeTab === "tts"
                    ? {
                        defaultVoice: otherSaved?.defaultVoice,
                        scenarioConfigs: otherSaved?.scenarioConfigs,
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

  function handleThinkingScenarioChange(
    scenario: LlmThinkingScenarioId,
    preset: ThinkingScenarioPreset,
  ) {
    setEditThinkingScenarioConfigs((current) => {
      const next = { ...current };
      if (preset === "baseline") delete next[scenario];
      else next[scenario] = preset;
      return next;
    });
    setSaveResult(null);
  }

  async function handleRestoreThinkingBaseline(provider: ProviderMeta) {
    setEditThinkingScenarioConfigs({});
    const saved = getSavedConfig("providers", provider.id);
    if (!saved?.hasApiKey && saved?.enabled === undefined) {
      setSaveResult({ ok: true, message: "已恢复 baseline；该服务尚未保存，无需同步。" });
      return;
    }

    setRestoringThinkingProviderId(provider.id);
    setSaveResult(null);
    try {
      const response = await fetch("/api/openmaic/provider-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "providers",
          providerId: provider.id,
          apiKey: "",
          thinkingScenarioConfigs: {},
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.success === false) {
        throw new Error(getReadableError(data, "恢复 baseline 失败。"));
      }
      setSavedConfigs((current) => ({
        ...current,
        [configKey("providers", provider.id)]: data.provider,
      }));
      setSaveResult({ ok: true, message: "所有应用场景已恢复 baseline，并立即生效。" });
    } catch (error) {
      setSaveResult({
        ok: false,
        message: error instanceof Error ? error.message : "恢复 baseline 失败，请稍后重试。",
      });
    } finally {
      setRestoringThinkingProviderId(null);
    }
  }

  async function handleTestConnection(
    provider: ProviderMeta,
    ttsScenario: TtsScenarioId = "realtime-interaction",
    calibrateTts = false,
  ) {
    const saved = getSavedConfig(currentTab.section, provider.id);
    const realtimeTtsConfig = editTtsScenarioConfigs["realtime-interaction"];
    const selectedTtsConfig = editTtsScenarioConfigs[ttsScenario];
    const modelId = activeTab === "tts"
      ? selectedTtsConfig?.modelId || editDefaultModel || splitModelIds(editModels)[0] || ""
      : editDefaultModel || splitModelIds(editModels)[0] || "";

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

      const voice = selectedTtsConfig?.voiceId || editDefaultVoice ||
        DEFAULT_TTS_VOICES[provider.id as keyof typeof DEFAULT_TTS_VOICES] || "default";
      setTestingProviderId(provider.id);
      setTestingTtsScenario(ttsScenario);
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
            defaultModel: realtimeTtsConfig?.modelId || editDefaultModel || modelId || undefined,
            defaultVoice: realtimeTtsConfig?.voiceId || editDefaultVoice || voice,
            scenarioConfigs: editTtsScenarioConfigs,
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
            audioId: `settings_test_${provider.id}_${ttsScenario}`,
            ttsProviderId: provider.id,
            ttsScenario,
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

        const shouldCalibrate = calibrateTts && ttsScenario === "course-generation";
        let measuredDurationSec: number | undefined;
        let calibration: TtsVoiceTimingCalibration | undefined;
        if (shouldCalibrate) {
          measuredDurationSec = await measureBase64AudioDuration(audioBase64, format);
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
            throw new Error(getReadableError(calibrationData, "音频生成成功，但课程语速建模保存失败。"));
          }
          calibration = calibrationData?.calibration ?? calibrationData?.data?.calibration;
        }
        const audioUrl = `data:audio/${format};base64,${audioBase64}`;
        const audio = new Audio(audioUrl);
        void audio.play().catch(() => undefined);
        setTestResult({
          ok: true,
          message: shouldCalibrate
            ? "课程生成试听成功，已完成该模型与音色的自然语速建模。"
            : "实时交互试听成功。",
          detail: shouldCalibrate && measuredDurationSec
            ? `模型：${modelId || "默认"}；音色：${voice}；实测 ${measuredDurationSec.toFixed(2)} 秒；共享平均约 ${Number(calibration?.cjkCharsPerMinute ?? 0).toFixed(1)} 字/分钟（${calibration?.sampleCount ?? 1} 次样本）`
            : `模型：${modelId || "默认"}；音色：${voice}`,
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
        setTestingTtsScenario(null);
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
      || activeTab === "pdf"
      || activeTab === "embedding";
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

  const selectedLlmProvider = providers.find((provider) => provider.id === selectedLlmId) ?? null;
  const selectedModalityProvider = providers.find((provider) => provider.id === expandedId) ?? null;
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
    setSelectedLlmId(null);
    setExpandedId(null);
  }

  function openAiService(tab: TabKey) {
    handleTabChange(tab);
    setAiServiceView("detail");
  }

  return (
    <TeacherPlatformPage><TeacherPlatformHeader active="settings" backHref="/teacher/classes" backLabel="返回教学班" /><div className="pbl-workspace-content pbl-settings-layout">
      <header className="pbl-settings-masthead flex min-w-0 flex-wrap items-center justify-between gap-4 border-b border-[var(--pbl-border)] pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-[-.035em] text-[var(--pbl-text-strong)]">个人中心</h1>
            <span className="text-[11px] font-semibold tracking-[.12em] text-[var(--pbl-teacher)]">教师账号</span>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-[var(--pbl-text-muted)]">管理账号、教学偏好与 AI 教学服务</p>
        </div>
        <nav className="pbl-settings-section-nav flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-[10px] bg-[var(--pbl-surface-soft)] p-1" aria-label="个人中心设置分类">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = section.key === activeSection;
            return <button
              key={section.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                setActiveSection(section.key);
                if (section.key === "ai") setAiServiceView("overview");
              }}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-[8px] px-3.5 text-sm font-semibold transition",
                active
                  ? "bg-white text-[var(--pbl-teacher)] shadow-[0_1px_3px_rgba(41,57,79,0.08)]"
                  : "text-[var(--pbl-text-muted)] hover:bg-white/60 hover:text-[var(--pbl-text-strong)]",
              )}
            >
              <Icon size={16}/>
              {section.label}
            </button>;
          })}
        </nav>
      </header>

      <section className="pbl-settings-main min-w-0 pt-5" aria-labelledby="teacher-settings-section-heading">
          {activeSection === "ai" && aiServiceView === "detail" ? (
            <AiServiceDetailHeader activeTab={activeTab} onBack={() => setAiServiceView("overview")} onChange={handleTabChange}/>
          ) : (
            <header className="pbl-settings-content-header mb-5 flex min-w-0 items-start gap-3 border-b border-[var(--pbl-border)] pb-5">
              <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"><CurrentSectionIcon size={19}/></span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 id="teacher-settings-section-heading" className="text-xl font-semibold tracking-[-.02em] text-[var(--pbl-text-strong)]">{currentSection.title}</h2>
                  <span className="text-[10px] font-semibold tracking-[.12em] text-[var(--pbl-teacher)]">{currentSection.eyebrow}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--pbl-text-muted)]">{currentSection.intro}</p>
              </div>
            </header>
          )}

          {activeSection === "account" ? <TeacherProfilePanel/> : null}
          {activeSection === "teaching" ? <SurveyKeywordSettings/> : null}
          {activeSection === "ai" ? <ThemeProvider>
        <I18nProvider>
          <ServerProvidersInit />
          {aiServiceView === "overview" ? <AiServiceOverview savedConfigs={savedConfigs} loading={configLoading} error={saveResult && !saveResult.ok ? saveResult.message : undefined} onOpen={openAiService}/> : <>
          <div className="pbl-settings-workbench min-w-0 rounded-[14px] border border-stone-200 bg-white">
            <section className="min-w-0">
              <div className="min-w-0">
                {configLoading ? (
                  <div className="m-4 inline-flex items-center gap-2 rounded-[6px] bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-500">
                    <Loader2 size={16} className="animate-spin" />
                    正在读取服务端配置
                  </div>
                ) : null}

              {activeTab === "quality-review" ? (
                <div className="p-4 sm:p-6"><QualityReviewConfig /></div>
              ) : activeTab === "knowledge-tutor" ? (
                <div className="p-4 sm:p-6"><KnowledgeTutorConfig /></div>
              ) : activeTab === "agent-voice" ? (
                <div className="p-4 sm:p-6"><AgentVoiceConfig /></div>
              ) : activeTab === "llm" ? (
                <div className="grid min-w-0 items-start xl:grid-cols-[248px_minmax(0,1fr)]">
                  <ProviderList
                    providers={filteredProviders}
                    totalCount={providers.length}
                    configuredCount={configuredProvidersCount}
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
                        editThinkingScenarioConfigs={editThinkingScenarioConfigs}
                        showApiKey={showApiKey}
                        saving={savingProviderId === selectedLlmProvider.id}
                        restoringThinking={restoringThinkingProviderId === selectedLlmProvider.id}
                        testing={testingProviderId === selectedLlmProvider.id}
                        saveResult={saveResult}
                        testResult={testResult}
                        onApiKeyChange={setEditApiKey}
                        onBaseUrlChange={setEditBaseUrl}
                        onModelsChange={handleModelTextChange}
                        onDefaultModelChange={setEditDefaultModel}
                        onThinkingScenarioChange={handleThinkingScenarioChange}
                        onRestoreThinkingBaseline={() => handleRestoreThinkingBaseline(selectedLlmProvider)}
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
                <div className="grid min-w-0 items-start xl:grid-cols-[248px_minmax(0,1fr)]">
                  <ProviderList
                    providers={filteredProviders}
                    totalCount={providers.length}
                    configuredCount={configuredProvidersCount}
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
                        editTtsScenarioConfigs={editTtsScenarioConfigs}
                        showApiKey={showApiKey}
                        saving={savingProviderId === selectedModalityProvider.id}
                        testing={testingProviderId === selectedModalityProvider.id}
                        testingTtsScenario={testingProviderId === selectedModalityProvider.id ? testingTtsScenario : null}
                        saveResult={saveResult}
                        testResult={testResult}
                        onApiKeyChange={setEditApiKey}
                        onBaseUrlChange={setEditBaseUrl}
                        onModelsChange={setEditModels}
                        onDefaultModelChange={setEditDefaultModel}
                        onDefaultVoiceChange={setEditDefaultVoice}
                        onTtsScenarioConfigChange={handleTtsScenarioConfigChange}
                        onShowApiKeyChange={setShowApiKey}
                        onSave={() => handleSave(selectedModalityProvider)}
                        onTest={() => handleTestConnection(selectedModalityProvider)}
                        onTestTtsScenario={activeTab === "tts"
                          ? (scenario) => handleTestConnection(
                              selectedModalityProvider,
                              scenario,
                              scenario === "course-generation",
                            )
                          : undefined}
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
          </>}
        </I18nProvider>
      </ThemeProvider> : null}
      </section>

      {/* 删除确认对话框 */}
      {activeSection === "ai" && deletingProvider ? (
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
    <section className="pbl-settings-editor min-w-0 bg-white">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo icon={provider.icon} name={provider.name} />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-stone-950" title={`${provider.name} 配置`}>
              {provider.name} 配置
            </h3>
            <p className="mt-1 truncate text-xs text-stone-500" title={provider.id}>服务标识 · {provider.id}</p>
          </div>
        </div>
        <div className="flex min-w-0 shrink items-center justify-end gap-1.5">
          <div className="min-w-0 max-w-[220px]">
            <ProviderStateBadge provider={provider} saved={saved} />
          </div>
          {hasSavedConfig ? (
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-[8px] text-stone-400 transition hover:bg-[var(--pbl-danger-soft)] hover:text-[var(--pbl-danger)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-danger)]"
              aria-label={`删除 ${provider.name} 配置`}
              title="删除配置"
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="px-4 sm:px-6">{children}</div>
    </section>
  );
}

function ProviderList({
  providers,
  totalCount,
  configuredCount,
  selectedId,
  section,
  savedConfigs,
  query,
  onQueryChange,
  onSelect,
}: {
  providers: ProviderMeta[];
  totalCount: number;
  configuredCount: number;
  selectedId: string | null;
  section: ProviderSection;
  savedConfigs: Record<string, SavedConfig>;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (provider: ProviderMeta) => void;
}) {
  return (
    <aside className="pbl-settings-provider-list min-w-0 border-b border-stone-200 bg-stone-50/55 p-3 xl:sticky xl:top-20 xl:border-b-0 xl:border-r">
      <div>
        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <div>
            <p className="text-[10px] font-semibold tracking-widest text-[var(--pbl-teacher)]">服务商</p>
            <h3 className="mt-0.5 text-sm font-semibold text-stone-800">选择接入服务</h3>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-stone-500">
            {configuredCount}/{totalCount} 已接入
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

      <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1 xl:max-h-[calc(100vh-246px)] xl:flex-col xl:overflow-y-auto xl:pr-1">
        {providers.length === 0 ? (
          <div className="grid min-h-28 place-items-center px-4 text-center text-sm text-stone-500">
            没有匹配的服务商
          </div>
        ) : (
          <div className="contents">
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
                    "group relative flex min-h-[62px] w-[218px] min-w-[218px] items-center gap-3 overflow-hidden rounded-[8px] border px-2.5 py-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--pbl-teacher)] xl:w-full xl:min-w-0",
                    selected
                      ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]"
                      : "border-transparent bg-white/70 hover:border-stone-200 hover:bg-white",
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

function ConfigSection({
  index,
  title,
  description,
  children,
}: {
  index: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-stone-200 py-6 first:border-t-0">
      <header className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-[var(--pbl-teacher-soft)] text-[10px] font-bold text-[var(--pbl-teacher)]">
          {index}
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-stone-900">{title}</h4>
          <p className="mt-1 text-xs leading-5 text-stone-500">{description}</p>
        </div>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function LlmConfigForm({
  provider,
  saved,
  editApiKey,
  editBaseUrl,
  editModels,
  editDefaultModel,
  editThinkingScenarioConfigs,
  showApiKey,
  saving,
  restoringThinking,
  testing,
  saveResult,
  testResult,
  onApiKeyChange,
  onBaseUrlChange,
  onModelsChange,
  onDefaultModelChange,
  onThinkingScenarioChange,
  onRestoreThinkingBaseline,
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
  editThinkingScenarioConfigs: LlmThinkingScenarioConfigs;
  showApiKey: boolean;
  saving: boolean;
  restoringThinking: boolean;
  testing: boolean;
  saveResult: ResultState;
  testResult: ResultState;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onThinkingScenarioChange: (
    scenario: LlmThinkingScenarioId,
    preset: ThinkingScenarioPreset,
  ) => void;
  onRestoreThinkingBaseline: () => void;
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
    <div>
      <ConfigSection
        index="01"
        title="连接认证"
        description="确认接入协议，填写密钥和服务地址。已保存的密钥不会在页面中回显。"
      >
        <div
          className={cn(
            "mb-5 grid gap-3 rounded-[8px] px-4 py-3 text-sm sm:grid-cols-2",
            connection.tone === "success" && "bg-emerald-50 text-emerald-800",
            connection.tone === "warning" && "bg-amber-50 text-amber-900",
            connection.tone === "info" && "bg-blue-50 text-blue-800",
          )}
        >
          <div>
            <span className="block text-[10px] font-semibold uppercase tracking-wider opacity-70">接入方式</span>
            <strong className="mt-0.5 block font-semibold">{connection.label}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase tracking-wider opacity-70">接口协议</span>
            <strong className="mt-0.5 block font-semibold">{connection.protocol}</strong>
          </div>
          <p className="leading-5 opacity-90 sm:col-span-2">{connection.credentialHint}</p>
        </div>

        <div className="grid items-start gap-5 md:grid-cols-2">
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
                className="mt-2 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-[var(--pbl-teacher)]"
              >
                <RefreshCw size={13} />
                {provider.id === "deepseek" ? "切换到 DeepSeek 官方地址" : "恢复官方默认地址"}
              </button>
            ) : null}
            <span className="mt-1 block break-all text-xs leading-5 text-stone-500">
              调用目标：{getProviderRequestPreview(provider, editBaseUrl)}
            </span>
          </Field>
        </div>
      </ConfigSection>

      <ConfigSection
        index="02"
        title="模型配置"
        description="维护该服务可调用的模型，并明确课程生成和连接测试使用的默认模型。"
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Field label="模型列表" helper="每行一个模型 ID。" icon={Bot}>
            <TextArea
              value={editModels}
              onChange={(event) => onModelsChange(event.target.value)}
              rows={Math.max(4, Math.min(modelIds.length, 7))}
              placeholder="deepseek-v4-flash&#10;deepseek-v4-pro"
            />
          </Field>

          {modelIds.length > 0 ? (
            <Field
              label="默认模型"
              helper={`连接测试将使用 ${qualifyModelForProvider(testModel, provider.id)}`}
              icon={CircleDot}
            >
              <div className="grid max-h-[256px] gap-2 overflow-y-auto pr-1">
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
                        <span className="block truncate font-semibold" title={modelMeta?.name || modelId}>{modelMeta?.name || modelId}</span>
                        {modelMeta ? <span className="block truncate text-xs opacity-75">{modelId}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>
          ) : (
            <div className="grid min-h-32 place-items-center rounded-[8px] border border-dashed border-stone-300 px-5 text-center text-xs leading-5 text-stone-500">
              添加模型 ID 后，可在这里选择默认模型。
            </div>
          )}
        </div>
      </ConfigSection>

      <ThinkingScenarioPanel
        providerId={provider.id}
        modelId={testModel}
        configs={editThinkingScenarioConfigs}
        restoring={restoringThinking}
        onChange={onThinkingScenarioChange}
        onRestore={onRestoreThinkingBaseline}
      />

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
  editTtsScenarioConfigs,
  showApiKey,
  saving,
  testing,
  testingTtsScenario,
  saveResult,
  testResult,
  onApiKeyChange,
  onBaseUrlChange,
  onModelsChange,
  onDefaultModelChange,
  onDefaultVoiceChange,
  onTtsScenarioConfigChange,
  onShowApiKeyChange,
  onSave,
  onTest,
  onTestTtsScenario,
}: {
  provider: ProviderMeta;
  saved?: SavedConfig;
  editApiKey: string;
  editBaseUrl: string;
  editModels: string;
  editDefaultModel: string;
  editDefaultVoice: string;
  editTtsScenarioConfigs: TtsScenarioConfigs;
  showApiKey: boolean;
  saving: boolean;
  testing: boolean;
  testingTtsScenario: TtsScenarioId | null;
  saveResult: ResultState;
  testResult: ResultState;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onDefaultVoiceChange: (value: string) => void;
  onTtsScenarioConfigChange: (scenario: TtsScenarioId, config: TtsScenarioConfig) => void;
  onShowApiKeyChange: (value: boolean) => void;
  onSave: () => void;
  onTest: () => void;
  onTestTtsScenario?: (scenario: TtsScenarioId) => void;
}) {
  const modelIds = splitModelIds(editModels);
  const providerModelMap = new Map(provider.models.map((model) => [model.id, model]));
  const availableModels = [...new Set([
    ...provider.models.map((model) => model.id),
    ...modelIds,
  ])].map((id) => providerModelMap.get(id) ?? { id, name: id });
  const isTts = Boolean(onTestTtsScenario);

  return (
    <div>
      <ConfigSection
        index="01"
        title="连接认证"
        description="配置服务凭据和调用地址，保存后可直接验证服务是否可用。"
      >
      <div className="grid items-start gap-5 md:grid-cols-2">
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
      </ConfigSection>

      {isTts && availableModels.length > 0 ? (
        <ConfigSection
          index="02"
          title="分场景模型与音色"
          description="课程生成使用质量档；AI 讨论、习题讲解和助教朗读统一使用实时档。"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {TTS_SCENARIOS.map((scenario) => {
              const fallbackModel = editDefaultModel || availableModels[0]?.id || "";
              const fallbackVoice = editDefaultVoice || "default";
              const config = editTtsScenarioConfigs[scenario.id] ?? {
                modelId: fallbackModel,
                voiceId: fallbackVoice,
              };
              const voices = getTTSVoices(
                provider.id as keyof typeof TTS_PROVIDERS,
              ).filter((voice) =>
                !voice.compatibleModels || voice.compatibleModels.includes(config.modelId)
              );
              const voiceLabel = voices.find((voice) => voice.id === config.voiceId)?.name
                ?? config.voiceId;
              const scenarioCalibration = scenario.id === "course-generation"
                ? saved?.timingCalibrations?.find(
                    (item) => item.modelId === config.modelId
                      && item.voiceId === config.voiceId
                      && (item.language || "zh-CN").toLowerCase() === "zh-cn"
                      && (item.speed ?? 1) === 1,
                  )
                : undefined;
              const isTestingScenario = testingTtsScenario === scenario.id;
              return (
                <div key={scenario.id} className="rounded-[8px] border border-stone-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-stone-900">{scenario.label}</p>
                      <p className="mt-1 text-xs leading-5 text-stone-500">{scenario.description}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-[var(--pbl-teacher-soft)] px-2 py-1 text-[10px] font-bold text-[var(--pbl-teacher)]">
                      {scenario.badge}
                    </span>
                  </div>
                  <label className="mt-3 block text-xs font-semibold text-stone-600">
                    模型
                    <select
                      className="mt-1.5 h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none focus:border-[var(--pbl-teacher)]"
                      value={config.modelId}
                      onChange={(event) => {
                        const modelId = event.target.value;
                        const compatibleVoices = getTTSVoices(
                          provider.id as keyof typeof TTS_PROVIDERS,
                        ).filter((voice) =>
                          !voice.compatibleModels || voice.compatibleModels.includes(modelId)
                        );
                        const voiceId = compatibleVoices.some((voice) => voice.id === config.voiceId)
                          ? config.voiceId
                          : compatibleVoices[0]?.id || config.voiceId || "default";
                        onTtsScenarioConfigChange(scenario.id, { modelId, voiceId });
                      }}
                    >
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-3 block text-xs font-semibold text-stone-600">
                    音色
                    <select
                      className="mt-1.5 h-10 w-full rounded-[8px] border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none focus:border-[var(--pbl-teacher)]"
                      value={config.voiceId}
                      onChange={(event) => onTtsScenarioConfigChange(scenario.id, {
                        ...config,
                        voiceId: event.target.value,
                      })}
                    >
                      {voices.length > 0 ? voices.map((voice) => (
                        <option key={voice.id} value={voice.id}>{voice.name}</option>
                      )) : <option value={config.voiceId}>{voiceLabel || "默认音色"}</option>}
                    </select>
                  </label>
                  {scenario.id === "course-generation" ? (
                    scenarioCalibration ? (
                      <div className="mt-3 rounded-[8px] border border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] px-3 py-2 text-xs text-[var(--pbl-success)]">
                        已建模：约 {scenarioCalibration.cjkCharsPerMinute.toFixed(1)} 字/分钟，累计 {scenarioCalibration.sampleCount ?? 1} 次测试
                      </div>
                    ) : (
                      <div className="mt-3 text-xs leading-5 text-[var(--pbl-warning)]">
                        该课程生成模型与音色尚未建模，生成时将暂用内置保守语速。
                      </div>
                    )
                  ) : (
                    <div className="mt-3 text-xs leading-5 text-stone-500">
                      实时档只进行声音试听，不写入课程时长估算基准。
                    </div>
                  )}
                  <PrimaryButton
                    variant="outline"
                    onClick={() => onTestTtsScenario?.(scenario.id)}
                    disabled={saving || testing}
                    className="mt-3 h-10 w-full justify-center text-sm"
                  >
                    {isTestingScenario ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : scenario.id === "course-generation" ? (
                      <SlidersHorizontal size={15} />
                    ) : (
                      <Volume2 size={15} />
                    )}
                    {isTestingScenario
                      ? "正在生成试听"
                      : scenario.id === "course-generation"
                        ? "试听并进行语速建模"
                        : "试听实时交互音色"}
                  </PrimaryButton>
                </div>
              );
            })}
          </div>
        </ConfigSection>
      ) : null}

      {!isTts && availableModels.length > 0 ? (
        <ConfigSection
          index="02"
          title="默认模型"
          description="从内置目录和服务器已保存模型中，选择该能力默认使用的模型。"
        >
          <Field label={`模型（${availableModels.length}）`} helper="列表同时显示内置目录与服务器已保存模型；选择后保存为默认模型。" icon={Bot}>
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
                      const compatibleVoices = getTTSVoices(
                        provider.id as keyof typeof TTS_PROVIDERS,
                      ).filter((voice) =>
                        !voice.compatibleModels || voice.compatibleModels.includes(m.id)
                      );
                      if (
                        compatibleVoices.length > 0 &&
                        !compatibleVoices.some((voice) => voice.id === editDefaultVoice)
                      ) {
                        onDefaultVoiceChange(compatibleVoices[0].id);
                      }
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
                    <span className="min-w-0 overflow-hidden">
                      <span className="block truncate" title={m.name || m.id}>{m.name || m.id}</span>
                      {m.name !== m.id ? <span className="block truncate text-[10px] opacity-70">{m.id}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
        </ConfigSection>
        ) : null}

      <ActionRow
        saving={saving}
        testing={testing}
        saveResult={saveResult}
        testResult={testResult}
        onSave={onSave}
        onTest={isTts ? undefined : onTest}
      />

      {testResult?.audioUrl ? (
        <audio className="mb-5 w-full" controls preload="metadata" src={testResult.audioUrl} />
      ) : null}
      {testResult?.previewUrl ? (
        <Image
          alt="图像模型测试结果"
          className="mb-5 h-auto max-h-72 w-full rounded-[8px] border border-stone-200 object-contain"
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
  saveResult,
  testResult,
  onSave,
  onTest,
}: {
  saving: boolean;
  testing: boolean;
  saveResult: ResultState;
  testResult: ResultState;
  onSave: () => void;
  onTest?: () => void;
}) {
  return (
    <>
      {saveResult || testResult ? (
        <div className="space-y-2 pb-4">
          <ResultNotice result={saveResult} />
          <ResultNotice result={testResult} />
        </div>
      ) : null}
      <div className="pbl-ai-action-row sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 bg-white/95 px-4 py-3 shadow-[0_-10px_24px_rgba(41,57,79,0.07)] backdrop-blur sm:-mx-6 sm:px-6">
        <p className="pbl-ai-action-hint text-xs leading-5 text-stone-500">修改仅在保存后生效，可保存并立即验证连接。</p>
        <div className="ml-auto flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
          {onTest ? (
            <PrimaryButton
              variant="outline"
              onClick={onTest}
              disabled={saving || testing}
              aria-label={testing ? "正在测试" : "保存并测试连接"}
              className="h-11 flex-1 px-4 text-sm sm:flex-none"
            >
              {testing ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
              {testing ? "正在测试" : <><span className="hidden sm:inline">保存并</span>测试连接</>}
            </PrimaryButton>
          ) : null}
          <PrimaryButton onClick={onSave} disabled={saving || testing} className="h-11 flex-1 px-4 text-sm sm:flex-none">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            保存配置
          </PrimaryButton>
        </div>
      </div>
    </>
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

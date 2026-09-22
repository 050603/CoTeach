import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiProviderSettings, PublicAiProviderSettings } from "@/lib/session/types";

const DATA_DIR = path.join(process.cwd(), ".openpbl-data");
const SETTINGS_FILE = path.join(DATA_DIR, "ai-settings.json");

// Transport configuration is server-owned and never persisted by the legacy UI.
type ActiveAiSettings = AiProviderSettings & { proxy?: string };

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export function settingsFromEnv(): AiProviderSettings {
  return {
    endpoint: process.env.OPENPBL_LLM_ENDPOINT ?? "",
    model: process.env.OPENPBL_LLM_MODEL ?? "",
    apiKey: process.env.OPENPBL_LLM_API_KEY ?? "",
  };
}

export async function readAiSettings(): Promise<AiProviderSettings> {
  await ensureDataDir();
  const envSettings = settingsFromEnv();
  try {
    const raw = await readFile(SETTINGS_FILE, "utf8");
    const saved = JSON.parse(raw) as AiProviderSettings;
    return {
      endpoint: saved.endpoint || envSettings.endpoint,
      model: saved.model || envSettings.model,
      apiKey: saved.apiKey || envSettings.apiKey,
      updatedAt: saved.updatedAt,
    };
  } catch {
    return envSettings;
  }
}

export async function saveAiSettings(input: AiProviderSettings): Promise<AiProviderSettings> {
  await ensureDataDir();
  const current = await readAiSettings();
  const next: AiProviderSettings = {
    endpoint: input.endpoint.trim(),
    model: input.model.trim(),
    apiKey: input.apiKey === undefined ? current.apiKey : input.apiKey.trim(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function toPublicAiSettings(settings: AiProviderSettings): PublicAiProviderSettings {
  return {
    endpoint: settings.endpoint,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKey),
    updatedAt: settings.updatedAt,
  };
}

/**
 * 从 server-providers.yml 中查找第一个已配置 API Key 的 LLM provider，
 * 映射为 legacy AiProviderSettings 格式。
 *
 * 这是 legacy LLM 客户端（/api/llm 路由）与 OpenMAIC 设置页
 * （/api/openmaic/provider-config 路由）之间的桥接层：当教师已在
 * 设置页配置 provider 但未通过 legacy 路径保存 ai-settings.json 时，
 * 由此桥接层让 legacy 路径也能读到设置页的配置。
 */
async function readSettingsFromServerProviders(): Promise<ActiveAiSettings | null> {
  try {
    const { listProviders } = await import("@/lib/openmaic-bridge/provider-config-editor");
    const { PROVIDERS } = await import("@openmaic/lib/ai/providers");
    const { resolveProxy } = await import("@openmaic/lib/server/provider-config");
    const providers = await listProviders("providers");
    for (const [providerId, entry] of Object.entries(providers)) {
      if (entry.enabled === false) continue;
      if (!entry.apiKey) continue;
      // 优先使用 defaultModel，否则取 server-providers.yml 中 models 列表第一个，
      // 最后回退到 PROVIDERS 常量中的第一个模型（确保总有可用模型）
      const providerConfig = (PROVIDERS as Record<string, { models?: { id: string }[]; defaultBaseUrl?: string }>)?.[providerId];
      const model =
        entry.defaultModel ??
        entry.models?.[0] ??
        providerConfig?.models?.[0]?.id;
      if (!model) continue;
      // baseUrl 优先级：server-providers.yml > PROVIDERS 常量 > 硬编码兜底
      const baseUrl =
        entry.baseUrl ??
        providerConfig?.defaultBaseUrl ??
        defaultBaseUrlForProvider(providerId);
      if (!baseUrl) continue;
      return {
        endpoint: baseUrl,
        model,
        apiKey: entry.apiKey,
        proxy: resolveProxy(providerId),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Legacy LLM 客户端使用 OpenAI 兼容格式（/chat/completions），
// 这里只提供已知支持 OpenAI 兼容接口的 provider 的默认 baseUrl。
function defaultBaseUrlForProvider(providerId: string): string | undefined {
  const map: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    glm: "https://open.bigmodel.cn/api/paas/v4",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    kimi: "https://api.moonshot.cn/v1",
    minimax: "https://api.minimax.chat/v1",
    doubao: "https://ark.cn-beijing.volces.com/api/v3",
    siliconflow: "https://api.siliconflow.cn/v1",
    openrouter: "https://openrouter.ai/api/v1",
    grok: "https://api.x.ai/v1",
  };
  return map[providerId];
}

export async function getActiveAiSettings(): Promise<ActiveAiSettings> {
  // 优先级：legacy ai-settings.json > OPENPBL_LLM_* env > server-providers.yml（设置页配置）
  const legacy = await readAiSettings();
  if (legacy.endpoint && legacy.apiKey) {
    return legacy;
  }
  // Legacy 配置缺失时，回退到设置页配置（server-providers.yml）
  const fromServer = await readSettingsFromServerProviders();
  if (fromServer) {
    return fromServer;
  }
  // 都没有时返回 legacy（可能含空字段，调用方据此判定未配置）
  return legacy;
}

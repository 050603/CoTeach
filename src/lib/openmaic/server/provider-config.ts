/**
 * Server-side Provider Configuration
 *
 * Loads provider configs from YAML (primary) + environment variables (fallback).
 * Keys never leave the server — only provider IDs and metadata are exposed via API.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createLogger } from '@openmaic/lib/logger';
import { TTS_PROVIDERS } from '@openmaic/lib/audio/constants';
import {
  registerTtsVoiceTimingCalibration,
  getTtsCalibrationKey,
  TTS_TIMING_ALGORITHM_VERSION,
  type TtsVoiceTimingCalibration,
} from '@openmaic/lib/audio/tts-timing';
import { providerPrisma, isProviderDatabaseConfigured } from '@/lib/db/client';
import { decodeProviderSecret } from '@/lib/security/provider-secret';
import { normalizeManagedProviderCatalogSection } from '@openmaic/lib/provider-catalog-policy';
import type {
  TtsScenarioConfigs,
  TtsScenarioId,
} from '@openmaic/lib/audio/tts-scenarios';
import {
  resolveScenarioThinkingConfig,
  type LlmThinkingScenarioConfigs,
} from '@openmaic/lib/ai/thinking-scenarios';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';

const log = createLogger('ServerProviderConfig');
const DEFAULT_FILENAME = 'server-providers.yml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerProviderEntry {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  proxy?: string;
  /**
   * Lower numbers are tried first. Used by TTS course-generation defaults.
   */
  priority?: number;
  /**
   * Admin/operator force-off switch. `false` disables the provider for ALL
   * clients regardless of the user's per-provider toggle (server precedence).
   * TTS additionally supports provider-specific environment overrides (#665).
   */
  enabled?: boolean;
  /**
   * 教师在设置页指定的该 provider 默认模型 ID。
   * 当生成调用未携带 x-model 时，resolveModel 会回退到此值。
   */
  defaultModel?: string;
  dimensions?: number;
  thinkingScenarioConfigs?: LlmThinkingScenarioConfigs;
  defaultVoice?: string;
  scenarioConfigs?: TtsScenarioConfigs;
  timingCalibrations?: TtsVoiceTimingCalibration[];
}

interface ServerConfig {
  providers: Record<string, ServerProviderEntry>;
  tts: Record<string, ServerProviderEntry>;
  asr: Record<string, ServerProviderEntry>;
  pdf: Record<string, ServerProviderEntry>;
  image: Record<string, ServerProviderEntry>;
  video: Record<string, ServerProviderEntry>;
  webSearch: Record<string, ServerProviderEntry>;
  embedding: Record<string, ServerProviderEntry>;
  /** TTS provider IDs the operator force-disabled (server precedence). */
  ttsDisabled: Set<string>;
}

// ---------------------------------------------------------------------------
// Env-var prefix mappings
// ---------------------------------------------------------------------------

const LLM_ENV_MAP: Record<string, string> = {
  OPENAI: 'openai',
  AZURE_OPENAI: 'azure',
  ATLASCLOUD: 'atlascloud',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  DEEPSEEK: 'deepseek',
  QWEN: 'qwen',
  KIMI: 'kimi',
  MINIMAX: 'minimax',
  GLM: 'glm',
  SILICONFLOW: 'siliconflow',
  DOUBAO: 'doubao',
  OPENROUTER: 'openrouter',
  GROK: 'grok',
  TENCENT: 'tencent-hunyuan',
  TENCENT_HUNYUAN: 'tencent-hunyuan',
  XIAOMI: 'xiaomi',
  MIMO: 'xiaomi',
  OLLAMA: 'ollama',
  LEMONADE: 'lemonade',
  BEDROCK: 'bedrock',
};

const TTS_ENV_MAP: Record<string, string> = {
  TTS_OPENAI: 'openai-tts',
  TTS_AZURE: 'azure-tts',
  TTS_GLM: 'glm-tts',
  TTS_QWEN: 'qwen-tts',
  TTS_VOXCPM: 'voxcpm-tts',
  TTS_DOUBAO: 'doubao-tts',
  TTS_ELEVENLABS: 'elevenlabs-tts',
  TTS_MINIMAX: 'minimax-tts',
  TTS_LEMONADE: 'lemonade-tts',
};

/**
 * Env prefixes for the TTS force-disable switch (`TTS_<PREFIX>_ENABLED=false`).
 * Superset of TTS_ENV_MAP: browser-native has no credential env (it is
 * client-only) but operators may still want to force it off fleet-wide (#665).
 */
const TTS_DISABLE_ENV_MAP: Record<string, string> = {
  ...TTS_ENV_MAP,
  TTS_BROWSER_NATIVE: 'browser-native-tts',
};

const ASR_ENV_MAP: Record<string, string> = {
  ASR_OPENAI: 'openai-whisper',
  ASR_QWEN: 'qwen-asr',
  ASR_AZURE: 'azure-asr',
  ASR_LEMONADE: 'lemonade-asr',
};

const PDF_ENV_MAP: Record<string, string> = {
  PDF_UNPDF: 'unpdf',
  PDF_MINERU: 'mineru',
  PDF_MINERU_CLOUD: 'mineru-cloud',
};

const IMAGE_ENV_MAP: Record<string, string> = {
  IMAGE_OPENAI: 'openai-image',
  IMAGE_SEEDREAM: 'seedream',
  IMAGE_QWEN_IMAGE: 'qwen-image',
  IMAGE_NANO_BANANA: 'nano-banana',
  IMAGE_MINIMAX: 'minimax-image',
  IMAGE_GROK: 'grok-image',
  IMAGE_LEMONADE: 'lemonade',
};

const VIDEO_ENV_MAP: Record<string, string> = {
  VIDEO_SEEDANCE: 'seedance',
  VIDEO_KLING: 'kling',
  VIDEO_VEO: 'veo',
  VIDEO_SORA: 'sora',
  VIDEO_MINIMAX: 'minimax-video',
  VIDEO_GROK: 'grok-video',
  VIDEO_HAPPYHORSE: 'happyhorse',
};

const WEB_SEARCH_ENV_MAP: Record<string, string> = {
  TAVILY: 'tavily',
  BOCHA: 'bocha',
  BRAVE: 'brave',
  BAIDU: 'baidu',
  WEB_SEARCH_MINIMAX: 'minimax',
};

const EMBEDDING_ENV_MAP: Record<string, string> = {
  EMBEDDING_OLLAMA: 'ollama-embedding',
  EMBEDDING_QWEN: 'qwen-embedding',
  EMBEDDING_OPENAI: 'openai-embedding',
};

const KEYLESS_EMBEDDING_PROVIDERS = new Set(['ollama-embedding']);

// ---------------------------------------------------------------------------
// YAML loading
// ---------------------------------------------------------------------------

type YamlData = Partial<{
  providers: Record<string, Partial<ServerProviderEntry>>;
  tts: Record<string, Partial<ServerProviderEntry>>;
  asr: Record<string, Partial<ServerProviderEntry>>;
  pdf: Record<string, Partial<ServerProviderEntry>>;
  image: Record<string, Partial<ServerProviderEntry>>;
  video: Record<string, Partial<ServerProviderEntry>>;
  'web-search': Record<string, Partial<ServerProviderEntry>>;
  embedding: Record<string, Partial<ServerProviderEntry>>;
}>;

function loadDefaultYamlFile(): YamlData {
  try {
    const filePath = path.join(/* turbopackIgnore: true */ process.cwd(), DEFAULT_FILENAME);
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as YamlData;
  } catch (e) {
    log.warn(`[ServerProviderConfig] Failed to load ${DEFAULT_FILENAME}:`, e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Env-var helpers
// ---------------------------------------------------------------------------

function loadEnvSection(
  envMap: Record<string, string>,
  yamlSection: Record<string, Partial<ServerProviderEntry>> | undefined,
  {
    requiresBaseUrl = false,
    keylessProviders = new Set<string>(),
    baseUrlOptionalProviders = new Set<string>(),
  }: {
    requiresBaseUrl?: boolean;
    keylessProviders?: Set<string>;
    baseUrlOptionalProviders?: Set<string>;
  } = {},
): Record<string, ServerProviderEntry> {
  const result: Record<string, ServerProviderEntry> = {};
  const requiresBaseUrlForProvider = (providerId: string) =>
    requiresBaseUrl && !baseUrlOptionalProviders.has(providerId);

  // First, add everything from YAML as defaults
  if (yamlSection) {
    for (const [id, entry] of Object.entries(yamlSection)) {
      if (entry?.enabled === false) continue;
      if (
        requiresBaseUrlForProvider(id)
          ? !!entry?.baseUrl
          : entry?.apiKey || (entry?.baseUrl && keylessProviders.has(id))
      ) {
        result[id] = {
          apiKey: entry.apiKey || '',
          baseUrl: entry.baseUrl,
          models: entry.models,
          proxy: entry.proxy,
          priority: typeof entry.priority === 'number' ? entry.priority : undefined,
          defaultModel: entry.defaultModel,
          thinkingScenarioConfigs: entry.thinkingScenarioConfigs,
          defaultVoice: entry.defaultVoice,
          scenarioConfigs: entry.scenarioConfigs,
          timingCalibrations: entry.timingCalibrations,
        };
      }
    }
  }

  // Then, apply env vars (env takes priority over YAML)
  for (const [prefix, providerId] of Object.entries(envMap)) {
    const envApiKey = process.env[`${prefix}_API_KEY`] || undefined;
    const envBaseUrl = process.env[`${prefix}_BASE_URL`] || undefined;
    const envModelsStr = process.env[`${prefix}_MODELS`];
    const envModels = envModelsStr
      ? envModelsStr
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean)
      : undefined;

    if (result[providerId]) {
      // YAML entry exists — env vars override individual fields
      if (envApiKey) result[providerId].apiKey = envApiKey;
      if (envBaseUrl) result[providerId].baseUrl = envBaseUrl;
      if (envModels) result[providerId].models = envModels;
      continue;
    }

    // Activate on API key, or base URL alone for keyless providers (e.g. Ollama)
    if (
      requiresBaseUrlForProvider(providerId)
        ? !envBaseUrl
        : !(envApiKey || (envBaseUrl && keylessProviders.has(providerId)))
    )
      continue;
    result[providerId] = {
      apiKey: envApiKey || '',
      baseUrl: envBaseUrl,
      models: envModels,
    };
  }

  return result;
}

/** Parse a boolean-ish env value. Falsey words ⇒ false; anything else ⇒ true. */
function parseBooleanEnv(raw: string): boolean {
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

/**
 * Collect TTS provider IDs the operator force-disabled, from YAML
 * (`tts.<id>.enabled: false`) and env (`TTS_<PREFIX>_ENABLED=false`). An
 * explicit env `true` overrides a YAML disable (env precedence, matching the
 * rest of this module).
 */
function collectDisabledTTS(
  yamlTts: Record<string, Partial<ServerProviderEntry>> | undefined,
): Set<string> {
  const disabled = new Set<string>();
  if (yamlTts) {
    for (const [id, entry] of Object.entries(yamlTts)) {
      if (entry?.enabled === false) disabled.add(id);
    }
  }
  for (const [prefix, providerId] of Object.entries(TTS_DISABLE_ENV_MAP)) {
    const raw = process.env[`${prefix}_ENABLED`];
    // Treat unset / empty (e.g. a blank CI-templated value) as "no opinion" so
    // it never silently overrides an explicit YAML disable.
    if (raw === undefined || raw.trim() === '') continue;
    if (parseBooleanEnv(raw)) disabled.delete(providerId);
    else disabled.add(providerId);
  }
  return disabled;
}

// ---------------------------------------------------------------------------
// Module-level cache (process singleton)
// ---------------------------------------------------------------------------

const OPENAI_IMAGE_PROVIDER_ID = 'openai-image';
const BEDROCK_PROVIDER_ID = 'bedrock';

/**
 * Provider configuration is initialized by Next.js instrumentation, which is
 * compiled into a different server chunk from route handlers. Module-local
 * variables are therefore not a reliable process singleton in production:
 * instrumentation can initialize one copy while a route reads another.
 *
 * Keep the state on globalThis behind Symbol.for so every compiled copy in the
 * same Node.js process observes the initialized database snapshot and cache.
 */
type ProviderConfigRuntimeState = {
  configs: Map<string, ServerConfig>;
  databaseYamlData: YamlData | null;
  initialization?: Promise<void>;
  refreshTimer?: ReturnType<typeof setInterval>;
};

const PROVIDER_CONFIG_STATE_KEY = Symbol.for('openpbl.server-provider-config');

function getProviderConfigRuntimeState(): ProviderConfigRuntimeState {
  const scope = globalThis as typeof globalThis & {
    [PROVIDER_CONFIG_STATE_KEY]?: ProviderConfigRuntimeState;
  };
  return scope[PROVIDER_CONFIG_STATE_KEY] ??= {
    configs: new Map<string, ServerConfig>(),
    databaseYamlData: null,
  };
}

export async function initializeServerProviderConfig(): Promise<void> {
  const state = getProviderConfigRuntimeState();
  if (state.initialization) return state.initialization;
  state.initialization = (async () => {
    if (!isProviderDatabaseConfigured()) {
      state.databaseYamlData = {};
      state.configs.clear();
      return;
    }
    const rows = await providerPrisma.providerCredential.findMany({ where: { ownerId: null, status: 'ACTIVE' }, orderBy: { updatedAt: 'asc' } });
    const data: YamlData = {};
    for (const row of rows) {
      const section = row.name as keyof YamlData;
      if (!['providers', 'tts', 'asr', 'pdf', 'image', 'video', 'web-search', 'embedding'].includes(section)) {
        continue;
      }
      const config =
        row.config && typeof row.config === 'object' && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      const target = (data[section] ??= {});
      target[row.provider] = {
        ...config,
        apiKey: decodeProviderSecret(row.secret, `${row.name}:${row.provider}`),
      } as Partial<ServerProviderEntry>;
    }
    state.databaseYamlData = data;
    state.configs.clear();
  })();
  try {
    await state.initialization;
  } finally {
    state.initialization = undefined;
  }
  ensureProviderConfigRefreshTimer(state);
}

function ensureProviderConfigRefreshTimer(state: ProviderConfigRuntimeState): void {
  if (
    state.refreshTimer ||
    process.env.NODE_ENV !== 'production' ||
    !isProviderDatabaseConfigured()
  ) return;
  state.refreshTimer = setInterval(() => {
    void initializeServerProviderConfig().catch((error) => {
      log.warn('[ServerProviderConfig] Shared provider refresh failed:', error);
    });
  }, 5_000);
  state.refreshTimer.unref?.();
}

function applyOpenAIImageFallback(
  imageConfig: Record<string, ServerProviderEntry>,
  yamlImageSection: Record<string, Partial<ServerProviderEntry>> | undefined,
): Record<string, ServerProviderEntry> {
  if (imageConfig[OPENAI_IMAGE_PROVIDER_ID]) return imageConfig;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return imageConfig;

  const yamlOpenAIImage = yamlImageSection?.[OPENAI_IMAGE_PROVIDER_ID];
  imageConfig[OPENAI_IMAGE_PROVIDER_ID] = {
    apiKey,
    baseUrl:
      yamlOpenAIImage?.baseUrl || process.env.IMAGE_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
    models: yamlOpenAIImage?.models,
    proxy: yamlOpenAIImage?.proxy,
  };
  return imageConfig;
}

function splitModels(models: string | undefined): string[] | undefined {
  const parsed = models?.split(',').map((model) => model.trim()).filter(Boolean);
  return parsed?.length ? parsed : undefined;
}

function applyBedrockProviderConfig(
  providers: Record<string, ServerProviderEntry>,
  configuredProviders: Record<string, Partial<ServerProviderEntry>> | undefined,
): Record<string, ServerProviderEntry> {
  const configured = configuredProviders?.[BEDROCK_PROVIDER_ID];
  const envApiKey = process.env.BEDROCK_API_KEY || undefined;
  const envBaseUrl = process.env.BEDROCK_BASE_URL || undefined;
  const envModels = splitModels(process.env.BEDROCK_MODELS);
  const hasEnvironmentConfig = Boolean(
    process.env.BEDROCK_REGION || envModels || envApiKey || envBaseUrl || process.env.AWS_BEARER_TOKEN_BEDROCK,
  );
  const hasSavedConfig = Object.prototype.hasOwnProperty.call(
    configuredProviders ?? {},
    BEDROCK_PROVIDER_ID,
  );
  if (!providers[BEDROCK_PROVIDER_ID] && !hasEnvironmentConfig && !hasSavedConfig) return providers;
  providers[BEDROCK_PROVIDER_ID] = {
    apiKey: envApiKey || configured?.apiKey || providers[BEDROCK_PROVIDER_ID]?.apiKey || '',
    baseUrl: envBaseUrl || configured?.baseUrl || providers[BEDROCK_PROVIDER_ID]?.baseUrl,
    models: envModels || configured?.models || providers[BEDROCK_PROVIDER_ID]?.models,
    proxy: configured?.proxy || providers[BEDROCK_PROVIDER_ID]?.proxy,
    defaultModel: configured?.defaultModel || providers[BEDROCK_PROVIDER_ID]?.defaultModel,
    thinkingScenarioConfigs:
      configured?.thinkingScenarioConfigs || providers[BEDROCK_PROVIDER_ID]?.thinkingScenarioConfigs,
    priority: configured?.priority ?? providers[BEDROCK_PROVIDER_ID]?.priority,
  };
  return providers;
}

function buildConfig(yamlData: YamlData): ServerConfig {
  const image = normalizeManagedProviderCatalogSection('image', applyOpenAIImageFallback(
    loadEnvSection(IMAGE_ENV_MAP, yamlData.image, {
      keylessProviders: new Set(['lemonade']),
    }),
    yamlData.image,
  ));

  const providers = applyBedrockProviderConfig(
    loadEnvSection(LLM_ENV_MAP, yamlData.providers, {
      keylessProviders: new Set(['ollama', 'lemonade', BEDROCK_PROVIDER_ID]),
    }),
    yamlData.providers,
  );

  return {
    providers,
    tts: normalizeManagedProviderCatalogSection(
      'tts',
      loadEnvSection(TTS_ENV_MAP, yamlData.tts, {
        keylessProviders: new Set(['voxcpm-tts', 'lemonade-tts']),
      }),
    ),
    asr: loadEnvSection(ASR_ENV_MAP, yamlData.asr, {
      keylessProviders: new Set(['lemonade-asr']),
    }),
    pdf: loadEnvSection(PDF_ENV_MAP, yamlData.pdf, {
      requiresBaseUrl: true,
      baseUrlOptionalProviders: new Set(['mineru-cloud']),
    }),
    image,
    video: loadEnvSection(VIDEO_ENV_MAP, yamlData.video),
    webSearch: loadEnvSection(WEB_SEARCH_ENV_MAP, yamlData['web-search']),
    embedding: loadEnvSection(EMBEDDING_ENV_MAP, yamlData.embedding, {
      requiresBaseUrl: true,
      keylessProviders: KEYLESS_EMBEDDING_PROVIDERS,
    }),
    ttsDisabled: collectDisabledTTS(yamlData.tts),
  };
}

function logConfig(config: ServerConfig, label: string): void {
  const counts = [
    Object.keys(config.providers).length,
    Object.keys(config.tts).length,
    Object.keys(config.asr).length,
    Object.keys(config.pdf).length,
    Object.keys(config.image).length,
    Object.keys(config.video).length,
    Object.keys(config.webSearch).length,
    Object.keys(config.embedding).length,
  ];
  if (counts.some((c) => c > 0)) {
    log.info(
      `[ServerProviderConfig] Loaded (${label}): ${counts[0]} LLM, ${counts[1]} TTS, ${counts[2]} ASR, ${counts[3]} PDF, ${counts[4]} Image, ${counts[5]} Video, ${counts[6]} WebSearch, ${counts[7]} Embedding providers`,
    );
  }
}

function getConfig(): ServerConfig {
  const state = getProviderConfigRuntimeState();
  const cached = state.configs.get('');
  if (cached) return cached;

  if (process.env.NODE_ENV === 'production' && state.databaseYamlData === null) {
    throw new Error('Provider configuration was not initialized.');
  }
  const yamlData = state.databaseYamlData ?? loadDefaultYamlFile();
  const config = buildConfig(yamlData);
  logConfig(config, DEFAULT_FILENAME);
  state.configs.set('', config);
  return config;
}

export function clearServerProviderConfigCache(): void {
  getProviderConfigRuntimeState().configs.clear();
}

// ---------------------------------------------------------------------------
// Managed-provider resolution
//
// A provider is "server-managed" iff the operator configured it (an entry is
// present in the server config). Managed providers are admin-owned and NOT
// overridable from the client: the server key and base URL are authoritative
// and any client-sent key/baseUrl is ignored. Unmanaged providers (the user's
// own custom credentials) resolve purely from the client value. This single
// rule removes the tri-state where a client base URL could partially override
// server config (the bug class #533 patched route-by-route).
// ---------------------------------------------------------------------------

type ProviderSection = Exclude<keyof ServerConfig, 'ttsDisabled'>;
type ProviderMetadata = {
  disabled?: boolean;
  models?: string[];
  defaultModel?: string;
  priority?: number;
  defaultVoice?: string;
  scenarioConfigs?: TtsScenarioConfigs;
  timingCalibrations?: TtsVoiceTimingCalibration[];
};

function getProviderPriority(entry: ServerProviderEntry): number {
  return typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER;
}

function sortProviderEntries(
  entries: Array<[string, ServerProviderEntry]>,
): Array<[string, ServerProviderEntry]> {
  return entries.sort(([, a], [, b]) => {
    const ap = getProviderPriority(a);
    const bp = getProviderPriority(b);
    if (ap !== bp) return ap - bp;
    if (!!a.defaultModel !== !!b.defaultModel) return a.defaultModel ? -1 : 1;
    return 0;
  });
}

function toProviderMetadata(entry: ServerProviderEntry): ProviderMetadata {
  const metadata: ProviderMetadata = {};
  if (entry.models && entry.models.length > 0) metadata.models = entry.models;
  if (entry.defaultModel) metadata.defaultModel = entry.defaultModel;
  if (typeof entry.priority === 'number') metadata.priority = entry.priority;
  if (entry.defaultVoice) metadata.defaultVoice = entry.defaultVoice;
  if (entry.scenarioConfigs) metadata.scenarioConfigs = entry.scenarioConfigs;
  if (entry.timingCalibrations?.length) metadata.timingCalibrations = entry.timingCalibrations;
  return metadata;
}

/** Whether the operator configured this provider in the given section. */
export function isServerConfiguredProvider(section: ProviderSection, providerId: string): boolean {
  return !!getConfig()[section][providerId];
}

function resolveSectionApiKey(
  section: ProviderSection,
  providerId: string,
  clientKey?: string,
): string {
  const entry = getConfig()[section][providerId];
  if (entry) return entry.apiKey || ''; // managed: server key is authoritative
  return clientKey || ''; // unmanaged: client-supplied key only
}

function resolveSectionBaseUrl(
  section: ProviderSection,
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  const entry = getConfig()[section][providerId];
  if (entry) return entry.baseUrl; // managed: server base URL is authoritative
  return clientBaseUrl; // unmanaged: client-supplied base URL only
}

// ---------------------------------------------------------------------------
// Public API — LLM
// ---------------------------------------------------------------------------

/**
 * Returns server-configured LLM providers. Exposes only the allowed model list,
 * the teacher-selected default model, and the "managed" flag (presence in this
 * map) — never the API key or the base URL, which can reveal internal
 * gateway/proxy infrastructure.
 */
export function getServerProviders(): Record<string, ProviderMetadata> {
  const cfg = getConfig();
  const result: Record<string, ProviderMetadata> = {};
  for (const [id, entry] of sortProviderEntries(Object.entries(cfg.providers))) {
    result[id] = toProviderMetadata(entry);
  }
  return result;
}

/**
 * Resolve the server-side default model for a given LLM provider.
 * Returns the modelId (without provider prefix) if the teacher has selected a
 * default model in the settings UI, otherwise undefined.
 */
export function resolveServerDefaultModel(providerId: string): string | undefined {
  return getConfig().providers[providerId]?.defaultModel;
}

/** Resolve an optional teacher-authored thinking override for an application stage. */
export function resolveServerThinkingConfig(
  providerId: string,
  stage?: string,
): ThinkingConfig | undefined {
  return resolveScenarioThinkingConfig(
    getConfig().providers[providerId]?.thinkingScenarioConfigs,
    stage,
  );
}

/**
 * Find the first server-configured LLM provider that has a defaultModel set.
 * Used as a fallback when no providerId is known yet (no x-model, no stage
 * route). Returns a `providerId:modelId` string compatible with parseModelString,
 * or undefined if no provider has a default model configured.
 */
export function findServerDefaultModelString(): string | undefined {
  const cfg = getConfig();
  for (const [id, entry] of sortProviderEntries(Object.entries(cfg.providers))) {
    if (entry.defaultModel) {
      return `${id}:${entry.defaultModel}`;
    }
  }
  return undefined;
}

/** Resolve API key. Managed provider ⇒ server key; otherwise client key. */
export function resolveApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('providers', providerId, clientKey);
}

/** Resolve base URL. Managed provider ⇒ server URL; otherwise client URL. */
export function resolveBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('providers', providerId, clientBaseUrl);
}

/** Resolve proxy URL for a provider (server config, then scoped deployment fallback). */
export function resolveProxy(providerId: string): string | undefined {
  const configuredProxy = getConfig().providers[providerId]?.proxy?.trim();
  if (configuredProxy) return configuredProxy;

  // The official DeepSeek endpoint is not reachable directly from every
  // deployment region. Keep this fallback provider-scoped instead of applying
  // a process-wide HTTPS proxy that could disrupt otherwise healthy vendors.
  if (providerId === 'deepseek') {
    return process.env.OPENPBL_DEEPSEEK_PROXY?.trim() || undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API — TTS
// ---------------------------------------------------------------------------

/**
 * Returns TTS providers the client must know about: server-managed providers
 * (presence = managed flag, no base URLs) plus operator force-disabled
 * providers (`{ disabled: true }`). A force-disabled provider is reported as
 * disabled even when it is otherwise configured — disable wins (#665).
 */
export function getServerTTSProviders(): Record<string, ProviderMetadata> {
  const cfg = getConfig();
  const result: Record<string, ProviderMetadata> = {};
  for (const [id, entry] of sortProviderEntries(Object.entries(cfg.tts))) {
    result[id] = toProviderMetadata(entry);
  }
  for (const id of cfg.ttsDisabled) result[id] = { disabled: true };
  return result;
}

export function resolveTTSApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('tts', providerId, clientKey);
}

/** Whether the operator force-disabled this TTS provider (server precedence, #665). */
export function isServerTTSProviderDisabled(providerId: string): boolean {
  return getConfig().ttsDisabled.has(providerId);
}

export function resolveTTSBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('tts', providerId, clientBaseUrl);
}

/**
 * Resolve the TTS model. Managed providers may pin a model for each usage
 * scenario; older configs fall back to their default/first model. Unmanaged
 * providers continue to use the client selection.
 */
export function resolveTTSModel(
  providerId: string,
  clientModel?: string,
  scenario?: TtsScenarioId,
): string | undefined {
  const entry = getConfig().tts[providerId];
  if (scenario && entry?.scenarioConfigs?.[scenario]?.modelId) {
    return entry.scenarioConfigs[scenario].modelId;
  }
  if (entry?.defaultModel) return entry.defaultModel;
  if (entry?.models && entry.models.length > 0) return entry.models[0];
  return clientModel;
}

export function resolveTTSVoice(
  providerId: string,
  clientVoice?: string,
  scenario?: TtsScenarioId,
): string | undefined {
  const entry = getConfig().tts[providerId];
  if (scenario && entry?.scenarioConfigs?.[scenario]?.voiceId) {
    return entry.scenarioConfigs[scenario].voiceId;
  }
  return entry?.defaultVoice || clientVoice;
}

/** Register and return the exact normal-speed profile for provider/model/voice. */
export function resolveTTSTimingCalibration(
  providerId: string,
  modelId: string,
  voiceId: string,
  language = 'zh-CN',
  speed = 1,
): TtsVoiceTimingCalibration | undefined {
  const expectedKey = getTtsCalibrationKey({
    providerId, modelId, voiceId, language, speed,
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
  });
  const calibration = getConfig().tts[providerId]?.timingCalibrations?.find(
    (item) => getTtsCalibrationKey(item) === expectedKey,
  );
  if (calibration) registerTtsVoiceTimingCalibration(calibration);
  return calibration;
}

// ---------------------------------------------------------------------------
// Public API — ASR
// ---------------------------------------------------------------------------

/** Returns server-configured ASR providers (metadata only, no base URLs). */
export function getServerASRProviders(): Record<string, ProviderMetadata> {
  return Object.fromEntries(
    sortProviderEntries(Object.entries(getConfig().asr)).map(([id, entry]) => [
      id,
      toProviderMetadata(entry),
    ]),
  );
}

export function resolveASRApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('asr', providerId, clientKey);
}

export function resolveASRBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('asr', providerId, clientBaseUrl);
}

/**
 * Resolve the ASR model selected by the teacher. Managed ASR providers are
 * authoritative for credentials, endpoint and model alike, so a stale model
 * persisted in a student browser cannot override the current classroom
 * configuration.
 */
export function resolveASRModel(providerId: string, clientModel?: string): string | undefined {
  const entry = getConfig().asr[providerId];
  if (entry?.defaultModel) return entry.defaultModel;
  if (entry?.models && entry.models.length > 0) return entry.models[0];
  return clientModel;
}

// ---------------------------------------------------------------------------
// Public API — PDF
// ---------------------------------------------------------------------------

/** Returns server-configured PDF providers (metadata only, no base URLs). */
export function getServerPDFProviders(): Record<string, ProviderMetadata> {
  return Object.fromEntries(
    sortProviderEntries(Object.entries(getConfig().pdf)).map(([id, entry]) => [
      id,
      toProviderMetadata(entry),
    ]),
  );
}

export function resolvePDFApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('pdf', providerId, clientKey);
}

export function resolvePDFBaseUrl(providerId: string, clientBaseUrl?: string): string | undefined {
  return resolveSectionBaseUrl('pdf', providerId, clientBaseUrl);
}

// ---------------------------------------------------------------------------
// Public API — Image Generation
// ---------------------------------------------------------------------------

/** Returns server-configured image providers (metadata only, no base URLs). */
export function getServerImageProviders(): Record<string, ProviderMetadata> {
  const cfg = getConfig();
  const result: Record<string, ProviderMetadata> = {};
  for (const [id, entry] of sortProviderEntries(Object.entries(cfg.image))) {
    result[id] = toProviderMetadata(entry);
  }
  return result;
}

export function resolveImageApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('image', providerId, clientKey);
}

export function resolveImageBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('image', providerId, clientBaseUrl);
}

// ---------------------------------------------------------------------------
// Public API — Video Generation
// ---------------------------------------------------------------------------

/** Returns server-configured video providers (metadata only, no base URLs). */
export function getServerVideoProviders(): Record<string, ProviderMetadata> {
  return Object.fromEntries(
    sortProviderEntries(Object.entries(getConfig().video)).map(([id, entry]) => [
      id,
      toProviderMetadata(entry),
    ]),
  );
}

export function resolveVideoApiKey(providerId: string, clientKey?: string): string {
  return resolveSectionApiKey('video', providerId, clientKey);
}

export function resolveVideoBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('video', providerId, clientBaseUrl);
}

// ---------------------------------------------------------------------------
// Public API — Web Search
// ---------------------------------------------------------------------------

/** Returns server-configured web search providers (metadata only, no base URLs). */
export function getServerWebSearchProviders(): Record<string, ProviderMetadata> {
  return Object.fromEntries(
    sortProviderEntries(Object.entries(getConfig().webSearch)).map(([id, entry]) => [
      id,
      toProviderMetadata(entry),
    ]),
  );
}

/**
 * Resolve web search API key.
 *
 * Backward-compatible call shapes:
 * - resolveWebSearchApiKey(clientKey) -> Tavily key resolution
 * - resolveWebSearchApiKey(providerId, clientKey) -> provider-specific resolution
 */
export function resolveWebSearchApiKey(clientKey?: string): string;
export function resolveWebSearchApiKey(providerId: string, clientKey?: string): string;
export function resolveWebSearchApiKey(providerIdOrClientKey?: string, clientKey?: string): string {
  const hasProviderId = arguments.length >= 2;
  const providerId = hasProviderId ? providerIdOrClientKey || 'tavily' : 'tavily';
  const effectiveClientKey = hasProviderId ? clientKey : providerIdOrClientKey;
  return resolveSectionApiKey('webSearch', providerId, effectiveClientKey);
}

export function resolveWebSearchBaseUrl(
  providerId: string,
  clientBaseUrl?: string,
): string | undefined {
  return resolveSectionBaseUrl('webSearch', providerId, clientBaseUrl);
}

export function resolveServerWebSearchProviderId(preferredProviderId?: string): string | undefined {
  const webSearch = getConfig().webSearch;
  if (preferredProviderId && webSearch[preferredProviderId]?.apiKey) {
    return preferredProviderId;
  }
  const defaultEntry = sortProviderEntries(Object.entries(webSearch)).find(
    ([, entry]) => entry.apiKey,
  );
  if (defaultEntry) return defaultEntry[0];
  if (webSearch.tavily?.apiKey) return 'tavily';
  if (webSearch.bocha?.apiKey) return 'bocha';
  if (webSearch.baidu?.apiKey) return 'baidu';
  if (webSearch.minimax?.apiKey) return 'minimax';
  return Object.keys(webSearch)[0];
}

export type ServerEmbeddingProvider = {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: 1024;
};

/** Resolve the single active embedding profile used to build a comparable vector space. */
export function resolveServerEmbeddingProvider(): ServerEmbeddingProvider | undefined {
  const configured = sortProviderEntries(Object.entries(getConfig().embedding)).find(([providerId, entry]) =>
    entry.enabled !== false
      && Boolean(entry.baseUrl && (entry.defaultModel || entry.models?.[0]))
      && Boolean(entry.apiKey || KEYLESS_EMBEDDING_PROVIDERS.has(providerId)),
  );
  if (!configured) return undefined;
  const [providerId, entry] = configured;
  return {
    providerId,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl!,
    model: entry.defaultModel || entry.models![0],
    dimensions: 1024,
  };
}

/**
 * Opt-in concurrency for parallel scene-content generation (#572).
 *
 * Returns the server-configured `PARALLEL_SCENE_CONCURRENCY`, clamped to
 * [0, 10]. `0` (the default) means the client keeps the original serial
 * generation loop; a value `> 1` enables the hybrid two-phase path. Kept
 * server-side because many deployments use API keys with low per-key
 * concurrency quotas, where a bursty default would surface as 429s.
 */
export function getParallelSceneConcurrency(): number {
  const raw = Number.parseInt(process.env.PARALLEL_SCENE_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 10);
}

/**
 * Concurrency used by the teacher server-side classroom scene pipeline.
 *
 * The older client generation path keeps `getParallelSceneConcurrency()` opt-in
 * and defaults to serial generation. The teacher pipeline is now explicitly
 * finite-concurrent: it defaults to two scene workers and accepts the same
 * environment variable as an override, clamped to the supported 1-5 range.
 * Two matches the validated course-quality lab and avoids placing four
 * simultaneous long-reasoning JSON requests on one provider key.
 */
export function getClassroomSceneConcurrency(): number {
  const configured = getParallelSceneConcurrency();
  if (configured <= 0) return 2;
  return Math.min(configured, 5);
}

const DEFAULT_TTS_CONCURRENCY = 2;
const MIN_TTS_CONCURRENCY = 1;
const MAX_TTS_CONCURRENCY = 4;

function ttsConcurrencyEnvKey(providerId: string): string {
  return `TTS_${providerId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_CONCURRENCY`;
}

/**
 * Resolve a safe server-side TTS concurrency for a provider.
 *
 * Provider metadata supplies a conservative default. Operators can tune a
 * provider independently with `TTS_<PROVIDER>_CONCURRENCY`, or apply a global
 * cap with `TTS_CONCURRENCY`. Every value is clamped to 1-4 so a bad setting
 * cannot turn classroom generation into an unbounded request burst.
 */
export function getTtsConcurrencyLimit(providerId: string): number {
  const providerConfig = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const configured =
    process.env[ttsConcurrencyEnvKey(providerId)] ?? process.env.TTS_CONCURRENCY;
  const fallback = providerConfig?.maxConcurrency ?? DEFAULT_TTS_CONCURRENCY;
  const raw = configured === undefined ? fallback : Number.parseInt(configured, 10);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.min(MAX_TTS_CONCURRENCY, Math.max(MIN_TTS_CONCURRENCY, value));
}

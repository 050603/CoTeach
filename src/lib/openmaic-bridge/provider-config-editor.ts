// 为 OpenMAIC 原生只读 Provider 配置补充持久化写入能力。
// 数据库不可用时，教师设置页会回退读写 server-providers.yml。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  clearServerProviderConfigCache,
  initializeServerProviderConfig,
} from '@openmaic/lib/server/provider-config';
import { providerPrisma, isProviderDatabaseConfigured } from '@/lib/db/client';
import {
  decodeProviderSecret,
  encodeProviderSecret,
} from '@/lib/security/provider-secret';
import { Prisma } from '@prisma/client';
import {
  getTtsCalibrationKey,
  mergeTtsVoiceTimingCalibrations,
  type TtsVoiceTimingCalibration,
} from '@openmaic/lib/audio/tts-timing';
import { normalizeManagedProviderCatalog } from '@openmaic/lib/provider-catalog-policy';
import type { TtsScenarioConfigs } from '@openmaic/lib/audio/tts-scenarios';
import type { LlmThinkingScenarioConfigs } from '@openmaic/lib/ai/thinking-scenarios';

export type ProviderSection = 'providers' | 'tts' | 'asr' | 'pdf' | 'image' | 'video' | 'web-search';

export interface ProviderEntry {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  enabled?: boolean;
  priority?: number;
  /**
   * 教师在设置页指定的默认模型 ID，必须来自该 Provider 的 models 列表。
   * 生成请求未携带 x-model 时，resolveModel 会回退到这个值。
   * 仅用于 LLM providers；其他 Provider 分区会忽略此字段。
   */
  defaultModel?: string;
  thinkingScenarioConfigs?: LlmThinkingScenarioConfigs;
  defaultVoice?: string;
  scenarioConfigs?: TtsScenarioConfigs;
  timingCalibrations?: TtsVoiceTimingCalibration[];
}

const CONFIG_PATH = path.join(/* turbopackIgnore: true */ process.cwd(), 'server-providers.yml');

interface ServerProvidersYaml {
  providers?: Record<string, Partial<ProviderEntry>>;
  tts?: Record<string, Partial<ProviderEntry>>;
  asr?: Record<string, Partial<ProviderEntry>>;
  pdf?: Record<string, Partial<ProviderEntry>>;
  image?: Record<string, Partial<ProviderEntry>>;
  video?: Record<string, Partial<ProviderEntry>>;
  'web-search'?: Record<string, Partial<ProviderEntry>>;
}

async function readYaml(): Promise<ServerProvidersYaml> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return (yaml.load(raw) as ServerProvidersYaml) ?? {};
  } catch {
    return {};
  }
}

async function writeYaml(data: ServerProvidersYaml): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const raw = yaml.dump(data, { lineWidth: 120, noRefs: true });
  await writeFile(CONFIG_PATH, raw, 'utf8');
  // 清除 OpenMAIC Provider 配置缓存，让下一次读取使用刚写入的值。
  invalidateProviderConfigCache();
}

let providerConfigWriteQueue = Promise.resolve();

async function withProviderConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  let result!: T;
  const queued = providerConfigWriteQueue.then(async () => {
    result = await operation();
  });
  providerConfigWriteQueue = queued.catch(() => undefined);
  await queued;
  return result;
}

/** Atomically merge one measured sample into the shared provider/voice aggregate. */
export async function mergeProviderTtsTimingCalibration(
  providerId: string,
  sample: TtsVoiceTimingCalibration,
): Promise<TtsVoiceTimingCalibration> {
  if (isProviderDatabaseConfigured()) {
    const aggregate = await providerPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider:tts:${providerId}`}))::text`;
      const row = await tx.providerCredential.findFirst({ where: { ownerId: null, name: 'tts', provider: providerId } });
      const entry = row ? providerRowToEntry(row) : { apiKey: '' };
      const calibrations = entry.timingCalibrations ?? [];
      const key = getTtsCalibrationKey(sample);
      const merged = mergeTtsVoiceTimingCalibrations(calibrations.find((item) => getTtsCalibrationKey(item) === key), sample);
      const config = providerConfigJson({ ...entry, timingCalibrations: [...calibrations.filter((item) => getTtsCalibrationKey(item) !== key), merged] }, row?.config);
      if (row) await tx.providerCredential.update({ where: { id: row.id }, data: { config } });
      else await tx.providerCredential.create({ data: { ownerId: null, name: 'tts', provider: providerId, secret: '', config, status: 'ACTIVE' } });
      return merged;
    });
    await initializeServerProviderConfig();
    return aggregate;
  }

  return withProviderConfigWrite(async () => {
    const data = await readYaml();
    data.tts ??= {};
    const existingEntry = data.tts[providerId] ?? {};
    const calibrations = existingEntry.timingCalibrations ?? [];
    const key = getTtsCalibrationKey(sample);
    const existing = calibrations.find((item) => getTtsCalibrationKey(item) === key);
    const aggregate = mergeTtsVoiceTimingCalibrations(existing, sample);
    data.tts[providerId] = {
      ...existingEntry,
      apiKey: existingEntry.apiKey || '',
      timingCalibrations: [
        ...calibrations.filter((item) => getTtsCalibrationKey(item) !== key),
        aggregate,
      ],
    };
    await writeYaml(data);
    return aggregate;
  });
}

/** 清除 OpenMAIC 进程级 Provider 配置缓存。 */
function invalidateProviderConfigCache(): void {
  clearServerProviderConfigCache();
}

export async function saveProviderEntry(
  section: ProviderSection,
  providerId: string,
  entry: ProviderEntry,
): Promise<void> {
  entry = normalizeManagedProviderCatalog(section, providerId, entry);
  if (isProviderDatabaseConfigured()) {
    await providerPrisma.$transaction(async (tx) => {
      // NULL ownerId is not covered by PostgreSQL's composite uniqueness.
      // Serialize global settings across processes, including first insertion.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider:${section}:${providerId}`}))::text`;
      const existing = await tx.providerCredential.findFirst({ where: { ownerId: null, name: section, provider: providerId } });
      const apiKey = entry.apiKey || (existing ? decodeProviderSecret(existing.secret, `${section}:${providerId}`) : '');
      const data = { secret: encodeProviderSecret(apiKey, `${section}:${providerId}`), config: providerConfigJson(entry, existing?.config), status: 'ACTIVE' };
      if (existing) await tx.providerCredential.update({ where: { id: existing.id }, data });
      else await tx.providerCredential.create({ data: { ownerId: null, name: section, provider: providerId, ...data } });
    });
    await initializeServerProviderConfig();
    return;
  }
  await withProviderConfigWrite(async () => {
    const data = await readYaml();
    const sectionKey = section === 'web-search' ? 'web-search' : section;
    if (!data[sectionKey]) data[sectionKey] = {};
    const existing = data[sectionKey]![providerId] ?? {};
    // 空输入表示保留已存 API key；只有传入非空值时才替换。
    const apiKey = entry.apiKey || existing.apiKey || '';
    data[sectionKey]![providerId] = {
      apiKey,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
      ...(entry.models && entry.models.length > 0
        ? { models: entry.models }
        : existing.models && existing.models.length > 0
          ? { models: existing.models }
          : {}),
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : existing.enabled !== undefined ? { enabled: existing.enabled } : {}),
      ...(typeof entry.priority === 'number'
        ? { priority: entry.priority }
        : typeof existing.priority === 'number'
          ? { priority: existing.priority }
          : {}),
      ...(entry.defaultModel
        ? { defaultModel: entry.defaultModel }
        : existing.defaultModel
          ? { defaultModel: existing.defaultModel }
          : {}),
      ...(entry.thinkingScenarioConfigs
        ? { thinkingScenarioConfigs: entry.thinkingScenarioConfigs }
        : existing.thinkingScenarioConfigs
          ? { thinkingScenarioConfigs: existing.thinkingScenarioConfigs }
          : {}),
      ...(entry.defaultVoice
        ? { defaultVoice: entry.defaultVoice }
        : existing.defaultVoice
          ? { defaultVoice: existing.defaultVoice }
          : {}),
      ...(entry.scenarioConfigs
        ? { scenarioConfigs: entry.scenarioConfigs }
        : existing.scenarioConfigs
          ? { scenarioConfigs: existing.scenarioConfigs }
          : {}),
      ...(entry.timingCalibrations
        ? { timingCalibrations: entry.timingCalibrations }
        : existing.timingCalibrations
          ? { timingCalibrations: existing.timingCalibrations }
          : {}),
    };
    await writeYaml(data);
  });
}

export async function deleteProviderEntry(
  section: ProviderSection,
  providerId: string,
): Promise<void> {
  if (isProviderDatabaseConfigured()) {
    await providerPrisma.providerCredential.deleteMany({ where: { ownerId: null, name: section, provider: providerId } });
    await initializeServerProviderConfig();
    return;
  }
  await withProviderConfigWrite(async () => {
    const data = await readYaml();
    const sectionKey = section === 'web-search' ? 'web-search' : section;
    if (!data[sectionKey]) return;
    delete data[sectionKey]![providerId];
    // Remove an empty section to keep the YAML compact.
    if (Object.keys(data[sectionKey]!).length === 0) {
      delete data[sectionKey];
    }
    await writeYaml(data);
  });
}

export async function getProviderEntry(
  section: ProviderSection,
  providerId: string,
): Promise<ProviderEntry | null> {
  if (isProviderDatabaseConfigured()) {
    const row = await providerPrisma.providerCredential.findFirst({
      where: { ownerId: null, name: section, provider: providerId, status: 'ACTIVE' },
    });
    return row
      ? normalizeManagedProviderCatalog(section, providerId, providerRowToEntry(row))
      : null;
  }
  await ensureMigratedInternal();
  const data = await readYaml();
  const sectionKey = section === 'web-search' ? 'web-search' : section;
  const entry = data[sectionKey]?.[providerId];
  if (!entry) return null;
  return normalizeManagedProviderCatalog(section, providerId, {
    apiKey: entry.apiKey || '',
    baseUrl: entry.baseUrl,
    models: entry.models,
    enabled: entry.enabled,
    priority: typeof entry.priority === 'number' ? entry.priority : undefined,
    defaultModel: entry.defaultModel,
    thinkingScenarioConfigs: entry.thinkingScenarioConfigs,
    defaultVoice: entry.defaultVoice,
    scenarioConfigs: entry.scenarioConfigs,
    timingCalibrations: entry.timingCalibrations,
  });
}

export async function listProviders(
  section: ProviderSection,
): Promise<Record<string, ProviderEntry>> {
  if (isProviderDatabaseConfigured()) {
    const rows = await providerPrisma.providerCredential.findMany({
      where: { ownerId: null, name: section, status: 'ACTIVE' },
      orderBy: { provider: 'asc' },
    });
    return Object.fromEntries(rows.map((row) => [
      row.provider,
      normalizeManagedProviderCatalog(section, row.provider, providerRowToEntry(row)),
    ]));
  }
  await ensureMigratedInternal();
  const data = await readYaml();
  const sectionKey = section === 'web-search' ? 'web-search' : section;
  const sectionData = data[sectionKey] ?? {};
  const result: Record<string, ProviderEntry> = {};
  for (const [id, entry] of Object.entries(sectionData)) {
    if (!entry) continue;
    result[id] = normalizeManagedProviderCatalog(section, id, {
      apiKey: entry.apiKey || '',
      baseUrl: entry.baseUrl,
      models: entry.models,
      enabled: entry.enabled,
      priority: typeof entry.priority === 'number' ? entry.priority : undefined,
      defaultModel: entry.defaultModel,
      thinkingScenarioConfigs: entry.thinkingScenarioConfigs,
      defaultVoice: entry.defaultVoice,
      scenarioConfigs: entry.scenarioConfigs,
      timingCalibrations: entry.timingCalibrations,
    });
  }
  return result;
}

function providerConfigJson(
  entry: ProviderEntry,
  existing: Prisma.JsonValue | null | undefined,
): Prisma.InputJsonValue {
  const previous =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...previous,
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.models ? { models: entry.models } : {}),
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.thinkingScenarioConfigs
      ? { thinkingScenarioConfigs: entry.thinkingScenarioConfigs }
      : {}),
    ...(entry.defaultVoice ? { defaultVoice: entry.defaultVoice } : {}),
    ...(entry.scenarioConfigs ? { scenarioConfigs: entry.scenarioConfigs } : {}),
    ...(entry.timingCalibrations ? { timingCalibrations: entry.timingCalibrations } : {}),
  } as Prisma.InputJsonValue;
}

function providerRowToEntry(row: {
  name: string;
  provider: string;
  secret: string;
  config: Prisma.JsonValue | null;
}): ProviderEntry {
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {};
  return { ...(config as Omit<ProviderEntry, 'apiKey'>), apiKey: decodeProviderSecret(row.secret, `${row.name}:${row.provider}`) };
}

/**
 * 把旧版 .openpbl-data/ai-settings.json 迁移到
 * server-providers.yml 的 providers.openai，仅在 YAML 尚未配置密钥时执行。
 */
export async function migrateLegacySettings(): Promise<void> {
  const openaiEntry = await readProviderEntryRaw('providers', 'openai');
  if (openaiEntry?.apiKey) return;

  try {
    const legacyPath = path.join(process.cwd(), '.openpbl-data', 'ai-settings.json');
    const raw = await readFile(legacyPath, 'utf8');
    const legacy = JSON.parse(raw) as { endpoint?: string; model?: string; apiKey?: string };
    if (!legacy.apiKey) return;

    // 保留旧版自定义端点；官方 OpenAI 端点统一使用标准地址。
    const baseUrl =
      legacy.endpoint && legacy.endpoint !== 'https://api.openai.com/v1'
        ? legacy.endpoint
        : 'https://api.openai.com/v1';
    const models = legacy.model ? [legacy.model] : ['gpt-5.4-mini'];

    await saveProviderEntry('providers', 'openai', {
      apiKey: legacy.apiKey,
      baseUrl,
      models,
    });
  } catch {
    // 没有旧版配置时无需迁移。
  }
}

/** 读取原始 Provider 配置，不触发迁移，避免循环依赖。 */
async function readProviderEntryRaw(
  section: ProviderSection,
  providerId: string,
): Promise<ProviderEntry | null> {
  const data = await readYaml();
  const sectionKey = section === 'web-search' ? 'web-search' : section;
  const entry = data[sectionKey]?.[providerId];
  if (!entry) return null;
  return {
    apiKey: entry.apiKey || '',
    baseUrl: entry.baseUrl,
    models: entry.models,
    enabled: entry.enabled,
    priority: typeof entry.priority === 'number' ? entry.priority : undefined,
    defaultModel: entry.defaultModel,
    thinkingScenarioConfigs: entry.thinkingScenarioConfigs,
    defaultVoice: entry.defaultVoice,
    scenarioConfigs: entry.scenarioConfigs,
    timingCalibrations: entry.timingCalibrations,
  };
}

let _migrated = false;
async function ensureMigratedInternal(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  try {
    await migrateLegacySettings();
  } catch {
    // 旧配置迁移失败不应阻止当前配置读取。
  }
}

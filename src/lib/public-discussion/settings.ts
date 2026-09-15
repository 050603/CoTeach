import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { ASR_PROVIDERS, TTS_PROVIDERS } from "@openmaic/lib/audio/constants";
import { getServerASRProviders, getServerTTSProviders } from "@openmaic/lib/server/provider-config";
import type { PublicDiscussionSettings } from "./types";

const NAME = "public-discussion";
const PROVIDER = "runtime";

function optionalText(value: unknown, max = 240): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

export function sanitizePublicDiscussionSettings(value: unknown): PublicDiscussionSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const speed = Number(record.ttsSpeed);
  return {
    modelString: optionalText(record.modelString),
    asrProviderId: optionalText(record.asrProviderId, 80),
    asrModelId: optionalText(record.asrModelId),
    asrLanguage: optionalText(record.asrLanguage, 32) ?? "zh",
    ttsProviderId: optionalText(record.ttsProviderId, 80),
    ttsModelId: optionalText(record.ttsModelId),
    ttsVoice: optionalText(record.ttsVoice),
    ttsSpeed: Number.isFinite(speed) ? Math.max(0.7, Math.min(1.3, speed)) : 1,
  };
}

function defaultAsr(): Pick<PublicDiscussionSettings, "asrProviderId" | "asrModelId"> {
  const configured = getServerASRProviders();
  const [providerId, metadata] = Object.entries(configured)[0] ?? [];
  if (!providerId) return {};
  const registry = ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS];
  return {
    asrProviderId: providerId,
    asrModelId: metadata.defaultModel ?? metadata.models?.[0] ?? registry?.defaultModelId,
  };
}

function defaultTts(): Pick<PublicDiscussionSettings, "ttsProviderId" | "ttsModelId" | "ttsVoice"> {
  const configured = getServerTTSProviders();
  const entry = Object.entries(configured).find(([, metadata]) => !metadata.disabled);
  if (!entry) return {};
  const [providerId, metadata] = entry;
  const registry = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const voice = metadata.defaultVoice ?? registry?.voices?.[0]?.id;
  if (!voice) return {};
  return {
    ttsProviderId: providerId,
    ttsModelId: metadata.defaultModel ?? metadata.models?.[0] ?? registry?.defaultModelId,
    ttsVoice: voice,
  };
}

export async function getPublicDiscussionSettings(): Promise<PublicDiscussionSettings> {
  const row = await prisma.providerCredential.findFirst({
    where: { ownerId: null, name: NAME, provider: PROVIDER },
    select: { config: true },
  });
  const configured = sanitizePublicDiscussionSettings(row?.config);
  const asrFallback = defaultAsr();
  const ttsFallback = defaultTts();
  return {
    ...configured,
    asrProviderId: configured.asrProviderId ?? asrFallback.asrProviderId,
    asrModelId: configured.asrModelId ?? asrFallback.asrModelId,
    ttsProviderId: configured.ttsProviderId ?? ttsFallback.ttsProviderId,
    ttsModelId: configured.ttsModelId ?? ttsFallback.ttsModelId,
    ttsVoice: configured.ttsVoice ?? ttsFallback.ttsVoice,
  };
}

export async function savePublicDiscussionSettings(input: unknown): Promise<PublicDiscussionSettings> {
  const settings = sanitizePublicDiscussionSettings(input);
  await runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${NAME}:${PROVIDER}`}, 0))::text`;
    const current = await tx.providerCredential.findFirst({
      where: { ownerId: null, name: NAME, provider: PROVIDER },
    });
    if (current) {
      await tx.providerCredential.update({
        where: { id: current.id },
        data: { config: settings as unknown as Prisma.InputJsonValue },
      });
    } else {
      await tx.providerCredential.create({
        data: {
          ownerId: null,
          name: NAME,
          provider: PROVIDER,
          secret: "",
          config: settings as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
  return getPublicDiscussionSettings();
}

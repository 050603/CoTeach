import { z } from "zod";
import {
  deleteProviderEntry,
  getProviderEntry,
  type ProviderEntry,
  listProviders,
  saveProviderEntry,
} from "@/lib/openmaic-bridge/provider-config-editor";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { validateUrlForSSRF } from "@/lib/openmaic/server/ssrf-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SectionSchema = z.enum([
  "providers",
  "tts",
  "asr",
  "pdf",
  "image",
  "video",
  "web-search",
]);
const ProviderIdSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const TtsScenarioConfigSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  voiceId: z.string().trim().min(1).max(200),
}).strict();
const ThinkingScenarioPresetSchema = z.enum([
  "baseline",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ThinkingScenarioConfigsSchema = z.object({
  "course-planning": ThinkingScenarioPresetSchema.optional(),
  "content-generation": ThinkingScenarioPresetSchema.optional(),
  "learning-assessment": ThinkingScenarioPresetSchema.optional(),
  "classroom-interaction": ThinkingScenarioPresetSchema.optional(),
  "ai-copilot": ThinkingScenarioPresetSchema.optional(),
  "search-understanding": ThinkingScenarioPresetSchema.optional(),
}).strict();
const SaveSchema = z.object({
  section: SectionSchema,
  providerId: ProviderIdSchema,
  apiKey: z.string().max(8_192).optional(),
  baseUrl: z.string().url().max(2_048).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  enabled: z.boolean().optional(),
  defaultModel: z.string().trim().max(200).optional(),
  thinkingScenarioConfigs: ThinkingScenarioConfigsSchema.optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  defaultVoice: z.string().trim().max(200).optional(),
  scenarioConfigs: z.object({
    "course-generation": TtsScenarioConfigSchema.optional(),
    "realtime-interaction": TtsScenarioConfigSchema.optional(),
  }).strict().optional(),
  timingCalibrations: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
}).strict();
const DeleteSchema = z.object({
  section: SectionSchema,
  providerId: ProviderIdSchema,
}).strict();

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const section = SectionSchema.safeParse(new URL(request.url).searchParams.get("section") ?? "providers");
  if (!section.success) return apiError(request, "INVALID_SECTION", "Provider section is invalid.", 400);
  const providers = await listProviders(section.data);
  return Response.json({
    section: section.data,
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, entry]) => [
        id,
        publicEntry(entry),
      ]),
    ),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const parsed = SaveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(request, "INVALID_PROVIDER", "Provider configuration is invalid.", 400);
  if (parsed.data.baseUrl) {
    const ssrfError = await validateUrlForSSRF(parsed.data.baseUrl);
    if (ssrfError) return apiError(request, "INVALID_PROVIDER_URL", "Provider URL is not allowed.", 400);
  }
  await saveProviderEntry(parsed.data.section, parsed.data.providerId, {
    ...parsed.data,
    timingCalibrations: parsed.data.timingCalibrations as never,
    apiKey: parsed.data.apiKey ?? "",
  });
  const saved = await getProviderEntry(parsed.data.section, parsed.data.providerId);
  if (!saved) return apiError(request, "PROVIDER_SAVE_UNCONFIRMED", "配置保存后未能读取，请重试。", 503);
  return Response.json({ ok: true, section: parsed.data.section, providerId: parsed.data.providerId, provider: publicEntry(saved) }, { headers: { "Cache-Control": "private, no-store" } });
}

function publicEntry(entry: ProviderEntry) {
  return { hasApiKey: Boolean(entry.apiKey), baseUrl: entry.baseUrl, models: entry.models,
    enabled: entry.enabled, defaultModel: entry.defaultModel, priority: entry.priority,
    thinkingScenarioConfigs: entry.thinkingScenarioConfigs,
    defaultVoice: entry.defaultVoice, scenarioConfigs: entry.scenarioConfigs,
    timingCalibrations: entry.timingCalibrations };
}

export async function DELETE(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const parsed = DeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(request, "INVALID_PROVIDER", "Provider configuration is invalid.", 400);
  await deleteProviderEntry(parsed.data.section, parsed.data.providerId);
  return Response.json({ ok: true });
}

function apiError(request: Request, code: string, message: string, status: number): Response {
  return Response.json(
    { code, message, requestId: request.headers.get("x-request-id") ?? "unknown" },
    { status },
  );
}

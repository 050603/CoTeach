import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { transcribeAudio } from "@openmaic/lib/audio/asr-providers";
import { ASR_PROVIDERS } from "@openmaic/lib/audio/constants";
import type { ASRProviderId } from "@openmaic/lib/audio/types";
import { resolveASRApiKey, resolveASRBaseUrl } from "@openmaic/lib/server/provider-config";
import {
  beginTranscription,
  finishTranscription,
  isPublicDiscussionEnabled,
  PublicDiscussionError,
} from "@/lib/public-discussion/service";
import { getPublicDiscussionSettings } from "@/lib/public-discussion/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  if (!isPublicDiscussionEnabled()) return new Response(null, { status: 404 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "write"))) {
    return Response.json({ code: "COURSE_LOCKED", message: "课堂当前不允许发言。" }, { status: 403 });
  }
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  const requestId = form?.get("requestId");
  const expectedVersion = Number(form?.get("expectedVersion"));
  if (
    !(audio instanceof File)
    || audio.size < 1
    || audio.size > 20 * 1024 * 1024
    || typeof requestId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(requestId)
    || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 1
  ) {
    return Response.json({ code: "INVALID_AUDIO", message: "录音文件或讨论版本无效。" }, { status: 400 });
  }
  let generation: Awaited<ReturnType<typeof beginTranscription>> | undefined;
  try {
    generation = await beginTranscription({
      courseId,
      claims: auth.claims,
      requestId,
      expectedVersion,
    });
    const settings = await getPublicDiscussionSettings();
    const providerId = settings.asrProviderId;
    if (!providerId || providerId === "browser-native") {
      throw new PublicDiscussionError("ASR_NOT_CONFIGURED", "服务器尚未配置可用的语音识别服务。", 503);
    }
    const registry = ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS];
    const result = await transcribeAudio({
      providerId: providerId as ASRProviderId,
      modelId: settings.asrModelId ?? registry?.defaultModelId,
      language: settings.asrLanguage,
      apiKey: resolveASRApiKey(providerId),
      baseUrl: resolveASRBaseUrl(providerId),
    }, audio);
    const text = result.text.trim().slice(0, 3_000);
    const snapshot = await finishTranscription({
      courseId,
      claims: auth.claims,
      requestId,
      sessionId: generation.sessionId,
      generationVersion: generation.generationVersion,
      success: Boolean(text),
    });
    if (!text) return Response.json({ code: "NO_SPEECH", message: "没有识别到清晰语音，请重录或改用文字。", snapshot }, { status: 422 });
    return Response.json({ text, snapshot });
  } catch (error) {
    if (generation) {
      await finishTranscription({
        courseId,
        claims: auth.claims,
        requestId,
        sessionId: generation.sessionId,
        generationVersion: generation.generationVersion,
        success: false,
      }).catch(() => undefined);
    }
    if (error instanceof PublicDiscussionError) {
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[public-discussion] transcription failed", error);
    return Response.json({ code: "TRANSCRIPTION_FAILED", message: "语音识别失败，请重录或改用文字。" }, { status: 502 });
  }
}

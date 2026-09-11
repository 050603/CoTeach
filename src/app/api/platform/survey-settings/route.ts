import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { getSurveyKeywordSettings, saveSurveyKeywordSettings } from "@/lib/platform/survey-keyword-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SettingsSchema = z.object({ mode: z.enum(["local", "llm"]) }).strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return noStore(auth.response);
  try {
    return noStore(Response.json(await getSurveyKeywordSettings(auth.claims.sub!)));
  } catch {
    return noStore(jsonError(request, "SURVEY_SETTINGS_UNAVAILABLE", "暂时无法读取问卷分析设置，请重试。", 503));
  }
}

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return noStore(csrf);
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return noStore(auth.response);
  const parsed = SettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return noStore(jsonError(request, "INVALID_SURVEY_SETTINGS", "请选择本地分词或大模型分析。", 400));
  try {
    return noStore(Response.json(await saveSurveyKeywordSettings(auth.claims.sub!, parsed.data.mode)));
  } catch {
    return noStore(jsonError(request, "SURVEY_SETTINGS_SAVE_FAILED", "问卷分析设置保存失败，请重试。", 503));
  }
}

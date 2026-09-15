import { after } from "next/server";
import { populateSurveyTerms } from "@/lib/platform/survey-terms";
import { getSurveyKeywordSettings } from "@/lib/platform/survey-keyword-settings";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { getSurveyAnalytics, PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try {
    const result = await getSurveyAnalytics(auth.claims, (await context.params).activityId);
    try {
      const { mode } = await getSurveyKeywordSettings(auth.claims.sub!);
      await populateSurveyTerms(result.activity.id, result.analytics.questions, after, 500, mode);
    } catch {
      // Keyword enrichment must not hide the saved answers and response counts.
      for (const question of result.analytics.questions) {
        if (question.type !== "short-text") continue;
        question.terms = [];
        question.keywordStatus = question.responses.length ? "unavailable" : "ready";
        question.keywordAnalyzedCount = 0;
        question.keywordRepresentedCount = 0;
        question.keywordUnrepresentedResponses = question.responses.map(({ studentId }) => ({ studentId, reason: "analysis-unavailable" }));
      }
      console.warn("[survey-results] Keyword enrichment unavailable; returning saved survey responses.");
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "SURVEY_RESULTS_UNAVAILABLE", "暂时无法加载问卷数据", 503);
  }
}

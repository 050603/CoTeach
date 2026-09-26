/** A malformed model response must never become a fabricated score. */
export function parseQuizGradeResponse(raw: string, points: number): { score: number; comment: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("QUIZ_GRADE_INVALID_RESPONSE");
  const parsed = JSON.parse(match[0]) as { score?: unknown; comment?: unknown };
  if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)
    || parsed.score < 0 || parsed.score > points) {
    throw new Error("QUIZ_GRADE_INVALID_SCORE");
  }
  return {
    score: parsed.score,
    comment: typeof parsed.comment === "string" ? parsed.comment.trim().slice(0, 1_500) : "",
  };
}

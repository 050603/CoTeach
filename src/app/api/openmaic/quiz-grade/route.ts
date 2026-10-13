/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@openmaic/lib/ai/llm';
import { createLogger } from '@openmaic/lib/logger';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { resolveModelFromRequest } from '@openmaic/lib/server/resolve-model';
import { buildPromptQualityContract } from '@/lib/prompt-quality/policy';
import { parseQuizGradeResponse } from '@openmaic/lib/quiz/grade-response';
import { parseStructuredGrade, structuredGradePrompt, validScoringRubric } from '@openmaic/lib/quiz/rubric';
import type { QuizScoringRubric } from '@openmaic/dsl';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
  referenceAnswer?: string;
  scoringRubric?: QuizScoringRubric;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language, referenceAnswer, scoringRubric } = body;
    questionSnippet = question?.substring(0, 60);
    resolvedPoints = points;

    if (!question || !userAnswer) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }
    if (scoringRubric !== undefined && !validScoringRubric(scoringRubric)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid scoring rubric');
    }

    // Resolve model from request headers/body
    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'quiz-grade',
    );

    const isZh = language === 'zh-CN';

    const qualityContract = buildPromptQualityContract({
      mode: 'json',
      audience: 'student',
      language: isZh ? 'zh-CN' : 'inherit',
    });
    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
评分只能依据题目、满分、明确给出的评分要点和学生答案。没有提供评分要点时，应按答案的准确性、相关性、完整性和推理质量谨慎评分，不得猜测学生未写出的思路。
评语先指出一项有证据支持的表现，再给出一项最重要、可执行的改进建议；答案为空时应明确说明未作答。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}之间的数字，可保留两位小数>, "comment": "<一两句评语>"}

${qualityContract}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
Base the score only on the question, maximum score, supplied grading guidance, and the student's actual answer. Do not infer reasoning that was not written. Give one evidence-based strength and one actionable improvement; explicitly identify an empty answer as unanswered.
You must reply in the following JSON format only (no other content):
{"score": <number from 0 to ${points}, up to two decimal places>, "comment": "<one or two sentences of feedback>"}

${qualityContract}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    const structured = scoringRubric ? structuredGradePrompt({ question, answer: userAnswer, points,
      rubric: scoringRubric, referenceAnswer }) : undefined;
    const result = await callLLM(
      {
        model: languageModel,
        abortSignal: req.signal,
        system: structured ? `${structured.system}\n${qualityContract}` : systemPrompt,
        prompt: structured?.prompt ?? userPrompt,
      },
      'quiz-grade',
      undefined,
      thinkingConfig,
    );

    const gradeResult = scoringRubric ? parseStructuredGrade(result.text.trim(), points, scoringRubric, userAnswer)
      : parseQuizGradeResponse(result.text.trim(), points);
    return apiSuccess({ ...gradeResult });
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}

import { describe, expect, it } from 'vitest';
import {
  buildPblTimingInputFromScene,
  estimatePblActivityTime,
  planPblPageTiming,
  estimateQuizPageDurationSec,
} from './pbl-time-estimation';

describe('PBL activity time estimation', () => {
  it('derives a missing quiz duration from question demand rather than a generic 300 seconds', () => {
    const quiz = { questionCount: 1, questionTypes: ['single' as const], difficulty: 'introductory' as const };
    const duration = estimateQuizPageDurationSec(quiz);
    const plan = planPblPageTiming({ activityTargetSec: duration, pageKind: 'quiz', quiz });
    expect(duration).toBeLessThan(120);
    expect(plan.taskFitsBudget).toBe(true);
    expect(plan.studentActivitySec).toBeGreaterThanOrEqual(plan.recommendedStudentActivitySec);
    expect(plan.narrationSec + plan.studentActivitySec + plan.transitionSec).toBe(duration);
  });

  it('gives extra confirmed quiz time to students without extending spoken feedback', () => {
    const quiz = { questionCount: 1, questionTypes: ['single' as const], difficulty: 'introductory' as const };
    const short = planPblPageTiming({ activityTargetSec: 90, pageKind: 'quiz', quiz });
    const long = planPblPageTiming({ activityTargetSec: 300, pageKind: 'quiz', quiz });
    expect(long.narrationSec).toBe(short.narrationSec);
    expect(long.feedbackSec).toBe(short.feedbackSec);
    expect(long.readingThinkingSec).toBeGreaterThan(short.readingThinkingSec);
    expect(long.operationSec).toBe(short.operationSec);
    expect(long.narrationSec + long.studentActivitySec + long.transitionSec).toBe(300);
  });

  it('allocates more feedback to more complex questions while marking undersized budgets honestly', () => {
    const easy = { questionCount: 1, questionTypes: ['single' as const], difficulty: 'introductory' as const };
    const complex = { questionCount: 3, questionTypes: ['short_answer' as const, 'scenario_task' as const], difficulty: 'advanced' as const };
    const simple = planPblPageTiming({ activityTargetSec: estimateQuizPageDurationSec(easy), pageKind: 'quiz', quiz: easy });
    const written = planPblPageTiming({ activityTargetSec: estimateQuizPageDurationSec(complex), pageKind: 'quiz', quiz: complex });
    expect(written.feedbackSec).toBeGreaterThan(simple.feedbackSec);
    expect(written.studentActivitySec).toBeGreaterThan(simple.studentActivitySec);
    expect(written.taskFitsBudget).toBe(true);
    const cramped = planPblPageTiming({ activityTargetSec: 30, pageKind: 'quiz', quiz: complex });
    expect(cramped.taskFitsBudget).toBe(false);
    expect(cramped.narrationSec + cramped.studentActivitySec + cramped.transitionSec).toBe(30);
  });
  it('estimates theory narration from static TTS parameters and includes transition time', () => {
    const estimate = estimatePblActivityTime({
      id: 'theory-1',
      stageKey: 'ai-learning',
      activityKind: 'knowledge',
      contentType: 'theory',
      speechText: 'Understand the relationship between variables, functions, and input/output. '.repeat(8),
      targetDurationSec: 300,
      tts: { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', speed: 1, language: 'zh-CN' },
    });

    expect(estimate.ttsSec).toBeGreaterThan(10);
    expect(estimate.transitionSec).toBeGreaterThan(0);
    expect(estimate.totalSec).toBeGreaterThan(estimate.ttsSec);
  });

  it('models case analysis interaction separately from spoken explanation', () => {
    const estimate = estimatePblActivityTime({
      id: 'case-1',
      stageKey: 'proposal',
      activityKind: 'proposal',
      contentType: 'case-analysis',
      speechText: 'Read the case, compare evidence, and make a judgment. '.repeat(5),
      interaction: { type: 'case-analysis', stepCount: 3, difficulty: 'advanced' },
    });

    expect(estimate.interactionSec).toBeGreaterThan(estimate.ttsSec);
    expect(estimate.recommendations.length).toBeGreaterThan(0);
  });

  it('covers technical explanations with a slower static model', () => {
    const estimate = estimatePblActivityTime({
      id: 'technical-1',
      stageKey: 'make',
      activityKind: 'practice',
      contentType: 'technical-explanation',
      speechText: 'First configure the environment, then run tests, and finally verify the fix. '.repeat(10),
      tts: { providerId: 'voxcpm-tts', modelId: 'voxcpm2', speed: 1, language: 'zh-CN' },
    });
    expect(estimate.ttsSec).toBeGreaterThan(10);
    expect(estimate.recommendations.length).toBeGreaterThan(0);
  });

  it('estimates quiz time from question count, type, and difficulty', () => {
    const estimate = estimatePblActivityTime({
      id: 'quiz-1',
      stageKey: 'ai-learning',
      activityKind: 'knowledge',
      contentType: 'quiz',
      quiz: {
        questionCount: 4,
        questionTypes: ['single', 'multiple', 'short_answer'],
        difficulty: 'advanced',
      },
    });

    expect(estimate.quizSec).toBeGreaterThan(240);
    expect(estimate.totalSec).toBe(estimate.quizSec + estimate.teacherSec + estimate.transitionSec);
  });

  it('keeps teacher resources in the total without treating them as TTS', () => {
    const input = buildPblTimingInputFromScene({
      id: 'teacher-launch',
      title: 'Project launch',
      stageKey: 'launch',
      audience: 'teacher',
      type: 'slide',
      targetDurationSec: 600,
    });

    const estimate = estimatePblActivityTime(input);
    expect(estimate.ttsSec).toBe(0);
    expect(estimate.teacherSec).toBe(600);
    expect(estimate.totalSec).toBe(600);
  });

  it('maps scene interactions to the same static model used by classroom generation', () => {
    const input = buildPblTimingInputFromScene({
      id: 'student-practice',
      title: 'Interactive practice',
      stageKey: 'ai-learning',
      audience: 'student',
      type: 'interactive',
      widgetType: 'simulation',
      widgetOutline: { steps: ['observe', 'compare', 'explain'] },
      targetDurationSec: 600,
      ttsPolicy: 'target-duration',
    }, 'Observe and explain the simulation result.');

    const estimate = estimatePblActivityTime(input);
    expect(input.interaction?.stepCount).toBe(3);
    expect(estimate.interactionSec).toBeGreaterThan(0);
    expect(estimate.ttsSec).toBeGreaterThan(0);
  });

  it('reserves only a few seconds for changing a slide page', () => {
    const plan = planPblPageTiming({
      activityTargetSec: 180,
      pageKind: 'slide',
      contentType: 'theory',
    });

    expect(plan.transitionSec).toBeGreaterThanOrEqual(3);
    expect(plan.transitionSec).toBeLessThanOrEqual(6);
    expect(plan.readingThinkingSec).toBe(0);
    expect(plan.operationSec).toBe(0);
    expect(plan.studentActivitySec).toBe(0);
    expect(plan.narrationSec + plan.transitionSec).toBe(180);
  });

  it('separates comprehension and hands-on time for an interactive task', () => {
    const plan = planPblPageTiming({
      activityTargetSec: 300,
      pageKind: 'interactive',
      contentType: 'interaction',
      interaction: {
        type: 'simulation',
        stepCount: 3,
        difficulty: 'advanced',
      },
    });

    expect(plan.readingThinkingSec).toBeGreaterThan(0);
    expect(plan.operationSec).toBeGreaterThan(0);
    expect(plan.studentActivitySec).toBe(plan.readingThinkingSec + plan.operationSec);
    expect(
      plan.narrationSec + plan.studentActivitySec + plan.transitionSec,
    ).toBe(300);
  });

  it('uses widget steps, interaction type, and difficulty to model task demand', () => {
    const simple = planPblPageTiming({
      activityTargetSec: 600,
      pageKind: 'interactive',
      interaction: {
        type: 'diagram',
        stepCount: 1,
        difficulty: 'introductory',
      },
    });
    const complex = planPblPageTiming({
      activityTargetSec: 600,
      pageKind: 'interactive',
      interaction: {
        type: 'code',
        stepCount: 3,
        difficulty: 'advanced',
      },
    });

    expect(complex.recommendedOperationSec).toBeGreaterThan(simple.recommendedOperationSec);
    expect(complex.recommendedStudentActivitySec).toBeGreaterThan(
      simple.recommendedStudentActivitySec,
    );
    expect(complex.taskComplexity).toBe('high');
  });

  it('uses question count, type, and difficulty to budget quiz work', () => {
    const quickCheck = planPblPageTiming({
      activityTargetSec: 600,
      pageKind: 'quiz',
      quiz: {
        questionCount: 1,
        questionTypes: ['true_false'],
        difficulty: 'introductory',
      },
    });
    const writtenReasoning = planPblPageTiming({
      activityTargetSec: 600,
      pageKind: 'quiz',
      quiz: {
        questionCount: 3,
        questionTypes: ['short_answer', 'scenario_task'],
        difficulty: 'advanced',
      },
    });

    expect(writtenReasoning.recommendedOperationSec).toBeGreaterThan(
      quickCheck.recommendedOperationSec,
    );
    expect(writtenReasoning.recommendedStudentActivitySec).toBeGreaterThan(
      quickCheck.recommendedStudentActivitySec,
    );
    expect(writtenReasoning.feedbackSec).toBeGreaterThan(0);
  });

  it('marks a task for simplification when its modeled work cannot fit the page', () => {
    const plan = planPblPageTiming({
      activityTargetSec: 90,
      pageKind: 'interactive',
      interaction: {
        type: 'code',
        stepCount: 5,
        difficulty: 'advanced',
      },
    });

    expect(plan.taskFitsBudget).toBe(false);
    expect(plan.recommendedStudentActivitySec).toBeGreaterThan(plan.studentActivitySec);
    expect(plan.rationale.join(' ')).toMatch(/simplif|fit/i);
    expect(
      plan.narrationSec + plan.studentActivitySec + plan.transitionSec,
    ).toBe(90);
  });
});

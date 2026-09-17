import {
  assessTtsDurationError,
  estimateSpeechDurationSec,
  getTtsTimingProfile,
} from './openmaic/audio/tts-timing';

export type PblActivityContentType =
  | 'theory'
  | 'case-analysis'
  | 'technical-explanation'
  | 'procedure'
  | 'quiz'
  | 'interaction'
  | 'reflection'
  | 'other';

export type PblDifficultyLevel = 'introductory' | 'standard' | 'advanced';

export type PblInteractionType =
  | 'simulation'
  | 'case-analysis'
  | 'discussion'
  | 'code'
  | 'diagram'
  | 'game'
  | 'custom';

export type PblQuizQuestionType = 'single' | 'multiple' | 'matching' | 'short_answer' | 'true_false' | 'fill_blank' | 'scenario_task';

export type PblPageKind = 'slide' | 'interactive' | 'quiz';

export type PblTaskComplexity = 'low' | 'medium' | 'high';

export type PblActivityTimingInput = {
  id: string;
  title?: string;
  stageKey?: string;
  activityKind?: string;
  contentType?: PblActivityContentType;
  speechText?: string;
  targetDurationSec?: number;
  tts?: {
    providerId?: string;
    modelId?: string;
    speed?: number;
    language?: string;
  };
  interaction?: {
    type: PblInteractionType;
    stepCount?: number;
    difficulty?: PblDifficultyLevel;
    averageCompletionSec?: number;
  };
  quiz?: {
    questionCount: number;
    questionTypes?: PblQuizQuestionType[];
    difficulty?: PblDifficultyLevel;
  };
  teacherSec?: number;
  transitionSec?: number;
};

export type PblActivityTimeEstimate = {
  id: string;
  title?: string;
  stageKey?: string;
  activityKind?: string;
  contentType: PblActivityContentType;
  ttsSec: number;
  interactionSec: number;
  quizSec: number;
  teacherSec: number;
  transitionSec: number;
  totalSec: number;
  recommendations: string[];
};

export type PblPageTimingInput = {
  activityTargetSec: number;
  pageKind?: PblPageKind;
  contentType?: PblActivityContentType;
  interaction?: PblActivityTimingInput['interaction'];
  quiz?: PblActivityTimingInput['quiz'];
};

export type PblPageTimingBreakdown = {
  pageKind: PblPageKind;
  contentType: PblActivityContentType;
  activityTargetSec: number;
  /** Natural-speed TTS guidance and feedback. */
  narrationSec: number;
  /** Silent time for reading instructions, interpreting evidence, and thinking. */
  readingThinkingSec: number;
  /** Silent time for manipulating, coding, selecting, writing, and submitting. */
  operationSec: number;
  /** readingThinkingSec + operationSec. */
  studentActivitySec: number;
  /** Part of narrationSec, not an additional time bucket. */
  feedbackSec: number;
  transitionSec: number;
  taskComplexity: PblTaskComplexity;
  recommendedReadingThinkingSec: number;
  recommendedOperationSec: number;
  recommendedStudentActivitySec: number;
  taskFitsBudget: boolean;
  rationale: string[];
};

export type PblSceneTimingSource = {
  id: string;
  title?: string;
  stageKey?: string;
  audience?: "student" | "teacher";
  ttsPolicy?: "none" | "target-duration";
  detailKind?: string;
  type?: "slide" | "quiz" | "interactive" | "pbl";
  widgetType?: string;
  widgetOutline?: unknown;
  quizConfig?: {
    questionCount?: number;
    difficulty?: string;
    questionTypes?: PblQuizQuestionType[];
  };
  description?: string;
  keyPoints?: ReadonlyArray<string>;
  estimatedDuration?: number;
  targetDurationSec?: number;
  timingPlan?: {
    contentType?: string;
    activityTargetDurationSec?: number;
    targetDurationSec?: number;
    providerId?: string;
    modelId?: string;
    speed?: number;
    language?: string;
  };
};

const DIFFICULTY_FACTOR: Record<PblDifficultyLevel, number> = {
  introductory: 0.8,
  standard: 1,
  advanced: 1.3,
};

const INTERACTION_SECONDS_PER_STEP: Record<PblInteractionType, number> = {
  simulation: 50,
  'case-analysis': 65,
  discussion: 60,
  code: 90,
  diagram: 45,
  game: 55,
  custom: 60,
};

const QUIZ_SECONDS_PER_QUESTION: Record<PblQuizQuestionType, number> = {
  single: 45,
  multiple: 65,
  matching: 55,
  short_answer: 120,
  true_false: 35,
  fill_blank: 55,
  scenario_task: 150,
};

const INTERACTION_READING_THINKING_SECONDS: Record<PblInteractionType, number> = {
  simulation: 25,
  'case-analysis': 45,
  discussion: 45,
  code: 35,
  diagram: 20,
  game: 25,
  custom: 30,
};

const QUIZ_READING_THINKING_SECONDS: Record<PblQuizQuestionType, number> = {
  single: 35,
  multiple: 45,
  matching: 40,
  short_answer: 55,
  true_false: 25,
  fill_blank: 30,
  scenario_task: 90,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number): number {
  return Math.max(0, Math.round(value));
}

function difficultyFactor(level?: PblDifficultyLevel): number {
  return DIFFICULTY_FACTOR[level ?? 'standard'];
}

function inferContentType(input: PblActivityTimingInput): PblActivityContentType {
  if (input.contentType) return input.contentType;
  if (input.quiz) return 'quiz';
  if (input.interaction?.type === 'case-analysis') return 'case-analysis';
  if (input.interaction) return 'interaction';
  const value = `${input.title ?? ''} ${input.activityKind ?? ''}`.toLowerCase();
  if (/case|案例|情境|分析/.test(value)) return 'case-analysis';
  if (/technical|技术|代码|编程|实现|procedure|步骤/.test(value)) return 'technical-explanation';
  if (/reflection|反思|迁移/.test(value)) return 'reflection';
  return 'theory';
}

function estimateInteractionSec(input: PblActivityTimingInput): number {
  if (!input.interaction) return 0;
  const stepCount = clamp(Math.round(input.interaction.stepCount ?? 1), 1, 30);
  const averageCompletionSec = Number(input.interaction.averageCompletionSec);
  const perStep = Number.isFinite(averageCompletionSec) && averageCompletionSec > 0
    ? averageCompletionSec
    : INTERACTION_SECONDS_PER_STEP[input.interaction.type];
  const orientationSec = input.interaction.type === 'case-analysis' ? 45 : 30;
  return roundSeconds(
    (orientationSec + perStep * stepCount) * difficultyFactor(input.interaction.difficulty),
  );
}

function estimateQuizSec(input: PblActivityTimingInput): number {
  if (!input.quiz) return 0;
  const questionCount = clamp(Math.round(input.quiz.questionCount), 0, 100);
  if (questionCount === 0) return 0;
  const types = input.quiz.questionTypes?.length
    ? input.quiz.questionTypes
    : (['single'] as PblQuizQuestionType[]);
  const questionSeconds = Array.from({ length: questionCount }, (_, index) => (
    QUIZ_SECONDS_PER_QUESTION[types[index % types.length] ?? 'single']
  ));
  return roundSeconds(
    (15 + questionSeconds.reduce((sum, seconds) => sum + seconds, 0))
      * difficultyFactor(input.quiz.difficulty),
  );
}

function inferPageKind(input: PblPageTimingInput): PblPageKind {
  if (input.pageKind) return input.pageKind;
  if (input.quiz) return 'quiz';
  if (input.interaction) return 'interactive';
  return 'slide';
}

function pageTransitionSec(pageKind: PblPageKind, activityTargetSec: number): number {
  const desired = pageKind === 'slide'
    ? clamp(Math.round(activityTargetSec * 0.02), 3, 6)
    : clamp(Math.round(activityTargetSec * 0.025), 5, 10);
  return Math.min(Math.max(0, activityTargetSec - 1), desired);
}

function interactiveTaskDemand(
  interaction: NonNullable<PblPageTimingInput['interaction']>,
): {
  readingThinkingSec: number;
  operationSec: number;
} {
  const stepCount = clamp(Math.round(interaction.stepCount ?? 1), 1, 30);
  const factor = difficultyFactor(interaction.difficulty);
  const configuredOperationSec = Number(interaction.averageCompletionSec);
  const operationPerStep = Number.isFinite(configuredOperationSec) && configuredOperationSec > 0
    ? configuredOperationSec
    : INTERACTION_SECONDS_PER_STEP[interaction.type];
  return {
    readingThinkingSec: roundSeconds(
      INTERACTION_READING_THINKING_SECONDS[interaction.type] * factor,
    ),
    operationSec: roundSeconds(operationPerStep * stepCount * factor),
  };
}

function quizTaskDemand(
  quiz: NonNullable<PblPageTimingInput['quiz']>,
): {
  readingThinkingSec: number;
  operationSec: number;
} {
  const questionCount = clamp(Math.round(quiz.questionCount), 0, 100);
  if (questionCount === 0) {
    return { readingThinkingSec: 0, operationSec: 0 };
  }
  const types = quiz.questionTypes?.length
    ? quiz.questionTypes
    : (['single'] as PblQuizQuestionType[]);
  const factor = difficultyFactor(quiz.difficulty);
  let readingThinkingSec = 15;
  let operationSec = 0;
  for (let index = 0; index < questionCount; index += 1) {
    const type = types[index % types.length] ?? 'single';
    const totalSec = QUIZ_SECONDS_PER_QUESTION[type];
    const readingSec = QUIZ_READING_THINKING_SECONDS[type];
    readingThinkingSec += readingSec;
    operationSec += Math.max(0, totalSec - readingSec);
  }
  return {
    readingThinkingSec: roundSeconds(readingThinkingSec * factor),
    operationSec: roundSeconds(operationSec * factor),
  };
}

function taskComplexityForSeconds(seconds: number): PblTaskComplexity {
  if (seconds <= 75) return 'low';
  if (seconds <= 210) return 'medium';
  return 'high';
}

function allocateStudentTime(options: {
  availableSec: number;
  recommendedReadingThinkingSec: number;
  recommendedOperationSec: number;
}): {
  readingThinkingSec: number;
  operationSec: number;
} {
  const availableSec = Math.max(0, Math.round(options.availableSec));
  const recommendedTotal = (
    options.recommendedReadingThinkingSec + options.recommendedOperationSec
  );
  if (recommendedTotal <= availableSec) {
    return {
      readingThinkingSec: options.recommendedReadingThinkingSec,
      operationSec: options.recommendedOperationSec,
    };
  }
  if (recommendedTotal <= 0 || availableSec <= 0) {
    return { readingThinkingSec: 0, operationSec: 0 };
  }

  let readingThinkingSec = Math.round(
    availableSec * (options.recommendedReadingThinkingSec / recommendedTotal),
  );
  if (options.recommendedReadingThinkingSec > 0 && options.recommendedOperationSec > 0) {
    readingThinkingSec = clamp(readingThinkingSec, 1, Math.max(1, availableSec - 1));
  }
  return {
    readingThinkingSec,
    operationSec: Math.max(0, availableSec - readingThinkingSec),
  };
}

/**
 * Decompose one confirmed semantic page into executable time buckets.
 *
 * Task demand comes from the interaction/question model. When the confirmed
 * page is too short, the returned flag tells generation to simplify the task;
 * the planner never changes playback speed or silently lengthens the page.
 */
export function planPblPageTiming(input: PblPageTimingInput): PblPageTimingBreakdown {
  const rawActivityTargetSec = Number(input.activityTargetSec);
  const activityTargetSec = Number.isFinite(rawActivityTargetSec) && rawActivityTargetSec > 0
    ? Math.max(1, Math.round(rawActivityTargetSec))
    : 1;
  const pageKind = inferPageKind(input);
  const contentType = inferContentType({
    id: 'page-timing',
    contentType: input.contentType
      ?? (pageKind === 'quiz' ? 'quiz' : pageKind === 'interactive' ? 'interaction' : undefined),
    interaction: input.interaction,
    quiz: input.quiz,
  });
  const transitionSec = pageTransitionSec(pageKind, activityTargetSec);

  let recommendedReadingThinkingSec = 0;
  let recommendedOperationSec = 0;
  if (pageKind === 'interactive') {
    const demand = interactiveTaskDemand(input.interaction ?? {
      type: 'custom',
      stepCount: 1,
      difficulty: 'standard',
    });
    recommendedReadingThinkingSec = demand.readingThinkingSec;
    recommendedOperationSec = demand.operationSec;
  } else if (pageKind === 'quiz') {
    const demand = quizTaskDemand(input.quiz ?? {
      questionCount: 1,
      questionTypes: ['single'],
      difficulty: 'standard',
    });
    recommendedReadingThinkingSec = demand.readingThinkingSec;
    recommendedOperationSec = demand.operationSec;
  }

  const recommendedStudentActivitySec = (
    recommendedReadingThinkingSec + recommendedOperationSec
  );
  const minimumNarrationSec = pageKind === 'slide'
    ? 0
    : Math.min(
        activityTargetSec - transitionSec,
        clamp(Math.round(activityTargetSec * 0.22), 20, 90),
      );
  const availableStudentSec = Math.max(
    0,
    activityTargetSec - transitionSec - minimumNarrationSec,
  );
  const allocation = allocateStudentTime({
    availableSec: availableStudentSec,
    recommendedReadingThinkingSec,
    recommendedOperationSec,
  });
  const studentActivitySec = allocation.readingThinkingSec + allocation.operationSec;
  const narrationSec = Math.max(
    1,
    activityTargetSec - transitionSec - studentActivitySec,
  );
  const taskFitsBudget = recommendedStudentActivitySec <= availableStudentSec;
  const feedbackSec = pageKind === 'quiz'
    ? Math.min(narrationSec, Math.max(10, Math.round(narrationSec * 0.55)))
    : pageKind === 'interactive'
      ? Math.min(narrationSec, Math.max(8, Math.round(narrationSec * 0.3)))
      : 0;
  const rationale = pageKind === 'slide'
    ? ['Slide pages reserve only a short page-change interval; the remaining budget is natural-speed narration.']
    : [
        pageKind === 'quiz'
          ? 'Question count, question type, and difficulty determine reading, thinking, and response demand.'
          : 'Widget type, step count, and difficulty determine comprehension and hands-on demand.',
        taskFitsBudget
          ? 'The modeled task fits the confirmed page budget.'
          : 'Simplify the generated task to fit the confirmed page budget; never speed up TTS or extend the page.',
      ];

  return {
    pageKind,
    contentType,
    activityTargetSec,
    narrationSec,
    readingThinkingSec: allocation.readingThinkingSec,
    operationSec: allocation.operationSec,
    studentActivitySec,
    feedbackSec,
    transitionSec,
    taskComplexity: taskComplexityForSeconds(recommendedStudentActivitySec),
    recommendedReadingThinkingSec,
    recommendedOperationSec,
    recommendedStudentActivitySec,
    taskFitsBudget,
    rationale,
  };
}

function defaultTeacherSec(input: PblActivityTimingInput, contentType: PblActivityContentType): number {
  if (input.teacherSec !== undefined) return roundSeconds(input.teacherSec);
  if (input.quiz) return 20;
  if (input.interaction) return contentType === 'case-analysis' ? 35 : 25;
  return 15;
}

function defaultTransitionSec(input: PblActivityTimingInput): number {
  if (input.transitionSec !== undefined) return roundSeconds(input.transitionSec);
  if (input.interaction?.type === 'case-analysis' || input.quiz) return 20;
  if (input.activityKind === 'practice') return 25;
  return 10;
}

function inferSceneContentType(source: PblSceneTimingSource): PblActivityContentType {
  if (source.type === "quiz" || source.quizConfig) return "quiz";
  if (source.type === "interactive") {
    return source.widgetType === "code" || source.widgetType === "diagram"
      ? "technical-explanation"
      : "interaction";
  }
  const value = `${source.title ?? ""} ${source.description ?? ""} ${(source.keyPoints ?? []).join(" ")}`.toLowerCase();
  if (/case|案例|情境|证据|判断/.test(value)) return "case-analysis";
  if (/technical|技术|代码|编程|步骤|实现/.test(value)) return "technical-explanation";
  if (source.detailKind === "reflection-transfer" || /reflection|反思|迁移/.test(value)) return "reflection";
  return "theory";
}

function inferSceneInteraction(source: PblSceneTimingSource): PblActivityTimingInput["interaction"] {
  if (source.type !== "interactive") return undefined;
  const widget = source.widgetOutline && typeof source.widgetOutline === "object"
    ? source.widgetOutline as Record<string, unknown>
    : undefined;
  const type: PblInteractionType = source.widgetType === "code"
    ? "code"
    : source.widgetType === "diagram"
      ? "diagram"
      : source.widgetType === "game"
        ? "game"
        : source.widgetType === "simulation"
          ? "simulation"
          : "custom";
  const stepCount = Array.isArray(widget?.steps)
    ? widget.steps.length
    : Array.isArray(widget?.interactions)
      ? widget.interactions.length
      : 1;
  return { type, stepCount, difficulty: "standard" };
}

function inferSceneQuiz(source: PblSceneTimingSource): PblActivityTimingInput["quiz"] {
  if (source.type !== "quiz" && !source.quizConfig) return undefined;
  const config = source.quizConfig as {
    questionCount?: number;
    difficulty?: string;
    questionTypes?: PblQuizQuestionType[];
  } | undefined;
  return {
    questionCount: Math.max(1, Math.round(config?.questionCount ?? 3)),
    questionTypes: config?.questionTypes,
    difficulty: config?.difficulty === "hard"
      ? "advanced"
      : config?.difficulty === "easy"
        ? "introductory"
        : "standard",
  };
}

/** Convert a confirmed scene outline into the same timing input used by the UI and server. */
export function buildPblTimingInputFromScene(
  source: PblSceneTimingSource,
  speechText?: string,
  fallbackTts?: PblActivityTimingInput["tts"],
): PblActivityTimingInput {
  const targetDurationSec = Math.max(
    1,
    Math.round(
      source.timingPlan?.activityTargetDurationSec
        ?? source.timingPlan?.targetDurationSec
        ?? source.targetDurationSec
        ?? source.estimatedDuration
        ?? 60,
    ),
  );
  const isTeacherResource = source.audience === "teacher" || source.ttsPolicy === "none";
  return {
    id: source.id,
    title: source.title,
    stageKey: source.stageKey,
    activityKind: undefined,
    contentType: source.timingPlan?.contentType as PblActivityContentType | undefined
      ?? inferSceneContentType(source),
    speechText: isTeacherResource
      ? undefined
      : speechText ?? [source.description, ...(source.keyPoints ?? [])].filter(Boolean).join("。"),
    targetDurationSec,
    tts: isTeacherResource
      ? undefined
      : {
          ...fallbackTts,
          providerId: source.timingPlan?.providerId ?? fallbackTts?.providerId,
          modelId: source.timingPlan?.modelId ?? fallbackTts?.modelId,
          speed: source.timingPlan?.speed ?? fallbackTts?.speed,
          language: source.timingPlan?.language ?? fallbackTts?.language,
        },
    interaction: inferSceneInteraction(source),
    quiz: inferSceneQuiz(source),
    teacherSec: isTeacherResource ? targetDurationSec : undefined,
    transitionSec: isTeacherResource ? 0 : undefined,
  };
}

function buildRecommendations(
  input: PblActivityTimingInput,
  contentType: PblActivityContentType,
  ttsSec: number,
  nonSpeechSec: number,
): string[] {
  const recommendations: string[] = [];
  if (contentType === 'case-analysis') {
    recommendations.push('案例分析应保留事实、证据、判断和复盘四步，避免只讲结论。');
  } else if (contentType === 'technical-explanation' || contentType === 'procedure') {
    recommendations.push('技术说明应按步骤、关键约束和可验证结果组织内容。');
  } else if (contentType === 'quiz') {
    recommendations.push('测验时间应按题型和难度计算，并为提交与反馈保留缓冲。');
  } else if (contentType === 'reflection') {
    recommendations.push('反思阶段应优先使用学生成果和评价证据，引导学生自己提出改进方案。');
  } else {
    recommendations.push('理论讲解应围绕概念、依据和例子组织，避免只堆叠定义。');
  }

  if (input.targetDurationSec && input.speechText?.trim()) {
    const targetSpeechSec = Math.max(15, input.targetDurationSec - nonSpeechSec);
    const ratio = ttsSec / targetSpeechSec;
    if (ratio < 0.9) {
      recommendations.push('当前讲授不足目标时间，建议增加一个内容点、案例或分步解释。');
    } else if (ratio > 1.1) {
      recommendations.push('当前讲授超过目标时间，建议合并重复说明并保留关键依据。');
    }
  }
  return recommendations;
}

export function estimatePblActivityTime(input: PblActivityTimingInput): PblActivityTimeEstimate {
  const contentType = inferContentType(input);
  const ttsSec = input.speechText?.trim()
    ? estimateSpeechDurationSec(input.speechText, {
        providerId: input.tts?.providerId,
        modelId: input.tts?.modelId,
        speed: input.tts?.speed,
        minSeconds: 1,
      })
    : 0;
  const interactionSec = estimateInteractionSec(input);
  const quizSec = estimateQuizSec(input);
  const teacherSec = defaultTeacherSec(input, contentType);
  const transitionSec = defaultTransitionSec(input);
  const nonSpeechSec = interactionSec + quizSec + teacherSec + transitionSec;
  const totalSec = roundSeconds(ttsSec + nonSpeechSec);
  return {
    id: input.id,
    title: input.title,
    stageKey: input.stageKey,
    activityKind: input.activityKind,
    contentType,
    ttsSec,
    interactionSec,
    quizSec,
    teacherSec,
    transitionSec,
    totalSec,
    recommendations: buildRecommendations(input, contentType, ttsSec, nonSpeechSec),
  };
}

export function assessPblTimeBudget(options: {
  targetSec: number;
  actualSec: number;
  contentType?: PblActivityContentType;
  activityTitle?: string;
  tolerance?: number;
}) {
  const assessment = assessTtsDurationError({
    targetSec: options.targetSec,
    actualSec: options.actualSec,
    tolerance: options.tolerance,
  });
  const percentage = Math.round(assessment.tolerance * 100);
  const warning = assessment.withinTolerance
    ? `当前讲授时长在允许误差 ±${percentage}% 内。`
    : `讲授时长偏离目标 ${Math.round(assessment.absoluteErrorRatio * 100)}%，已超出允许误差 ±${percentage}%。`;
  const suggestions = [...assessment.suggestions];
  if (!assessment.withinTolerance && options.contentType === 'case-analysis') {
    suggestions.push('建议增加案例证据和判断步骤，或缩短重复背景介绍。');
  } else if (!assessment.withinTolerance && options.contentType === 'technical-explanation') {
    suggestions.push('建议增加可验证的技术步骤，或删除不影响任务完成的背景说明。');
  } else if (!assessment.withinTolerance) {
    suggestions.push('建议增加或减少一个内容点，并重新计算当前模型下的讲授时长。');
  }
  return {
    ...assessment,
    warning,
    suggestions,
    activityTitle: options.activityTitle,
  };
}

export function getPblTimingProfileLabel(providerId?: string, modelId?: string): string {
  return getTtsTimingProfile(providerId, modelId).label;
}

/**
 * Opt-in real-provider regression for section-wide progression and case continuity.
 * OPENPBL_RUN_LEARNING_PROGRESSION_ACCEPTANCE=1 pnpm exec vitest run --config tools/course-quality-lab/vitest.config.ts tools/course-quality-lab/formal-learning-progression-acceptance.test.ts
 */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FORMAL_QUALITY_REGRESSION_FIXTURES } from './fixtures';

const observations = vi.hoisted(() => ({
  calls: [] as Array<{ source: string; startedAt: number; completedAt?: number; thinking: unknown; prompt: string; error?: string; reasoningCharacters?: number; textCharacters?: number }>,
}));

vi.mock('@openmaic/lib/server/provider-config', async (original) => ({
  ...await original<typeof import('@openmaic/lib/server/provider-config')>(),
  resolveServerThinkingConfig: () => ({ mode: 'enabled', enabled: true, effort: 'high' }),
}));
vi.mock('@openmaic/lib/ai/llm', async (original) => {
  const actual = await original<typeof import('@openmaic/lib/ai/llm')>();
  return {
    ...actual,
    callStreamingLLMText: async (...args: Parameters<typeof actual.callStreamingLLMText>) => {
      const [params, source, thinking] = args;
      const call: (typeof observations.calls)[number] = {
        source, startedAt: Date.now(), thinking, prompt: JSON.stringify(params.messages),
      };
      observations.calls.push(call);
      try {
        return await actual.callStreamingLLMText(params, source, thinking, {
          ...args[3],
          onActivity: (activity) => {
            call.reasoningCharacters = activity.reasoningCharacters;
            call.textCharacters = activity.textCharacters;
            args[3]?.onActivity?.(activity);
          },
        });
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.completedAt = Date.now();
      }
    },
  };
});

it.skipIf(process.env.OPENPBL_RUN_LEARNING_PROGRESSION_ACCEPTANCE !== '1')(
  'generates the theory-mode-method section from a shared case without semantic drift or shortcut rules',
  async () => {
    observations.calls.length = 0;
    const runtime = path.resolve(process.env.OPENPBL_LEARNING_PROGRESSION_DIR
      || '.openpbl-runtime/formal-learning-progression-2026-09-19');
    await fs.mkdir(runtime, { recursive: true });
    const writeQueues = new Map<string, Promise<void>>();
    const write = (filename: string, value: unknown) => {
      const next = (writeQueues.get(filename) ?? Promise.resolve())
        .then(() => fs.writeFile(path.join(runtime, filename), JSON.stringify(value, null, 2)));
      writeQueues.set(filename, next);
      return next;
    };
    const secretDir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']] as const) {
      process.env[key] = (await fs.readFile(path.join(secretDir, file), 'utf8')).trim();
    }
    const fixture = FORMAL_QUALITY_REGRESSION_FIXTURES
      .find((item) => item.id === 'theory-mode-method-progression')!;
    const sourceContext = fixture.sources.map((source) => `${source.title}\n${source.detail}`).join('\n\n');
    const knowledgePoints = [
      { id: 'teaching-theory', name: '教学理论的内涵与作用', description: '解释教学依据和学习发生的基本原则', level: 'foundation' as const },
      { id: 'teaching-model', name: '教学模式的特征与功能', description: '解释课堂的整体组织结构', level: 'core' as const },
      { id: 'teaching-method', name: '教学方法的灵活性与应用', description: '解释具体环节采用的技巧和手段', level: 'application' as const },
    ];
    const modelString = process.env.OPENPBL_FORMAL_ACCEPTANCE_MODEL || 'deepseek:deepseek-v4.1-flash';
    const { initializeServerProviderConfig } = await import('@openmaic/lib/server/provider-config');
    await initializeServerProviderConfig();
    const { resolveModel } = await import('@openmaic/lib/server/resolve-model');
    const resolved = await resolveModel({ modelString, stage: 'scene-outlines-stream' });
    const { createCourseGenerationAiCall } = await import('@openmaic/lib/server/course-generation-ai-call');
    const { generateTeachingBlueprint, teachingBlueprintToOutlines } = await import('@/lib/course-design/teaching-blueprint');
    const { deriveTeachingConstraints } = await import('@openmaic/lib/pedagogy/teaching-constraints');
    const teachingConstraints = deriveTeachingConstraints({
      grade: fixture.grade, subject: fixture.subject, topic: fixture.title, hours: 1,
      learnerProfile: {
        priorKnowledge: '具有一般课堂经验，但尚未正式区分教学理论、教学模式和教学方法。',
        learningNeeds: '容易根据名称或单一替换结果作绝对判断，需要从具体课堂安排理解表述的主要功能。',
        familiarContexts: '中小学人工智能课堂；猫狗图片分类',
      },
      learningObjectives: [...fixture.learningObjectives], knowledgePoints,
    });
    const blueprintInput = {
      generationModelFingerprint: modelString,
      courseTitle: fixture.title,
      subject: fixture.subject,
      grade: fixture.grade,
      learningObjectives: [...fixture.learningObjectives],
      teachingConstraints,
      projectContext: '为一节中小学人工智能课检查教学依据、整体组织与具体活动是否匹配。',
      knowledgePoints,
      totalDurationSec: 240,
      assessmentMode: 'constructed-response' as const,
      generationMode: 'standard' as const,
      teacherBrief: '本次正式回归只生成一个小节，包含两页讲授和一题节末独立判断。第一页说明学习用途并展开课堂过程；第二页沿用同一案例，只改变归纳环节的支持方式，其他条件保持不变。',
      sourceContext,
    };
    await write('blueprint-input.json', blueprintInput);
    const blueprint = await generateTeachingBlueprint(blueprintInput, createCourseGenerationAiCall({
      model: resolved.model,
      vision: false,
      source: 'teaching-blueprint',
      thinking: resolved.thinkingConfig,
      maxOutputTokens: 24_000,
      timeoutMs: 20 * 60_000,
      maxRetries: 1,
      streamResponse: true,
    }));
    await write('blueprint.json', blueprint);
    expect(blueprint.sections).toHaveLength(1);
    expect(blueprint.sections[0]?.pages).toHaveLength(2);
    const outlines = teachingBlueprintToOutlines(blueprint, '全程使用自然、准确的简体中文。');
    const teachingPages = outlines.filter((outline) => outline.type !== 'quiz');
    expect(teachingPages).toHaveLength(2);
    expect(teachingPages[0]?.teachingBrief?.sharedContext)
      .toEqual(teachingPages[1]?.teachingBrief?.sharedContext);
    expect(teachingPages[1]?.teachingBrief?.pageTask?.caseUse).toBe('variant');
    expect(teachingPages[1]?.teachingBrief?.pageTask?.changedConditions.length).toBeGreaterThan(0);
    expect(teachingPages[1]?.teachingBrief?.pageTask?.preservedConditions.length).toBeGreaterThan(0);

    const { generateClassroom } = await import('@openmaic/lib/server/classroom-generation');
    let prepared = outlines;
    const scenes: unknown[] = [];
    const result = await generateClassroom({
      generationModelString: modelString,
      courseTitle: fixture.title,
      requirement: `${fixture.title}\n${fixture.learningObjectives.join('；')}\n只生成已确认的本小节课堂。`,
      teachingSourceContext: sourceContext,
      teachingConstraints,
      knowledgePoints,
      sceneOutlines: outlines,
      enableWebSearch: false,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: false,
      agentMode: 'default',
    }, {
      onOutlinesPrepared: async (value) => { prepared = value; await write('prepared-outlines.json', value); },
      onSceneStageCompleted: async (outline, stage, payload) => write(`${outline.id}-${stage}.json`, payload),
      onSceneCompleted: async (_outline, scene) => { scenes.push(scene); await write('scenes.json', scenes); },
      onProgress: async (progress) => write('latest-progress.json', progress),
    });
    await write('result.json', result);
    await write('calls.json', observations.calls);
    const speechByPage = result.scenes.map((scene) => (scene.actions ?? [])
      .flatMap((action) => action.type === 'speech' ? [action.text] : []).join('\n'));
    const allOutput = JSON.stringify({ prepared, scenes: result.scenes });
    expect(prepared[0]?.teachingBrief?.sharedContext)
      .toEqual(prepared[1]?.teachingBrief?.sharedContext);
    expect(prepared[0]?.teachingBrief?.pageTask?.newContribution)
      .not.toBe(prepared[1]?.teachingBrief?.pageTask?.newContribution);
    expect(speechByPage[0].length).toBeGreaterThan(0);
    expect(speechByPage[1].length).toBeGreaterThan(0);
    const firstTeachingSpeech = result.scenes[0]?.actions.find((action) => action.type === 'speech' && Boolean(action.text))?.text ?? '';
    expect(firstTeachingSpeech).not.toMatch(/教学理论[^。]{0,80}教学模式[^。]{0,80}教学方法/);
    const firstPageSpeech = speechByPage[0] ?? '';
    const caseBeforeTerms = firstPageSpeech.search(/学生先|猫狗图片/) >= 0
      && firstPageSpeech.search(/学生先|猫狗图片/) < firstPageSpeech.indexOf('教学理论');
    expect(caseBeforeTerms).toBe(true);
    const variantScene = result.scenes[1];
    const variantVisibleText = variantScene?.content.type === 'slide'
      ? variantScene.content.canvas.elements.flatMap((element) => element.type === 'text' ? [element.content] : [])
        .join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
      : '';
    expect(variantVisibleText).not.toMatch(/课堂按[^。]{0,80}(?:→|属于)\s*(?:教学)?模式/);
    expect(variantVisibleText).not.toMatch(/归纳[^。]{0,80}(?:→|属于)\s*(?:教学)?方法/);
    const variantActions = variantScene?.actions ?? [];
    const firstSpeechIndex = variantActions.findIndex((action) => action.type === 'speech' && Boolean(action.text));
    const secondSpeechIndex = variantActions.findIndex((action, index) => index > firstSpeechIndex
      && action.type === 'speech' && Boolean(action.text));
    const thinkingPauseIndex = variantActions.findIndex((action) => action.type === 'speech'
      && 'timelinePausePurpose' in action && action.timelinePausePurpose === 'learner-reflection');
    expect(thinkingPauseIndex).toBeGreaterThan(firstSpeechIndex);
    expect(thinkingPauseIndex).toBeLessThan(secondSpeechIndex);
    expect(allOutput).not.toContain('做一次替换就能验证');
    expect(allOutput).not.toMatch(/只影响一个环节[^。]{0,20}就是(?:教学)?方法/);
    expect(allOutput).not.toMatch(/删掉[^。]{0,40}(?:设计失去依据|设计没了依据)/);
    const quiz = result.scenes.find((scene) => scene.content.type === 'quiz');
    const quizQuestions = quiz?.content.type === 'quiz' ? quiz.content.questions : [];
    expect(quizQuestions).toHaveLength(1);
    expect(quizQuestions[0]?.question).not.toContain('猫狗');
    expect(quizQuestions[0]?.question).not.toContain('情境—体验—归纳—反思');
    expect(observations.calls.every((call) => (call.thinking as { effort?: string })?.effort === 'high')).toBe(true);
    expect(observations.calls.filter((call) => call.source === 'classroom-natural-narration')).toEqual([]);
    await write('acceptance.json', {
      passed: true,
      finishedAt: new Date().toISOString(),
      model: modelString,
      modelCalls: observations.calls.length,
      pageSpeechCharacters: speechByPage.map((speech) => speech.length),
      sharedCasePreserved: true,
      purposeAndCaseBeforeTerms: true,
      distinctPageContributions: true,
      freshAssessmentSituation: true,
      variantPromptBeforeAnswer: true,
      shortcutRulesAbsent: true,
    });
  },
  60 * 60_000,
);

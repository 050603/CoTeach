/**
 * Opt-in real provider acceptance; never creates a persisted classroom.
 * OPENPBL_RUN_FORMAL_ACCEPTANCE=1 pnpm exec vitest run --config tools/course-quality-lab/vitest.config.ts tools/course-quality-lab/formal-acceptance.test.ts
 */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NarrationModuleOutput } from '@openmaic/lib/generation/action-binding-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';

const observations = vi.hoisted(() => ({
  calls: [] as Array<{ source: string; startedAt: number; completedAt?: number; thinking: unknown; maxOutputTokens?: number; prompt: string; error?: string; reasoningCharacters?: number; textCharacters?: number; lastActivityAt?: number }>,
}));

// Change only this isolated process's teacher selection. All transport,
// credentials, capability selection and generation code remain production code.
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
        source, startedAt: Date.now(), thinking, maxOutputTokens: params.maxOutputTokens,
        prompt: JSON.stringify(params.messages),
      };
      observations.calls.push(call);
      try {
        return await actual.callStreamingLLMText(params, source, thinking, {
          ...args[3],
          onActivity: (activity) => {
            call.reasoningCharacters = activity.reasoningCharacters;
            call.textCharacters = activity.textCharacters;
            call.lastActivityAt = Date.now();
            args[3]?.onActivity?.(activity);
          },
        });
      }
      catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { call.completedAt = Date.now(); }
    },
  };
});

it.skipIf(process.env.OPENPBL_RUN_FORMAL_ACCEPTANCE !== '1')(
  'generates a real high-thinking classroom with first-pass resources and local technical checks',
  async () => {
    observations.calls.length = 0;
    const runtime = path.resolve(process.env.OPENPBL_FORMAL_ACCEPTANCE_DIR
      || '.openpbl-runtime/formal-technical-policy-2026-09-19');
    await fs.mkdir(runtime, { recursive: true });
    const secretDir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']] as const) {
      process.env[key] = (await fs.readFile(path.join(secretDir, file), 'utf8')).trim();
    }
    const { initializeServerProviderConfig } = await import('@openmaic/lib/server/provider-config');
    await initializeServerProviderConfig();
    const { deriveTeachingConstraints } = await import('@openmaic/lib/pedagogy/teaching-constraints');
    const { generateClassroom } = await import('@openmaic/lib/server/classroom-generation');
    const knowledgePoints = [{ id: 'verify-claim', name: '生成式人工智能回答的事实核验' }];
    const sceneOutlines: SceneOutline[] = [
      {
        id: 'verify-teaching', type: 'slide', title: '班级小报里的数字，先查再用', order: 0,
        description: '用AI帮班级小报写校园介绍时，先找出需要核验的具体事实，再去学校公开介绍中定位证据，核对一致后再使用。',
        keyPoints: ['语气肯定不等于事实正确', '找到明确说法并核对可靠记录'],
        teachingObjective: '能指出AI回答中应核验的具体说法，并说明应去哪里核对。',
        lectureSectionId: 'verification', lectureSectionTitle: '核验AI回答', audience: 'student',
        generationPurpose: 'knowledge-teaching', teachingUnitIds: ['verification-unit'],
        knowledgePointIds: ['verify-claim'], targetDurationSec: 70,
      },
      {
        id: 'verify-assessment', type: 'quiz', title: '小报发布前，怎样核验？', order: 1,
        description: '根据刚刚的讲解出一道选择题，检查学生能否选择恰当的事实核验做法，提供简洁解析。',
        keyPoints: ['选择与具体说法相匹配的核验来源'],
        lectureSectionId: 'verification', lectureSectionTitle: '核验AI回答', audience: 'student',
        generationPurpose: 'knowledge-teaching', assessmentUnitIds: ['verification-unit'],
        quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'], coveragePolicy: 'section-synthesis' },
        knowledgePointIds: ['verify-claim'],
      },
    ];
    const input = {
      generationModelString: process.env.OPENPBL_FORMAL_ACCEPTANCE_MODEL || 'deepseek:deepseek-v4.1-flash',
      courseTitle: '八年级：核验AI回答',
      requirement: '为八年级学生生成一页约70秒的课堂讲解和一道课后测验。讲稿直接由语音读给学生听，听一遍就能理解；用校园小报的具体情境解释为什么要核验以及怎么核验。术语准确，解释自然，课件只呈现帮助理解的关键内容。',
      teachingSourceContext: '生成式人工智能可能生成看起来流畅、语气肯定，但不准确的事实描述。核验时先明确待查的具体说法，再寻找与这项说法直接相关的可靠记录，检查记录是否支持该说法。校园介绍中的建校年份可以与学校公开介绍核对；不能仅凭AI语气或回答长度判断真假。',
      teachingConstraints: deriveTeachingConstraints({
        grade: '八年级', subject: '信息科技', topic: '生成式人工智能回答的事实核验', hours: 1,
        learnerProfile: {
          priorKnowledge: '学生会使用搜索引擎，也用过聊天式AI写短文；尚未学过语言模型原理。',
          learningNeeds: '容易把语气肯定当成事实可靠；听复杂条件句时容易漏掉判断依据。',
          familiarContexts: '班级小报；学校公众号的校园介绍',
        },
        learningObjectives: ['找出需要核验的具体事实说法，选择与说法直接相关的记录进行核对。'], knowledgePoints,
      }),
      knowledgePoints, sceneOutlines,
      enableWebSearch: false, enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false,
      agentMode: 'default' as const,
    };
    const write = async (filename: string, value: unknown) => fs.writeFile(path.join(runtime, filename), JSON.stringify(value, null, 2));
    const originalInput = structuredClone(input);
    const inputIdentity = createHash('sha256').update(JSON.stringify(originalInput)).digest('hex');
    const resumeRoot = process.env.OPENPBL_FORMAL_ACCEPTANCE_RESUME_DIR
      ? path.resolve(process.env.OPENPBL_FORMAL_ACCEPTANCE_RESUME_DIR) : undefined;
    let resumedContent: unknown;
    if (resumeRoot) {
      if (resumeRoot === runtime) throw new Error('Resume must write to a new artifact directory');
      const previousInput = JSON.parse(await fs.readFile(path.join(resumeRoot, 'input.json'), 'utf8'));
      if (createHash('sha256').update(JSON.stringify(previousInput)).digest('hex') !== inputIdentity) {
        throw new Error('Resume input identity mismatch; refusing unrelated teaching artifacts');
      }
      const previousCalls = JSON.parse(await fs.readFile(path.join(resumeRoot, 'calls.json'), 'utf8')) as Array<{ thinking?: { effort?: string } }>;
      if (!previousCalls.length || previousCalls.some((call) => call.thinking?.effort !== 'high')) {
        throw new Error('Resume requires artifacts generated under the same teacher high-thinking setting');
      }
      const previousOutlines = JSON.parse(await fs.readFile(path.join(resumeRoot, 'prepared-outlines.json'), 'utf8')) as SceneOutline[];
      // Reuse semantic teaching design, but recompute timing and all current
      // preparation rules. Never carry an outdated prepared timing allocation.
      input.sceneOutlines = input.sceneOutlines.map((outline) => {
        const previous = previousOutlines.find((candidate) => candidate.id === outline.id && candidate.type === outline.type);
        if (!previous?.teachingBrief) throw new Error(`Missing resume teaching design for ${outline.id}`);
        return { ...outline, teachingBrief: previous.teachingBrief };
      });
      resumedContent = JSON.parse(await fs.readFile(path.join(resumeRoot, 'verify-teaching-content.json'), 'utf8'));
      await write('resume-identity.json', { source: resumeRoot, inputIdentity, teacherThinking: 'high', reused: ['teaching-design', 'teaching-slide-content'], regenerated: ['timing', 'teaching-narration', 'quiz-content', 'quiz-actions'] });
    }
    await write('input.json', originalInput);
    await write('effective-input.json', input);
    const progress: unknown[] = [];
    const finished: Array<{ id: string; at: number; speech: string[] }> = [];
    let prepared: SceneOutline[] = [];
    let firstPassNarration: NarrationModuleOutput | undefined;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('Formal acceptance overall budget exhausted')), 43 * 60_000);
    try {
      const result = await generateClassroom(input, {
        signal: abort.signal,
        loadSceneStageCheckpoint: (outline, stage) => outline.id === 'verify-teaching' && stage === 'content'
          ? resumedContent ?? null : null,
        onProgress: async (update) => {
          progress.push({ at: Date.now(), ...update });
          await write('progress.json', progress);
          await write('calls.json', observations.calls);
        },
        onOutlinesPrepared: async (outlines) => { prepared = outlines; await write('prepared-outlines.json', outlines); },
        onSceneStageCompleted: async (outline, stage, payload) => {
          if (outline.id === 'verify-teaching' && stage === 'narration' && payload && typeof payload === 'object' && 'teachingNarration' in payload) {
            firstPassNarration = payload.teachingNarration as NarrationModuleOutput;
          }
          await write(`${outline.id}-${stage}.json`, payload);
        },
        onSceneCompleted: async (outline, scene) => {
          finished.push({ id: outline.id, at: Date.now(), speech: (scene.actions ?? []).flatMap((action) => action.type === 'speech' ? [action.text] : []) });
          await write(`${outline.id}-scene.json`, scene);
          await write('finished-scenes.json', finished);
        },
      });
      await write('result.json', result);
      expect(result.scenes).toHaveLength(2);
      expect(result.qualityReport.reviewMode).toBe('local-technical');
      expect(result.qualityReport.reviewPolicyVersion).toBeTruthy();
      const quiz = result.scenes.find((scene) => scene.content.type === 'quiz');
      expect(quiz?.content.type === 'quiz' ? quiz.content.questions : []).toHaveLength(1);
      expect(prepared.find((outline) => outline.id === 'verify-teaching')?.teachingBrief?.teachingPlan).toBeTruthy();
      expect(prepared.find((outline) => outline.id === 'verify-teaching')?.targetDurationSec).toBe(70);
      expect(prepared.find((outline) => outline.id === 'verify-assessment')?.timingPlan?.narrationSec).toBeLessThan(60);
      expect(observations.calls.length).toBeGreaterThan(2);
      expect(observations.calls.some((call) => call.prompt.includes('尚未学过语言模型原理'))).toBe(true);
      expect(observations.calls.some((call) => call.prompt.includes('容易把语气肯定当成事实可靠'))).toBe(true);
      expect(observations.calls.every((call) => (call.thinking as { effort?: string })?.effort === 'high')).toBe(true);
      // This fixture needs only its shared teaching plan and first-pass page
      // content/actions. Local checks must not call a model to rewrite output.
      expect(observations.calls.filter((call) => call.source === 'classroom-natural-narration')).toEqual([]);
      expect(observations.calls.filter((call) => call.prompt.includes('## EDIT MODE'))).toEqual([]);
      const firstPassSources = new Set(['classroom-section-teaching-design', 'scene-content', 'scene-actions']);
      expect(observations.calls.filter((call) => !firstPassSources.has(call.source))).toEqual([]);
      const teaching = finished.find((scene) => scene.id === 'verify-teaching');
      expect(teaching?.speech.length).toBeGreaterThan(0);
      expect(firstPassNarration?.segments.length).toBeGreaterThan(0);
      expect(teaching?.speech.filter((text) => text.trim())).toEqual(firstPassNarration?.segments.map((segment) => segment.text));
      expect(observations.calls.some((call) => call.prompt.includes('semanticUnits'))).toBe(true);
      const groundedCalls = observations.calls.filter((call) => call.prompt.includes('completed-student-teaching'));
      expect(groundedCalls.length).toBeGreaterThan(0);
      expect(groundedCalls.every((call) => call.startedAt >= teaching!.at)).toBe(true);
      expect(groundedCalls.some((call) => call.prompt.includes(teaching!.speech[0].slice(0, 20)))).toBe(true);
      await write('acceptance.json', { passed: true, finishedAt: new Date().toISOString(), scenes: result.scenes.length, thinking: 'high', teachingPlan: true, quizGroundedAfterTeaching: true, questionCount: 1, firstPassWithLocalChecks: true, independentNarrationPreserved: true, reusedTeachingDesignAndSlide: Boolean(resumeRoot), teachingDurationSec: 70, quizNarrationUnder60Sec: true, modelRewriteCalls: 0, modelCalls: observations.calls.length });
    } catch (error) {
      await write('failure.json', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      throw error;
    } finally {
      clearTimeout(timeout);
      await write('calls.json', observations.calls);
      await write('progress.json', progress);
    }
  },
  45 * 60_000,
);

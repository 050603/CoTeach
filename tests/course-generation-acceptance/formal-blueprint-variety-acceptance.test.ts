/**
 * Opt-in real-provider check that the shared progression policy also plans
 * mechanism explanations and procedural guidance without imposing a
 * classification-lesson shape.
 */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FORMAL_QUALITY_REGRESSION_FIXTURES } from './fixtures';

const observations = vi.hoisted(() => ({
  calls: [] as Array<{ source: string; startedAt: number; completedAt?: number; thinking: unknown; error?: string }>,
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
      const call: (typeof observations.calls)[number] = {
        source: args[1], startedAt: Date.now(), thinking: args[2],
      };
      observations.calls.push(call);
      try {
        return await actual.callStreamingLLMText(...args);
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.completedAt = Date.now();
      }
    },
  };
});

it.skipIf(process.env.OPENPBL_RUN_BLUEPRINT_VARIETY_ACCEPTANCE !== '1')(
  'plans mechanism and procedure courses without forcing a classification template',
  async () => {
    observations.calls.length = 0;
    const runtime = path.resolve(process.env.OPENPBL_BLUEPRINT_VARIETY_DIR
      || '.openpbl-runtime/formal-blueprint-variety-2026-09-19');
    await fs.mkdir(runtime, { recursive: true });
    const secretDir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']] as const) {
      process.env[key] = (await fs.readFile(path.join(secretDir, file), 'utf8')).trim();
    }
    const modelString = process.env.OPENPBL_FORMAL_ACCEPTANCE_MODEL || 'deepseek:deepseek-v4.1-flash';
    const { initializeServerProviderConfig } = await import('@openmaic/lib/server/provider-config');
    await initializeServerProviderConfig();
    const { resolveModel } = await import('@openmaic/lib/server/resolve-model');
    const resolved = await resolveModel({ modelString, stage: 'scene-outlines-stream' });
    const { createCourseGenerationAiCall } = await import('@openmaic/lib/server/course-generation-ai-call');
    const { generateTeachingBlueprint } = await import('@/lib/course-design/teaching-blueprint');
    const { deriveTeachingConstraints } = await import('@openmaic/lib/pedagogy/teaching-constraints');

    const cases = [
      {
        id: 'generation-mechanism-explanation',
        knowledgePoints: [
          { id: 'language-pattern', name: '语言模式续写', description: '解释生成内容的形成过程', level: 'foundation' as const },
          { id: 'evidence-boundary', name: '流畅表达与事实证据', description: '区分表达质量与证据支持', level: 'core' as const },
        ],
        teacherBrief: '只规划一个小节、两页讲授和一题节末测验。按观察到证据缺口、解释生成机制的认识进展组织，不安排分类练习。',
        requiredTerms: ['语言模式', '证据'],
      },
      {
        id: 'verification-procedure-guidance',
        knowledgePoints: [
          { id: 'claim-marking', name: '标记高风险主张', description: '定位需要优先核验的内容', level: 'foundation' as const },
          { id: 'evidence-record', name: '查找并记录证据', description: '建立主张与来源的对应关系', level: 'core' as const },
          { id: 'uncertainty-handling', name: '冲突与缺证处理', description: '保留未知并追溯来源', level: 'application' as const },
        ],
        teacherBrief: '只规划一个小节、两页讲授和一题节末测验。按实际操作顺序讲授核验流程，再处理来源冲突与暂时缺证，不安排概念分类练习。',
        requiredTerms: ['标记', '证据', '待核实'],
      },
    ] as const;
    const outputs: Record<string, unknown> = {};
    for (const current of cases) {
      const fixture = FORMAL_QUALITY_REGRESSION_FIXTURES.find((item) => item.id === current.id)!;
      const sourceContext = fixture.sources.map((source) => `${source.title}\n${source.detail}`).join('\n\n');
      const teachingConstraints = deriveTeachingConstraints({
        grade: fixture.grade, subject: fixture.subject, topic: fixture.title, hours: 1,
        learnerProfile: {
          priorKnowledge: '能够阅读简短的人工智能应用案例。',
          learningNeeds: current.id === 'generation-mechanism-explanation'
            ? '需要从观察到的证据缺口建立因果解释。'
            : '需要把核验要求转化为可执行步骤，并正确处理未知状态。',
          familiarContexts: '人工智能生成校史介绍',
        },
        learningObjectives: [...fixture.learningObjectives],
        knowledgePoints: [...current.knowledgePoints],
      });
      const blueprint = await generateTeachingBlueprint({
        generationModelFingerprint: modelString,
        courseTitle: fixture.title,
        subject: fixture.subject,
        grade: fixture.grade,
        learningObjectives: [...fixture.learningObjectives],
        teachingConstraints,
        projectContext: '检查并改进一段人工智能生成的校史介绍。',
        knowledgePoints: [...current.knowledgePoints],
        totalDurationSec: 240,
        assessmentMode: 'constructed-response',
        generationMode: 'standard',
        teacherBrief: current.teacherBrief,
        sourceContext,
      }, createCourseGenerationAiCall({
        model: resolved.model,
        vision: false,
        source: `teaching-blueprint-${current.id}`,
        thinking: resolved.thinkingConfig,
        maxOutputTokens: 24_000,
        timeoutMs: 20 * 60_000,
        maxRetries: 1,
        streamResponse: true,
      }));
      outputs[current.id] = blueprint;
      const serialized = JSON.stringify(blueprint);
      expect(blueprint.sections).toHaveLength(1);
      expect(blueprint.sections[0]?.pages).toHaveLength(2);
      expect(blueprint.sections[0]?.sharedContext.learningPurpose.length).toBeGreaterThan(0);
      for (const term of current.requiredTerms) expect(serialized).toContain(term);
      expect(serialized).not.toMatch(/教学理论|教学模式|教学方法|主要在解释(?:依据|整体组织|具体做法)/);
    }
    expect(observations.calls.every((call) => (call.thinking as { effort?: string })?.effort === 'high')).toBe(true);
    await fs.writeFile(path.join(runtime, 'blueprints.json'), JSON.stringify(outputs, null, 2));
    await fs.writeFile(path.join(runtime, 'calls.json'), JSON.stringify(observations.calls, null, 2));
    await fs.writeFile(path.join(runtime, 'acceptance.json'), JSON.stringify({
      passed: true,
      finishedAt: new Date().toISOString(),
      model: modelString,
      cases: cases.map((item) => item.id),
      classificationTemplateAbsent: true,
    }, null, 2));
  },
  40 * 60_000,
);

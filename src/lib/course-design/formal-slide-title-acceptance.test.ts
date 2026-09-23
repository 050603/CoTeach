/**
 * Opt-in real-provider acceptance for first-pass instructional slide titles.
 * Run with OPENPBL_RUN_SLIDE_TITLE_ACCEPTANCE=1 and deployment secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

type AcceptanceCase = {
  id: string;
  courseTitle: string;
  subject: string;
  grade: string;
  learningObjectives: string[];
  knowledgePoints: Array<{
    id: string;
    name: string;
    description: string;
    level: 'foundation' | 'core' | 'application';
  }>;
  teacherBrief: string;
  sourceContext: string;
  expectedTitleTerms: RegExp;
  pageCount: number;
};

const cases: AcceptanceCase[] = [
  {
    id: 'instructional-levels-zh',
    courseTitle: '教学目标的层级与分工',
    subject: '教育学',
    grade: '本科一年级',
    learningObjectives: ['解释教学目标的层级结构', '依据目标表述判断所属层级', '在案例中修正层级混淆'],
    knowledgePoints: [
      { id: 'levels', name: '教学目标层级', description: '不同层级目标关注的范围与作用', level: 'foundation' },
      { id: 'roles', name: '层级职责分工', description: '各层级在课程与课时设计中的职责关系', level: 'core' },
      { id: 'classification', name: '目标层级判别', description: '根据对象、范围和达成周期判断目标层级', level: 'application' },
    ],
    teacherBrief: '用内容主题短语命名页面。安排具体导入、概念、关系、案例辨析、独立练习和收束，但不要把导入问题、判断指令或答案写进标题。',
    sourceContext: '课程目标统摄较长周期的学习结果，单元目标连接课程目标与课时安排，课时目标描述当次学习中可观察的达成表现。判断层级时要同时查看作用对象、内容范围和达成周期。',
    expectedTitleTerms: /教学|目标|层级|职责/,
    pageCount: 6,
  },
  {
    id: 'photosynthesis-zh',
    courseTitle: '光合作用的物质与能量变化',
    subject: '生物学',
    grade: '初中一年级',
    learningObjectives: ['解释光合作用的基本过程', '联系条件与产物分析实验现象'],
    knowledgePoints: [
      { id: 'inputs-outputs', name: '光合作用的原料与产物', description: '二氧化碳和水转化为有机物并释放氧气', level: 'foundation' },
      { id: 'energy', name: '光能转化', description: '光能转化并储存在有机物中', level: 'core' },
      { id: 'conditions', name: '光合作用条件分析', description: '用变量控制解释实验现象', level: 'application' },
    ],
    teacherBrief: '用内容主题短语命名每张 PPT；案例、练习和总结页都要写出具体的光合作用主题。',
    sourceContext: '绿色植物在光照条件下，利用二氧化碳和水合成有机物并释放氧气，同时把光能转化为有机物中的化学能。',
    expectedTitleTerms: /光合|二氧化碳|氧气|有机物|光能|条件|变量/,
    pageCount: 4,
  },
  {
    id: 'projectile-motion-en',
    courseTitle: 'Projectile Motion Relationships',
    subject: 'Physics',
    grade: 'Grade 10',
    learningObjectives: ['Explain horizontal and vertical motion components', 'Predict how launch variables change a trajectory'],
    knowledgePoints: [
      { id: 'components', name: 'Motion components', description: 'Horizontal and vertical components evolve differently', level: 'foundation' },
      { id: 'variables', name: 'Launch variables', description: 'Angle and initial speed shape the trajectory', level: 'core' },
      { id: 'prediction', name: 'Trajectory prediction', description: 'Apply component relationships to a new launch', level: 'application' },
    ],
    teacherBrief: 'Use concise content-topic phrases for slide titles. Include a concrete opening, concept, relationship, worked case, practice, and recap without using questions or commands as titles.',
    sourceContext: 'Ignoring air resistance, horizontal velocity remains constant while vertical velocity changes under gravity. Launch angle and initial speed determine the trajectory and range.',
    expectedTitleTerms: /projectile|motion|trajectory|launch|velocity|gravity|range|component/i,
    pageCount: 4,
  },
];

it.skipIf(process.env.OPENPBL_RUN_SLIDE_TITLE_ACCEPTANCE !== '1')(
  'generates content-topic titles across lesson roles, subjects, and languages',
  async () => {
    const secretDir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [
      ['DATABASE_URL', 'database_url.txt'],
      ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt'],
    ] as const) {
      process.env[key] = (await fs.readFile(path.join(secretDir, file), 'utf8')).trim();
    }

    const modelString = process.env.OPENPBL_FORMAL_ACCEPTANCE_MODEL || 'deepseek:deepseek-v4.1-flash';
    const runtime = path.resolve(
      process.env.OPENPBL_SLIDE_TITLE_ACCEPTANCE_DIR
        || '.openpbl-runtime/formal-slide-title-acceptance',
    );
    await fs.mkdir(runtime, { recursive: true });

    const { initializeServerProviderConfig } = await import('@/lib/openmaic/server/provider-config');
    await initializeServerProviderConfig();
    const { resolveModel } = await import('@/lib/openmaic/server/resolve-model');
    const resolved = await resolveModel({ modelString, stage: 'scene-outlines-stream' });
    const { createCourseGenerationAiCall } = await import('@/lib/openmaic/server/course-generation-ai-call');
    const { generateTeachingBlueprint } = await import('./teaching-blueprint');

    const outputs: Record<string, unknown> = {};
    for (const current of cases) {
      const knowledgePointIds = current.knowledgePoints.map((point) => point.id);
      const blueprint = await generateTeachingBlueprint({
        generationModelFingerprint: modelString,
        courseTitle: current.courseTitle,
        subject: current.subject,
        grade: current.grade,
        learningObjectives: current.learningObjectives,
        projectContext: '',
        knowledgePoints: current.knowledgePoints,
        totalDurationSec: current.pageCount * 100 + 120,
        assessmentMode: 'constructed-response',
        generationMode: 'standard',
        teacherBrief: current.teacherBrief,
        sourceContext: current.sourceContext,
        sectionPlans: [{
          title: current.courseTitle,
          knowledgePointIds,
          maxPages: current.pageCount + 1,
          suggestedMinPages: current.pageCount,
          suggestedMaxPages: current.pageCount,
          teachingBudgetSec: current.pageCount * 100,
        }],
      }, createCourseGenerationAiCall({
        model: resolved.model,
        vision: false,
        source: `formal-slide-title-${current.id}`,
        thinking: resolved.thinkingConfig,
        maxOutputTokens: Math.min(resolved.modelInfo?.outputWindow ?? 32_000, 32_000),
        timeoutMs: 20 * 60_000,
        maxRetries: 1,
        streamResponse: true,
      }));

      outputs[current.id] = blueprint;
      await fs.writeFile(
        path.join(runtime, 'blueprints.json'),
        `${JSON.stringify(outputs, null, 2)}\n`,
        'utf8',
      );
      const pages = blueprint.sections.flatMap((section) => section.pages);
      expect(pages.length).toBeGreaterThanOrEqual(current.pageCount);
      for (const page of pages) {
        expect(page.title).toMatch(current.expectedTitleTerms);
        expect(page.title).not.toMatch(/^(?:案例分析|练习|总结|导入|introduction|practice|summary|key takeaways)$/i);
        expect(page.title).not.toMatch(/[?？]$/);
        if (page.entryPoint) expect(page.title).not.toBe(page.entryPoint.object);
        if (page.learningTask?.learnerAction) {
          expect(page.title).not.toBe(page.learningTask.learnerAction);
        }
      }
    }

    await fs.writeFile(
      path.join(runtime, 'blueprints.json'),
      `${JSON.stringify(outputs, null, 2)}\n`,
      'utf8',
    );
  },
  30 * 60_000,
);

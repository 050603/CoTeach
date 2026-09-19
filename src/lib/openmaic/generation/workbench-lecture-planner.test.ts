import { describe, expect, it, vi } from 'vitest';
import { OPENMAIC_BLUE_COURSE_THEME } from './course-visual-theme';
import type { GeneratedSlideContent } from '@openmaic/lib/types/generation';
import {
  buildOpenMaicWorkbenchLecturePlanPrompt,
  generateOpenMaicWorkbenchLecturePlan,
  stripLegacyVisualDirections,
} from './workbench-lecture-planner';

describe('OpenMAIC Workbench lecture planner adapter', () => {
  it('uses the current generate_scene boundary without classic one-click conflicts', () => {
    const prompt = buildOpenMaicWorkbenchLecturePlanPrompt({
      requirement: '为高中生规划 8 个讲授页面，不生成小测。',
      teachingSourceContext: '牛顿第二定律描述合力、质量与加速度的关系。',
      imageGenerationEnabled: true,
    });

    expect(prompt.system).toContain('title, type, brief, and materialFacts');
    expect(prompt.system).toContain('Choose the number of materialFacts');
    expect(prompt.system).toContain('Adjacent segments may jointly establish');
    expect(prompt.system).not.toContain('4-6 materialFacts');
    expect(prompt.system).not.toContain('Across three to five');
    expect(prompt.system).toContain('Plan no quiz pages');
    expect(prompt.system).not.toContain('1-2 scenes per minute');
    expect(prompt.system).not.toContain('110–180');
    expect(prompt.system).not.toContain('18px');
    expect(prompt.system).not.toContain('#5b9bd5');
  });

  it('maps brief and materialFacts while attaching the exact upstream blue theme', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      languageDirective: '使用简体中文讲授。',
      courseTitle: '牛顿第二定律',
      visualDirection: '这项旧的模型选色必须被忽略。',
      pages: [{
        id: 'force-page',
        type: 'slide',
        title: '合力如何改变运动',
        brief: '【全课视觉方向：旧蓝色卡片。】用同一辆小车比较不同合力下的加速度，建立因果链。 【全课视觉方向】旧橙色模板。',
        materialFacts: [
          '加速度方向与物体所受合力方向相同。',
          '质量不变时，合力增大使加速度按比例增大。',
          '合力不变时，质量增大使加速度减小。',
          '小车实验必须比较相同质量或相同合力的条件。',
        ],
      }],
    }));

    const result = await generateOpenMaicWorkbenchLecturePlan({
      requirement: '讲解牛顿第二定律',
    }, ai);

    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({
      id: 'force-page',
      type: 'slide',
      title: '合力如何改变运动',
      description: '用同一辆小车比较不同合力下的加速度，建立因果链。',
      courseVisualTheme: OPENMAIC_BLUE_COURSE_THEME,
    });
    expect(result.data?.outlines[0]?.courseVisualDirection).toContain(OPENMAIC_BLUE_COURSE_THEME.name);
    expect(result.data?.outlines[0]?.courseVisualDirection).not.toContain('旧的模型选色');
    expect(result.data?.outlines[0]?.keyPoints).toHaveLength(4);
    expect(result.data?.outlines[0]?.description).not.toContain('视觉方向');
  });

  it('falls an incomplete interactive page back to a slide', async () => {
    const result = await generateOpenMaicWorkbenchLecturePlan(
      { requirement: '解释反馈回路' },
      vi.fn().mockResolvedValue(JSON.stringify({
        pages: [{
          type: 'interactive',
          title: '反馈回路',
          brief: '改变输入并解释反馈如何累积。',
          materialFacts: ['输入变化会沿回路传播。'],
        }],
      })),
    );

    expect(result.data?.outlines[0]?.type).toBe('slide');
  });

  it('preserves a variable number of distinct facts without padding or truncating evidence', async () => {
    const facts = Array.from({ length: 7 }, (_, index) => `必要证据 ${index + 1}`);
    const result = await generateOpenMaicWorkbenchLecturePlan(
      { requirement: '根据内容安排证据数量' },
      vi.fn().mockResolvedValue(JSON.stringify({ pages: [
        { title: '简单关系', brief: '建立一个关系', materialFacts: ['单一关系'] },
        { title: '综合判断', brief: '结合必要证据完成判断', materialFacts: [...facts, facts[0]] },
      ] })),
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines.map((page) => page.keyPoints)).toEqual([['单一关系'], facts]);
  });

  it('strips both legacy visual-direction forms without deleting semantic copy', () => {
    expect(stripLegacyVisualDirections(
      '【全课视觉方向：科技蓝。】核心论点在这里。 【全课视觉方向】暖白与墨绿。',
    )).toBe('核心论点在这里。');
  });
});

const verificationJobId = process.env.OPENPBL_BASELINE_JOB_ID;
const liveIt = verificationJobId ? it : it.skip;

liveIt('plans a real confirmed resource package with the configured generation model', async () => {
  const [
    { prisma },
    { getCourse },
    { buildOpenMaicKnowledgeLectureRequirement },
    llm,
    provider,
    { resolveModel },
    { createCourseGenerationAiCall },
    { generateOpenMaicBaselineContent },
    { auditSlideDensity, auditSlideLayout },
  ] =
    await Promise.all([
      import('@/lib/db/client'),
      import('@/lib/session/server-store'),
      import('@/lib/course-design/job-runner'),
      import('@/lib/llm/client'),
      import('@openmaic/lib/server/provider-config'),
      import('@openmaic/lib/server/resolve-model'),
      import('@openmaic/lib/server/course-generation-ai-call'),
      import('./openmaic-baseline'),
      import('./slide-layout-audit'),
    ]);
  try {
    await provider.initializeServerProviderConfig();
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: verificationJobId! },
      select: { targetId: true, request: true },
    });
    const course = await getCourse(job.targetId);
    if (!course) throw new Error('verification course is missing');
    const request = job.request as {
      teachingSourceContext?: string;
      enableImageGeneration?: boolean;
      enableVideoGeneration?: boolean;
      generationModelString?: string;
      moduleTimingPlan?: { allocations?: Array<{ stageKey: string; durationMin: number }> };
    };
    const minutes = (request.moduleTimingPlan?.allocations ?? [])
      .filter((allocation) => allocation.stageKey === 'ai-learning')
      .reduce((sum, allocation) => sum + allocation.durationMin, 0);
    const result = await generateOpenMaicWorkbenchLecturePlan({
      requirement: buildOpenMaicKnowledgeLectureRequirement(
        course,
        course.content,
        { courseId: course.id, teacherBrief: '', referenceMaterials: [] } as never,
        minutes,
      ),
      teachingSourceContext: request.teachingSourceContext,
      imageGenerationEnabled: request.enableImageGeneration,
      videoGenerationEnabled: request.enableVideoGeneration,
    }, (system, user) => llm.callLLM(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { jsonMode: true, requestClass: 'long-generation', maxTransientRetries: 2 },
    ));

    expect(result.success).toBe(true);
    const outlines = result.data?.outlines ?? [];
    expect(outlines.length).toBeGreaterThan(0);
    expect(outlines.every((outline) => outline.type !== 'quiz')).toBe(true);
    expect(outlines.filter((outline) => outline.keyPoints.length >= 4).length)
      .toBeGreaterThanOrEqual(Math.ceil(outlines.length * 0.8));
    expect(outlines[0]?.courseVisualDirection).toBeTruthy();
    expect(outlines[0]?.courseVisualTheme).toMatchObject({
      name: 'OpenMAIC Blue',
      background: '#FFFFFF',
      primary: '#5B9BD5',
    });
    expect(outlines.some((outline) => outline.description.includes('全课视觉方向'))).toBe(false);
    const sampledSlides = outlines.filter((outline) => outline.type === 'slide').slice(0, 2);
    if (sampledSlides.length < 2) throw new Error('planner returned fewer than two slide pages');
    const resolved = await resolveModel({
      modelString: request.generationModelString ?? provider.findServerDefaultModelString(),
    });
    const pageAiCall = createCourseGenerationAiCall({
      model: resolved.model,
      vision: resolved.modelInfo?.capabilities?.vision === true,
      source: 'workbench-live-page',
      maxOutputTokens: resolved.modelInfo?.outputWindow,
      thinking: resolved.thinkingConfig,
      timeoutMs: 240_000,
    });
    const sampledContents: GeneratedSlideContent[] = [];
    for (const sampledSlide of sampledSlides) {
      const generated = await generateOpenMaicBaselineContent(sampledSlide, pageAiCall, {
        languageDirective: result.data?.languageDirective,
      });
      expect(generated && 'elements' in generated).toBe(true);
      if (!generated || !('elements' in generated)) {
        throw new Error('page generator returned no slide content');
      }
      sampledContents.push(generated);
    }
    const sampledPageMetrics = sampledContents.map((content, index) => ({
      title: sampledSlides[index]?.title,
      background: content.background,
      themeColors: content.theme?.themeColors,
      elementCount: content.elements.length,
      visibleColors: [...new Set(
        (JSON.stringify(content.elements).match(/#[0-9a-f]{6}/giu) ?? [])
          .map((color) => color.toUpperCase()),
      )],
    }));
    console.info('OPENMAIC_WORKBENCH_PAGES', JSON.stringify({
      model: resolved.modelString,
      sampledPages: sampledPageMetrics,
    }));
    expect(sampledContents.map((content) => content.background))
      .toEqual(sampledContents.map(() => ({ type: 'solid', color: '#FFFFFF' })));
    expect(sampledContents.every((content) => (
      content.theme?.themeColors[0] === '#5B9BD5'
      && content.theme?.themeColors.at(-1) === '#4472C4'
    ))).toBe(true);
    const density = auditSlideDensity(sampledSlides[0]!, sampledContents[0]!);
    const layout = await auditSlideLayout(sampledContents[0]!, sampledSlides[0]!.id);
    console.info('OPENMAIC_WORKBENCH_PLAN', JSON.stringify({
      model: resolved.modelString,
      pageCount: outlines.length,
      types: outlines.map((outline) => outline.type),
      keyPointCounts: outlines.map((outline) => outline.keyPoints.length),
      briefLengths: outlines.map((outline) => outline.description.length),
      visualDirection: outlines[0]?.courseVisualDirection,
      visualTheme: outlines[0]?.courseVisualTheme,
      sampledPages: sampledPageMetrics,
      firstPageAudit: {
        elementCount: sampledContents[0]!.elements.length,
        visibleTextCharacters: density.visibleTextCharacters,
        knowledgeCoverageIssues: density.issues,
        layoutStatus: layout.status,
        layoutIssues: layout.issues,
      },
    }));
  } finally {
    await prisma.$disconnect();
  }
}, 300_000);

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildOutlinePrompt as buildUpstreamOutlinePrompt } from '@openmaic/generation';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import {
  adaptOutlineToOpenMaicBaseline,
  adaptOutlineToOpenMaicWorkbenchContent,
  buildOpenMaicBaselineOutlinePrompt,
  generateOpenMaicBaselineContent,
  generateOpenMaicBaselineOutlines,
  OPENMAIC_GENERATION_BASELINE,
} from './openmaic-baseline';

const PINNED_PROMPT_HASHES = {
  'slide-content/system.md': '36940238cb32a2dd6e410cec5a0043ca33112983be58a0fa5dde530df3727b8c',
  'slide-content/user.md': '787b6ae5e857eeb52ea71e1cda509164342ff00d64b2a843a10c68d0176f276e',
  'slide-actions/user.md': '71a95329793ba0fae6030b6b9eb562bed62e9460bd26c2fcbd92d7c53f549512',
  'requirements-to-outlines/system.md': '344c33e57f72ee86056c12d072c337f609838eab209517a05cc9b57a90b02e32',
  'requirements-to-outlines/user.md': '209a80f3bf46d9463f3b639d227187d02e2d2536ce1b21de1cd202ba744ea156',
} as const;

const outline: SceneOutline = {
  id: 'slide-1',
  type: 'slide',
  title: '随机抽样',
  description: '解释随机抽样的基本目的。',
  keyPoints: ['减少选择偏差'],
  order: 0,
  knowledgePointIds: ['kp-private-id'],
  targetDurationSec: 180,
  timingPlan: {
    providerId: 'test', modelId: 'test', voiceId: 'test', profileId: 'test',
    language: 'zh-CN', speed: 1, targetDurationSec: 180,
    targetUnits: 300, minUnits: 270, maxUnits: 330, unit: 'cjk-char',
    contentType: 'explanation',
  },
  teachingBrief: {
    schemaVersion: 1,
    explanation: '总体中每个个体需要具有明确的被抽取机会。',
    examples: ['使用随机数表选择样本。'],
    conditions: ['抽样框覆盖目标总体。'],
    evidence: [{ sourceId: 'source-1', quote: '样本来自明确界定的目标总体。' }],
    assessmentFocus: '判断抽样过程是否存在选择偏差。',
  },
};

afterAll(async () => { await closeSpatialMeasurementBrowser(); });

describe('pinned OpenMAIC generation baseline', () => {
  it('pins the adaptive content prompts and records the in-place action-prompt improvement', async () => {
    expect(OPENMAIC_GENERATION_BASELINE.release).toBe('v1.0.3');
    expect(OPENMAIC_GENERATION_BASELINE.releaseCommit).toBe(
      'e693e11a81644f84c258df73dbda378643520a62',
    );
    expect(OPENMAIC_GENERATION_BASELINE.version).toBe('0.3.7');
    for (const [file, expected] of Object.entries(PINNED_PROMPT_HASHES)) {
      const body = await readFile(path.join(
        process.cwd(), 'packages', '@openmaic', 'generation', 'templates', file,
      ));
      expect(createHash('sha256').update(body).digest('hex'), file).toBe(expected);
    }
    const actionPrompt = await readFile(path.join(
      process.cwd(), 'packages', '@openmaic', 'generation', 'templates',
      'slide-actions', 'system.md',
    ));
    const actionHash = createHash('sha256').update(actionPrompt).digest('hex');
    expect(OPENMAIC_GENERATION_BASELINE.promptHashes.upstreamSlideActionsSystem)
      .toBe('219e8da1eb3c854dbe6ee6fdedda1936e0092fff6c8984b9277c5c6cef2443b6');
    expect(actionHash).toBe(OPENMAIC_GENERATION_BASELINE.promptHashes.slideActionsSystem);
    expect(actionHash).not.toBe(OPENMAIC_GENERATION_BASELINE.promptHashes.upstreamSlideActionsSystem);
  });

  it('keeps upstream semantic fields unchanged and strips CoTeach orchestration metadata', () => {
    const adapted = adaptOutlineToOpenMaicBaseline(outline);
    expect(adapted.description).toBe('解释随机抽样的基本目的。');
    expect(adapted.keyPoints).toEqual(['减少选择偏差']);
    expect(JSON.stringify(adapted)).not.toContain('样本来自明确界定的目标总体');
    expect(JSON.stringify(adapted)).not.toContain('检测重点');
    expect(adapted).not.toHaveProperty('knowledgePointIds');
    expect(adapted).not.toHaveProperty('timingPlan');
    expect(adaptOutlineToOpenMaicBaseline({
      ...outline,
      description: '页面目的。\n资源说明：来自资源包的事实。\n掌握边界：学生能够解释条件。',
    }).description).toBe('页面目的。\n资源说明：来自资源包的事实。\n掌握边界：学生能够解释条件。');
    expect(adaptOutlineToOpenMaicBaseline({
      ...outline,
      keyPoints: ['相同事实', '相同事实'],
    }).keyPoints).toEqual(['相同事实', '相同事实']);
  });

  it('builds the same one-click outline prompt as the upstream package', () => {
    const requirements = {
      requirement: '为初中生讲解随机抽样',
      userNickname: 'Learner',
      generationMode: 'deep-interaction' as const,
      teachingSourceContext: 'CoTeach-only source',
    };
    const context = {
      pdfText: '抽样资料原文',
      imageGenerationEnabled: true,
      researchContext: '已核验研究资料',
    };
    expect(buildOpenMaicBaselineOutlinePrompt(requirements, context)).toEqual(
      buildUpstreamOutlinePrompt(
        { requirement: requirements.requirement, userNickname: requirements.userNickname },
        context,
      ),
    );
  });

  it('returns the upstream outline without manufacturing a page-level quiz', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      languageDirective: '使用中文',
      outlines: [{
        id: 'official-page', type: 'slide', title: '随机抽样',
        description: '解释随机抽样。', keyPoints: ['随机性'], order: 0,
      }],
    }));
    const result = await generateOpenMaicBaselineOutlines(
      { requirement: '讲解随机抽样' },
      undefined,
      undefined,
      ai,
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines.map((item) => item.type)).toEqual(['slide']);
    expect(ai.mock.calls[0]?.[0]).toContain('# Scene Outline Generator');
  });

  it('keeps the official slide prompt and adds the shared teaching design only through the adapter', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [{
      type: 'text', left: 60, top: 60, width: 800, height: 80,
      content: '<p><span style="font-size:32px">随机抽样</span></p>',
    }] }));
    const result = await generateOpenMaicBaselineContent({
      ...outline,
      teachingBrief: {
        ...outline.teachingBrief!,
        teachingPlan: {
          purpose: '比较两种抽样结果', priorKnowledge: '会读百分比', newContent: '样本构成会影响估计结果',
          learnerQuestion: '两组比例差异怎样看得更清楚', reasoningSteps: ['对齐两组类别', '比较比例差异'],
          takeaway: '随机抽样用于减少选择偏差', visibleContent: ['甲组 42%', '乙组 68%'],
          narrationFocus: ['解释柱高差异对应的实际含义'],
          visualRelationship: {
            kind: 'quantitative', description: '比较两组比例的量级差异', readingOrder: ['甲组', '乙组', '差异'],
            preferredForm: 'chart', rationale: '共同零点的柱高便于比较量级',
          },
        },
      },
    }, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(1);
    expect(ai).toHaveBeenCalledOnce();
    const [system, user] = ai.mock.calls[0];
    expect(system).toContain('# Slide Content Generator');
    expect(system).toContain('Choose the representation from the teaching need');
    expect(system).toContain('There is no requirement to use a certain number of formats');
    expect(system).toContain('CoTeach teaching enhancement adapter');
    expect(system).toContain('Instructional Slide Title Contract');
    expect(user).toContain('- **Title**: 随机抽样');
    expect(user).toContain('render `随机抽样` verbatim as the visible primary heading');
    expect(system).not.toContain('使用随机数表选择样本');
    expect(user).toContain('使用随机数表选择样本');
    expect(user).toContain('样本来自明确界定的目标总体');
    expect(user).toContain('"preferredForm":"chart"');
    expect(user).toContain('preferredForm and rationale are pedagogical preferences');
    expect(user).toContain('Do not invent values, media IDs, or extra claims to satisfy variety');
    expect(`${system}\n${user}`).not.toContain('Semantic page and narration budget');
    expect(`${system}\n${user}`).not.toContain('Course visual system');
    expect(`${system}\n${user}`).not.toContain('spatial budget');
    expect(`${system}\n${user}`).not.toContain('kp-private-id');
  });

  it('adds only the measured website reference profile when production opts in', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [{
      type: 'text', left: 60, top: 60, width: 800, height: 80,
      content: '<p><span style="font-size:32px">随机抽样</span></p>',
    }] }));
    await generateOpenMaicBaselineContent(outline, ai, {
      websiteReferenceContext: {
        courseTitle: '统计入门',
        slideTitles: ['随机抽样', '抽样误差'],
      },
    });

    const [system, user] = ai.mock.calls[0];
    expect(system).toContain('# Slide Content Generator');
    expect(system).toContain('OpenMAIC website course-deck reference profile');
    expect(system).toContain('CoTeach teaching enhancement adapter');
    expect(system).toContain('#1E3A8A/#1E40AF');
    expect(system).toContain('Never use a table merely as a grid');
    expect(user).toContain('Course title: 统计入门');
    expect(user).toContain('随机抽样 | 抽样误差');
    expect(user).toContain('总体中每个个体需要具有明确的被抽取机会');
    expect(`${system}\n${user}`).not.toContain('kp-private-id');
    expect(`${system}\n${user}`).not.toContain('targetDurationSec');
    expect(`${system}\n${user}`).not.toContain('spatial budget');
  });

  it.each(['text', 'table', 'chart', 'illustration'] as const)(
    'keeps a %s preference free of diagram requirements when the continuation owns no diagram', async (preferredForm) => {
      const point = '随机抽样用于减少选择偏差。';
      const page: SceneOutline = {
        ...outline, id: 'diagram-source--capacity-2', sourcePageIds: ['diagram-source'], spatialParentId: 'diagram-source',
        audience: 'student', generationPurpose: 'knowledge-teaching',
        visualIntent: { representation: 'text', observationGoal: point },
        teachingBrief: { ...outline.teachingBrief!, teachingPlan: {
          purpose: '解释随机抽样的意义', priorKnowledge: '知道总体和样本', newContent: point,
          learnerQuestion: '怎样减少选择偏差', reasoningSteps: ['明确总体', '说明随机抽样'], takeaway: point,
          visibleContent: [point], presentationContent: [point], narrationFocus: ['解释为何随机选择有助于减少偏差'],
          visualRelationship: { kind: 'statement', description: point, readingOrder: [point], preferredForm,
            rationale: '依据本页实际内容选择清晰的表达方式' },
        } },
      };
      const failure = vi.fn();
      const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
        { kind: 'textBox', left: 60, top: 140, width: 880, fontSize: 24, paragraphRefs: ['adopted-content-1'] },
      ] }));
      const slide = await generateOpenMaicBaselineContent(page, ai, {
        componentAuthoring: true, onFailure: failure,
        textMeasure: ({ text, fontSize, padding, lineHeight }) => ({ naturalWidth: [...text].length * fontSize,
          height: padding * 2 + fontSize * lineHeight, lines: [text] }),
      });
      expect(ai).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
      expect(slide && 'elements' in slide ? slide.elements.filter((element) => element.type === 'line') : []).toHaveLength(0);
      expect(slide && 'elements' in slide ? slide.elements.some((element) => element.type === 'text' && element.content.includes(point)) : false).toBe(true);
      const [system, user] = ai.mock.calls[0];
      expect(user).toContain(`"preferredForm":"${preferredForm}"`);
      expect(system).toContain('There is no requirement to use a certain number of formats');
      expect(user).not.toContain('exactly one local diagram component for this authoritative relationship');
      expect(user).not.toContain('Measured feasible diagram rectangles');
      expect(adaptOutlineToOpenMaicBaseline(page).visualIntent?.diagram).toBeUndefined();
    });

  it('compiles concise adopted points in the first call while keeping the original source independent', async () => {
    const clauses = [
      '选择探究材料时，需要同时保留正例、反例和适用条件。',
      '设计实验任务时，要依据学生的认知能力调整难度与复杂程度。',
      '开展实践活动时，需要引导学生同步分析安全与伦理问题。',
    ];
    const points = ['保留正例、反例与适用条件', '依据认知能力调整任务难度与复杂程度', '实践中同步分析安全与伦理'];
    const page: SceneOutline = {
      ...outline,
      keyPoints: ['探究材料、实验任务和实践活动的设计'],
      generationPurpose: 'knowledge-teaching',
      teachingBrief: {
        ...outline.teachingBrief!,
        designVersion: 'teaching-blueprint-v3-compiled-v12-learning-boundary',
        teachingPlan: {
          purpose: '完整执行三个设计要求', priorKnowledge: '已知探究活动的目的',
          newContent: '材料、任务与实践的约束', learnerQuestion: '怎样保留完整条件',
          reasoningSteps: [], takeaway: '依据条件设计活动', visibleContent: clauses,
          presentationContent: points,
          narrationFocus: ['用具体实例解释每条约束的作用'],
        },
      },
    };
    // The original passage is not canvas copy. The first response compiles
    // only the already adopted, accurate presentation points.
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [{
      kind: 'textBox', id: 'adopted-source-text', role: 'body', left: 60, top: 140,
      width: 880, height: 240, fontSize: 22,
      paragraphRefs: adoptedPageAuthoringContent(page).map((item) => item.id),
    }] }));
    const { generateSceneContent } = await import('./scene-generator');
    const generated = await generateSceneContent(page, ai, {
      componentAuthoring: true, textMeasure: measureAuthoredSlideText,
    });

    expect(generated && 'elements' in generated).toBe(true);
    expect(ai).toHaveBeenCalledOnce();
    const [system, user] = ai.mock.calls[0];
    for (const clause of clauses) expect(user).toContain(clause);
    expect(user).toContain('it need not reproduce the book sentence');
    expect(user).toContain('original-source channel for narration');
    expect(user).toContain('do not derive, rewrite, shorten or expand them again');
    expect(user).not.toContain('Derive accurate presentation points directly from these original sources');
    expect(user.lastIndexOf('Current page first-draft decisions')).toBeGreaterThan(user.lastIndexOf('Original teaching sources for this page'));
    expect(system).toContain('# Slide Content Generator');
    expect(system).toContain('definitions need not appear verbatim on the slide');
    expect(`${system}\n${user}`).not.toContain('kp-private-id');
    const visible = generated && 'elements' in generated ? generated.elements.flatMap((element) =>
      element.type === 'text' ? [element.content.replace(/<[^>]+>/g, '')] : []).join('\n') : '';
    for (const point of points) expect(visible).toContain(point);
    for (const clause of clauses) expect(visible).not.toContain(clause);
    expect(visible).not.toContain('adopted-content-');
  }, 20_000);

  it('keeps stale local visual directions out of the official first-draft boundary', async () => {
    const adapted = adaptOutlineToOpenMaicWorkbenchContent({
      ...outline,
      generationPurpose: 'knowledge-teaching',
      courseVisualDirection: '暖白底色、墨绿主色、珊瑚色强调，以抽样路径为图形母题。',
    });
    expect(adapted.description).toBe(outline.description);
    expect(adapted.description).not.toContain('暖白底色、墨绿主色、珊瑚色强调');
    expect(adapted.description).not.toContain('110–180');
    expect(adapted.description).not.toContain('18px');
    expect(adaptOutlineToOpenMaicBaseline({
      ...outline,
      generationPurpose: 'knowledge-teaching',
    }).description).toBe(outline.description);

    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [{
      type: 'text', left: 60, top: 60, width: 800, height: 80,
      content: '<p><span style="font-size:32px">随机抽样</span></p>',
    }] }));
    const generated = await generateOpenMaicBaselineContent({
      ...outline,
      generationPurpose: 'knowledge-teaching',
      courseVisualDirection: '暖白底色、墨绿主色、珊瑚色强调，以抽样路径为图形母题。',
    }, ai);
    expect(ai.mock.calls[0]?.[1]).not.toContain('Course-wide visual theme contract');
    expect(ai.mock.calls[0]?.[1]).not.toContain('#5B9BD5');
    expect(ai.mock.calls[0]?.[1]).not.toContain('#4472C4');
    expect(ai.mock.calls[0]?.[1]).not.toContain('暖白底色、墨绿主色、珊瑚色强调');
    expect(ai.mock.calls[0]?.[1]).not.toContain('visible Chinese characters');
    expect(generated && 'elements' in generated ? generated.background : undefined).toBeUndefined();
    expect(generated && 'elements' in generated ? generated.theme : undefined).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AICallFn } from './pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  enhanceTeachingBriefs,
  buildTeachingEnhancementPrompt,
  hasCurrentTeachingBrief,
  hasCompleteTeachingBrief,
  normalizeTeachingEnhancement,
  TEACHING_ENHANCEMENT_VERSION,
  withTeachingEnhancement,
} from './teaching-enhancement';

function page(id: string, order: number): SceneOutline {
  return {
    id,
    type: 'slide',
    title: `页面${order + 1}`,
    description: '解释人工智能输出与证据之间的关系。',
    keyPoints: ['流畅表达不能代替事实核验'],
    teachingObjective: '能够说明核验步骤和理由',
    order,
    generationPurpose: 'knowledge-teaching',
    parentActivityId: 'section-1',
  };
}

const teachingPlan = {
  purpose: '解释事实核验依据', priorKnowledge: '会区分主张和证据', newContent: '判断来源是否独立',
  learnerQuestion: '多个网页为什么不一定是多份证据', reasoningSteps: ['检查是否转载同一来源'],
  takeaway: '判断来源独立性，而不是只数网页', visibleContent: ['转载来源之间的关系'],
  narrationFocus: ['为什么同源转载不能相互证实'], introduces: ['node-1'], deepens: [], references: [],
  entryPoint: { kind: 'familiar-experience' as const, object: '搜索同一校史年份却看到多个相同网页', bridge: '从网页很多是否等于证据很多，引出来源独立性' },
};
const sharedContext = {
  learningPurpose: '判断信息能否作为可靠依据', caseId: 'school-history-check',
  caseFacts: ['多个网页可能转载同一份校史材料'], fixedWording: ['先确认来源关系'],
  stableTerms: ['独立来源', '同源转载'], conceptBoundaries: ['网页数量不等于独立证据数量'],
};

describe('formal course teaching enhancement', () => {
  it('treats malformed stored briefs as incomplete instead of crashing a resumed job', () => {
    const malformed = page('p1', 0);
    malformed.teachingBrief = {
      schemaVersion: 1,
      explanation: '已有解释',
      examples: undefined,
      conditions: ['已有条件'],
      evidence: [],
      assessmentFocus: '已有考查重点',
    } as unknown as NonNullable<SceneOutline['teachingBrief']>;
    expect(hasCompleteTeachingBrief(malformed)).toBe(false);
  });

  it('accepts complete page designs and keeps only exact source evidence', () => {
    const source = '指导文件要求：学生需要核验生成内容的事实与来源。';
    const briefs = normalizeTeachingEnhancement({ sharedContext, pages: [{
      outlineId: 'p1',
      explanation: '表达流畅来自语言模式，不能证明事实成立。',
      examples: ['核对校史年份：先标出主张，再查官方校志并记录差异。'],
      conditions: ['官网转载同一错误时，不能算作独立来源。'],
      assessmentFocus: '说明核验步骤以及每一步的理由。',
      teachingPlan, evidenceQuotes: ['学生需要核验生成内容的事实与来源', '并不存在的原句'],
    }] }, [page('p1', 0)], source);
    const brief = briefs.get('p1');
    expect(brief?.examples).toHaveLength(1);
    expect(brief?.conditions).toHaveLength(1);
    expect(brief?.teachingPlan?.entryPoint).toEqual(teachingPlan.entryPoint);
    expect(brief?.evidence).toEqual([
      { sourceId: 'course-source', quote: '学生需要核验生成内容的事实与来源' },
    ]);
  });

  it('recovers a single-page section when the model returns a placeholder outline id', () => {
    const briefs = normalizeTeachingEnhancement({ sharedContext, pages: [{
      outlineId: 'x',
      explanation: '教学模式需要按学习目标、内容性质和课堂条件选择。',
      examples: [],
      conditions: ['模式适配是倾向，不是绝对限制。'],
      assessmentFocus: '能根据目标说明模式选择理由。',
      teachingPlan,
      evidenceQuotes: [],
    }] }, [page('actual-outline-id', 0)]);

    expect(briefs.get('actual-outline-id')).toMatchObject({
      explanation: '教学模式需要按学习目标、内容性质和课堂条件选择。',
      designVersion: TEACHING_ENHANCEMENT_VERSION,
    });
  });

  it('does not guess placeholder outline ids for multi-page sections', () => {
    const responsePage = {
      outlineId: 'x',
      explanation: '无法安全确定属于哪一页。',
      examples: [],
      conditions: [],
      assessmentFocus: '说明理由。',
      teachingPlan,
      evidenceQuotes: [],
    };

    expect(() => normalizeTeachingEnhancement(
      { sharedContext, pages: [responsePage, { ...responsePage, outlineId: 'y' }] },
      [page('p1', 0), page('p2', 1)],
    )).toThrow('教学增强缺少页面');
  });

  it('creates one shared design call and propagates page briefs into the section quiz', async () => {
    const pages = [page('p1', 0), page('p2', 1)];
    const quiz = {
      ...page('quiz', 2),
      type: 'quiz' as const,
      quizConfig: { questionCount: 2, difficulty: 'medium' as const, questionTypes: ['short_answer' as const] },
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ sharedContext, pages: pages.map((item) => ({
      outlineId: item.id,
      explanation: `${item.id} 的机制解释`,
      examples: [`${item.id} 的完整示例`],
      conditions: [`${item.id} 的适用条件`],
      assessmentFocus: `${item.id} 的解释与应用`,
      teachingPlan, evidenceQuotes: [],
    })) }));
    const outlines = await enhanceTeachingBriefs({
      outlines: [...pages, quiz],
      courseTitle: '生成式人工智能通识',
      requirement: '面向中学生讲解人工智能核验',
      aiCall: ai,
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(outlines.slice(0, 2).every(hasCompleteTeachingBrief)).toBe(true);
    expect(outlines[2]?.teachingBrief?.examples).toEqual(['p1 的完整示例', 'p2 的完整示例']);
    expect(outlines[2]?.teachingBrief?.assessmentFocus).toContain('p1 的解释与应用');
  });

  it('splits teaching design by section and reports bounded progress', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => {
      const outlineId = user.includes('[p1]') ? 'p1' : 'p2';
      return JSON.stringify({ sharedContext, pages: [{
        outlineId,
        explanation: `${outlineId} 的机制解释`,
        examples: [`${outlineId} 的完整示例`],
        conditions: [`${outlineId} 的适用条件`],
        assessmentFocus: `${outlineId} 的解释与应用`,
        teachingPlan, evidenceQuotes: [],
      }] });
    });
    const outlines = await enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '分小节完成教学设计',
      aiCall: ai,
      concurrency: 2,
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls.every(([, user]) => !(user.includes('[p1]') && user.includes('[p2]')))).toBe(true);
    expect(outlines.every(hasCompleteTeachingBrief)).toBe(true);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('restores a completed section design without repeating its model call', async () => {
    const first = page('p1', 0);
    let saved: {
      sectionKey: string;
      inputFingerprint: string;
      modelFingerprint: string;
      briefs: Array<[string, unknown]>;
    } | null = null;
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ sharedContext, pages: [{
      outlineId: first.id,
      explanation: '语言流畅来自模式匹配，不能单独证明事实正确。',
      examples: ['标出年份主张，再到独立原始资料中逐项核对。'],
      conditions: ['同源转载不能当作多个独立来源。'],
      assessmentFocus: '说明核验步骤以及每一步的理由。',
      teachingPlan, evidenceQuotes: [],
    }] }));
    const common = {
      outlines: [first],
      requirement: '恢复小节教学设计',
      modelFingerprint: 'model-a',
    };
    await enhanceTeachingBriefs({
      ...common,
      aiCall: ai,
      onSectionCompleted: (sectionKey, inputFingerprint, modelFingerprint, briefs) => {
        saved = { sectionKey, inputFingerprint, modelFingerprint, briefs };
      },
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(saved).not.toBeNull();

    const resumedAi = vi.fn<AICallFn>().mockRejectedValue(new Error('must not be called'));
    const resumed = await enhanceTeachingBriefs({
      ...common,
      aiCall: resumedAi,
      loadSectionCheckpoint: (sectionKey, inputFingerprint, modelFingerprint) => (
        saved
        && saved.sectionKey === sectionKey
        && saved.inputFingerprint === inputFingerprint
        && saved.modelFingerprint === modelFingerprint
          ? saved.briefs
          : null
      ),
    });
    expect(resumedAi).not.toHaveBeenCalled();
    expect(resumed.every(hasCompleteTeachingBrief)).toBe(true);
  });

  it('rejects an incomplete course design instead of silently mixing enhanced and baseline pages', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const warnings: string[] = [];
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => (
      user.includes('[p1]')
        ? JSON.stringify({ sharedContext, pages: [{
            outlineId: 'p1',
            explanation: 'p1 的机制解释',
            examples: ['p1 的完整示例'],
            conditions: ['p1 的适用条件'],
            assessmentFocus: 'p1 的解释与应用',
            teachingPlan, evidenceQuotes: [],
          }] })
        : '{"pages":['
    ));
    await expect(enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '一个小节失败时保留其他增强结果',
      aiCall: ai,
      retrySleep: async () => undefined,
      concurrency: 4,
      onWarning: (warning) => { warnings.push(warning); },
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    })).rejects.toThrow('教学增强未完整生成');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('页面2');
    expect(ai).toHaveBeenCalledTimes(3);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('keeps the system prefix stable while putting page design only in the user message', async () => {
    const first = page('p1', 0);
    first.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释一', examples: ['例子一'], conditions: ['条件一'], evidence: [], assessmentFocus: '考查一',
    };
    const second = page('p2', 1);
    second.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释二', examples: ['例子二'], conditions: ['条件二'], evidence: [], assessmentFocus: '考查二',
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue('ok');
    await withTeachingEnhancement(ai, first, 'content')('base-system', 'base-user');
    await withTeachingEnhancement(ai, second, 'content')('base-system', 'base-user');
    expect(ai.mock.calls[0]?.[0]).toBe(ai.mock.calls[1]?.[0]);
    expect(ai.mock.calls[0]?.[0]).not.toContain('解释一');
    expect(ai.mock.calls[0]?.[1]).toContain('解释一');
    expect(ai.mock.calls[0]?.[1]).toContain('Use teachingPlan.visualRelationship');
    expect(ai.mock.calls[0]?.[1]).toContain('Keep introduces/deepens/references as page ownership boundaries');
    expect(ai.mock.calls[0]?.[1]).toContain('Never print internal IDs, provenance, source status, review items');
    expect(ai.mock.calls[1]?.[1]).toContain('解释二');
  });
});

 describe('adaptive teaching contracts', () => {
  it('allows a focused page with no extra example or boundary and preserves its explanation responsibilities', () => {
    const brief = normalizeTeachingEnhancement({ sharedContext, pages: [{ outlineId: 'p1', explanation: '检查多个页面是否转载同一来源',
      examples: [], conditions: [], assessmentFocus: '识别同源转载', evidenceQuotes: [], teachingPlan }] }, [page('p1', 0)]).get('p1')!;
    expect(brief.examples).toEqual([]);
    expect(brief.conditions).toEqual([]);
    expect(brief.teachingPlan).toEqual(teachingPlan);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: brief })).toBe(true);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: { ...brief, designVersion: 'old' } })).toBe(false);
  });
  it('includes learner readiness and adjacent-page responsibilities in the authoring prompt', async () => {
    const { deriveTeachingConstraints } = await import('@openmaic/lib/pedagogy/teaching-constraints');
    const prompt = buildTeachingEnhancementPrompt({ requirement: '完成来源核验', pages: [page('p1', 0)],
      courseProgression: [page('p1', 0), page('p2', 1)],
      teachingConstraints: deriveTeachingConstraints({ grade: '八年级', learnerProfile: {
        priorKnowledge: '会比较网页来源', learningNeeds: '需要区分转载和独立证据', familiarContexts: '校史调查',
      } }),
    });
    expect(prompt.user).toContain('会比较网页来源');
    expect(prompt.user).toContain('需要区分转载和独立证据');
    expect(prompt.user).toContain('校史调查');
    expect(prompt.user).toContain('p2');
    expect(prompt.user).toContain('"resourcePosition":"course-opening"');
    expect(prompt.user).toContain('不同知识适合不同例子时可以自然更换');
    expect(prompt.user).toContain('entryPoint、introduces、deepens、references 和 visualRelationship');
    expect(prompt.user).toContain('不要求连接项目任务或后续活动');
    expect(prompt.system).toContain('实际学习者由学段、专业和 learner profile 决定');
    expect(prompt.system).toContain('即使课程前面存在教师导入阶段');
    expect(prompt.system).toContain('测验后的反馈完成收束');
    expect(prompt.user).toContain('差异可对照，过程可用连续状态或流程');
    expect(prompt.user).toContain('后台字段不得进入学生页面或讲稿');
    expect(prompt.user).toContain('每页新增认识是否有充分解释支撑');
    expect(prompt.system).toContain('概念与区别可从熟悉对象');
    expect(prompt.system).not.toContain('相对稳定');
    expect(prompt.system).not.toContain('具体化');
    expect(prompt.system).toContain('Write for hearing once');
  });

  it('fills only a missing page while preserving the section case and completed sibling design', async () => {
    const completed = page('p1', 0);
    completed.teachingBrief = {
      schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '第一页已经完整解释为什么网页数量不能代表独立证据数量。', examples: ['完整案例'],
      conditions: ['同源转载不独立'], evidence: [], assessmentFocus: '说明来源关系',
    };
    const missing = page('p2', 1);
    const existingTask = { learnerAction: '只改变提问方式后判断主要变化', newContribution: '辨析条件变化',
      reasoningFocus: '判断表述主要承担的功能', caseUse: 'variant' as const,
      changedConditions: ['把对比表换成口头提问'], preservedConditions: ['课堂流程和学习目标不变'] };
    missing.teachingBrief = {
      schemaVersion: 1, designVersion: 'outdated', sharedContext, pageTask: existingTask,
      explanation: '蓝图中的第二页解释', examples: ['蓝图中的完整变式'], conditions: [], evidence: [], assessmentFocus: '说明理由',
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({
      sharedContext: { ...sharedContext, fixedWording: ['模型擅自改写'] },
      pages: [{ outlineId: 'p2', pageTask: { ...existingTask, changedConditions: ['模型擅自改变另一条件'] },
        explanation: '展开第二页的新判断', examples: ['保留原安排，只改变提问方式'], conditions: [],
        assessmentFocus: '说明变化主要发生在哪一层', teachingPlan, evidenceQuotes: [] }],
    }));
    const result = await enhanceTeachingBriefs({
      outlines: [completed, missing], requirement: '完成同一案例的条件辨析',
      courseProgression: [completed, missing], aiCall: ai,
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]?.[1]).toContain('第一页已经完整解释为什么网页数量不能代表独立证据数量');
    expect(ai.mock.calls[0]?.[1]).toContain('蓝图中的完整变式');
    expect(result[0]?.teachingBrief).toEqual(completed.teachingBrief);
    expect(result[1]?.teachingBrief?.sharedContext).toEqual(sharedContext);
    expect(result[1]?.teachingBrief?.pageTask).toEqual(existingTask);
  });

  it('adds supported missing case facts while preserving adopted wording and terms', () => {
    const adopted = {
      ...sharedContext,
      caseId: '',
      caseFacts: [],
    };
    const generated = {
      ...sharedContext,
      caseId: 'school-history-check',
      caseFacts: ['目标：判断校史年份是否有独立来源支持', '行为：先标出年份主张，再核对校志', '预期结果：能识别同源转载'],
      fixedWording: ['模型不应替换这句话'],
      stableTerms: ['模型新造术语'],
    };
    const brief = normalizeTeachingEnhancement({
      sharedContext: generated,
      pages: [{
        outlineId: 'p1', explanation: '来源关系决定证据是否独立。', examples: [], conditions: [],
        assessmentFocus: '说明来源关系和判断理由。', teachingPlan, evidenceQuotes: [],
      }],
    }, [page('p1', 0)], '', { sharedContext: adopted }).get('p1')!;

    expect(brief.sharedContext).toMatchObject({
      caseId: 'school-history-check',
      caseFacts: generated.caseFacts,
      fixedWording: sharedContext.fixedWording,
      stableTerms: sharedContext.stableTerms,
    });
  });
});

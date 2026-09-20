import { describe, expect, it } from 'vitest';
import {
  applyConfirmedPblTimingPlan,
  assessPblTeachingOutlineStructure,
  createPblTimingSkeleton,
  normalizePblTeachingOutline,
  normalizeTeachingModuleResourceTypes,
} from './pbl-outline-normalization';
import { buildPblModuleTimingPlan } from './pbl-time-model';

describe('PBL teaching outline normalization', () => {
  it('keeps only resource choices that the fixed six-stage runtime can consume', () => {
    const ordinary = createPblTimingSkeleton({ totalMinutes: 60 })[0]!;
    const aiLearning = createPblTimingSkeleton({ totalMinutes: 60 })[1]!;

    expect(normalizeTeachingModuleResourceTypes({
      ...ordinary,
      resourceTypes: ['interactive-demo', 'worksheet', 'project-brief'],
    })).toEqual(['ppt', 'script']);
    expect(normalizeTeachingModuleResourceTypes({
      ...aiLearning,
      resourceTypes: ['ppt', 'interactive-demo', 'code-interactive', 'script', 'rubric'],
    })).toEqual(['ppt', 'interactive-demo', 'code-interactive']);
    expect(normalizeTeachingModuleResourceTypes({
      ...aiLearning,
      resourceTypes: ['worksheet', 'rubric', 'project-brief'],
    })).toEqual(['ppt', 'interactive-demo', 'code-interactive']);
  });

  it('does not manufacture canonical modules for an empty draft', () => {
    expect(normalizePblTeachingOutline([], { totalMinutes: 60 })).toEqual([]);
  });

  it('fills missing canonical modules and puts all confirmed knowledge IDs in AI learning', () => {
    const result = normalizePblTeachingOutline(
      [
        {
          id: 'to-knowledge',
          stageKey: 'ai-learning',
          title: '知识讲解',
          durationMin: 120,
          teachingGoal: '理解基础概念',
          teacherRole: '点拨',
          platformRole: '展示',
          aiRole: '讲解',
          studentActivity: '学习',
          openMaicUse: 'student-ai-learning',
        },
      ],
      {
        totalMinutes: 120,
        topic: '校园节能项目',
        grade: '六年级',
        difficulty: 'standard',
        knowledgePoints: [
          { id: 'kp-1', name: '数据', description: '' },
          { id: 'kp-2', name: '证据', description: '' },
        ],
      },
    );

    expect(result.map((activity) => activity.stageKey).slice(0, 6)).toEqual([
      'launch',
      'ai-learning',
      'proposal',
      'make',
      'showcase',
      'reflection',
    ]);
    expect(result.find((activity) => activity.stageKey === 'ai-learning')?.knowledgePointIds).toEqual([
      'kp-1',
      'kp-2',
    ]);
    expect(result.reduce((sum, activity) => sum + activity.durationMin, 0)).toBe(120);
    expect(result.find((activity) => activity.stageKey === 'make')?.durationMin).toBeGreaterThan(
      result.find((activity) => activity.stageKey === 'ai-learning')?.durationMin ?? 0,
    );
  });

  it('creates a timing-only six-stage skeleton after the knowledge graph is ready', () => {
    const result = createPblTimingSkeleton({
      totalMinutes: 90,
      knowledgePoints: [{ id: 'kp-1', name: '证据', description: '' }],
    });

    expect(result).toHaveLength(6);
    expect(result.map((activity) => activity.stageKey)).toEqual([
      'launch',
      'ai-learning',
      'proposal',
      'make',
      'showcase',
      'reflection',
    ]);
    expect(result.find((activity) => activity.stageKey === 'ai-learning')?.studentActivity)
      .toContain('只在有助于理解或迁移时连接驱动问题');
    expect(result.reduce((sum, activity) => sum + activity.durationMin, 0)).toBe(90);
  });

  it('merges repeated knowledge and practice outputs into the canonical stage', () => {
    const base = createPblTimingSkeleton({ totalMinutes: 90 });
    const result = normalizePblTeachingOutline(
      [
        ...base,
        { ...base[1]!, id: 'knowledge-extra', knowledgePointIds: ['kp-2'], teachingGoal: '补充知识二' },
        { ...base[3]!, id: 'practice-extra', studentActivity: '第二项实践任务' },
      ],
      {
        totalMinutes: 90,
        applyTimeModel: false,
        knowledgePoints: [
          { id: 'kp-1', name: '知识一', description: '' },
          { id: 'kp-2', name: '知识二', description: '' },
        ],
      },
    );

    expect(result).toHaveLength(6);
    expect(result.filter((activity) => activity.stageKey === 'ai-learning')).toHaveLength(1);
    expect(result.filter((activity) => activity.stageKey === 'make')).toHaveLength(1);
    expect(result[1]?.knowledgePointIds).toEqual(['kp-1', 'kp-2']);
    expect(result[3]?.studentActivity).toContain('第二项实践任务');
    expect(assessPblTeachingOutlineStructure(result)).toEqual([]);
  });

  it('rejects a confirmed generation response that omits a canonical stage', () => {
    const skeleton = createPblTimingSkeleton({ totalMinutes: 60 });
    const plan = buildPblModuleTimingPlan(60, skeleton, undefined, {
      status: 'confirmed',
      preserveCurrentDurations: true,
    });

    expect(() => applyConfirmedPblTimingPlan(
      skeleton.filter((activity) => activity.stageKey !== 'reflection'),
      plan,
      { totalMinutes: 60 },
    )).toThrow('AI 未生成 学习反思与迁移');
  });
});

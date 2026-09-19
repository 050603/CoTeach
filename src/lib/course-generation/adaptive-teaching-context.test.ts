import { describe, expect, it } from 'vitest';
import type { AdaptiveBranchOutline, AdaptiveLearningPlan, Course } from '@/lib/session/types';
import { buildAdaptiveBranchTeachingContext } from './adaptive-teaching-context';
import { formatTeachingConstraintsForPrompt } from '@/lib/openmaic/pedagogy/teaching-constraints';

const course = {
  name: '分类模型', grade: '八年级', subject: '信息科技', hours: 1,
  learningObjectives: ['解释独立检验'],
  learnerProfile: { priorKnowledge: '会按可见特征分类', learningNeeds: '需要展开因果关系', familiarContexts: '校园植物' },
  content: { knowledgePoints: [
    { id: 'test', name: '独立检验', description: '使用未参与训练的数据检验' },
    { id: 'other', name: '其他知识', description: '本分支无需讲授' },
  ] },
} as Course;
const branch: AdaptiveBranchOutline = {
  id: 'branch', kind: 'worked-example', title: '判断一次检验是否独立', objective: '说明数据用途的区别',
  keyPoints: ['区分训练与检验'], anchorKnowledgePointIds: ['test'], prerequisiteKnowledgePointIds: ['classify'],
  noveltyStatement: '用新的校园植物例子解释', mainCourseOverlapSceneIds: [], sceneType: 'slide',
  targetDurationSec: 120, status: 'teacher-confirmed', generationGuidance: '从对照图开始解释',
};
const plan = {
  prerequisiteKnowledgePoints: [{ id: 'classify', name: '按特征分类', description: '按共同属性分组',
    diagnosticBoundary: '能说明自己选用的特征', expectedPriorKnowledgeEvidence: '已学习观察物体特征', necessityRationale: '支持识别分类依据' }],
  pretest: { questions: [] },
} as unknown as AdaptiveLearningPlan;

describe('adaptive branch teaching context', () => {
  it('preserves the actual fragment duration and confirmed scope instead of hour-long course defaults', () => {
    const result = buildAdaptiveBranchTeachingContext(course, { ...branch, targetDurationSec: 75 }, plan);
    expect(result.teachingConstraints.courseHours).toBe(75 / 3600);
    expect(result.teachingConstraints.totalMinutes).toBe(1.25);
    expect(result.teachingConstraints.recommendedKnowledgePointRange).toEqual({ min: 1, max: 1 });
    expect(result.teachingConstraints.scopeRule).toContain('75 秒');
    expect(result.requirement).toContain('75 秒');
    const prompt = formatTeachingConstraintsForPrompt(result.teachingConstraints);
    expect(prompt).toContain('1.25 minutes');
    expect(prompt).not.toContain('60 minutes');
    expect(prompt).not.toContain('5-8');
  });

  it('rejects an invalid fragment duration instead of substituting one hour', () => {
    for (const targetDurationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildAdaptiveBranchTeachingContext(course, { ...branch, targetDurationSec }, plan)).toThrow('片段时长无效');
    }
  });
  it('preserves class readiness while narrowing objectives and knowledge to the branch', () => {
    const result = buildAdaptiveBranchTeachingContext(course, branch, plan);
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(['test']);
    expect(result.teachingConstraints.learningObjectives).toEqual([branch.objective]);
    expect(result.teachingConstraints.learnerFoundation).toBe('会按可见特征分类');
    expect(result.requirement).toContain('需要展开因果关系');
    expect(result.requirement).toContain('校园植物');
    expect(result.requirement).toContain('从对照图开始解释');
    expect(result.requirement).toContain('解释独立检验');
    expect(result.teachingSourceContext).toContain('使用未参与训练的数据检验');
    expect(result.teachingSourceContext).not.toContain('本分支无需讲授');
    expect(result.teachingSourceContext).not.toContain('需要展开因果关系');
  });

  it('limits remediation to prerequisite concepts instead of the new main-course target', () => {
    const result = buildAdaptiveBranchTeachingContext(course, { ...branch, kind: 'prerequisite' }, plan);
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(['classify']);
    expect(result.teachingConstraints.allowedKnowledgePoints.map((point) => point.id)).toEqual(['classify']);
    expect(result.teachingSourceContext).toContain('能说明自己选用的特征');
    expect(result.teachingSourceContext).not.toContain('使用未参与训练的数据检验');
    expect(result.requirement).toContain('不得声称知道某个学生的具体答案');
  });

  it('rejects stale references instead of silently authoring an unbounded branch', () => {
    expect(() => buildAdaptiveBranchTeachingContext(course, { ...branch, anchorKnowledgePointIds: ['missing'] }, plan)).toThrow('知识边界已失效');
  });
});

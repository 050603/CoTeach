import { describe, expect, it } from 'vitest';
import { deriveTeachingConstraints, formatTeachingConstraintsForPrompt, inferGradeBand } from './teaching-constraints';

describe('teaching constraints', () => {
  it('infers a conservative high-school learner foundation', () => {
    expect(inferGradeBand('高一')).toBe('high-school');
    const result = deriveTeachingConstraints({ grade: '高一', subject: '信息技术', topic: '自然语言处理' });
    expect(result.learnerFoundation).toContain('no university-level specialist knowledge');
    expect(result.terminologyRule).toContain('Define, scaffold, or replace');
  });

  it('does not mistake a university first-year cohort for primary school', () => {
    expect(inferGradeBand('人工智能教育 本科一年级，26人')).toBe('higher-education');
  });

  it('uses explicit teacher-provided prior knowledge over inferred defaults', () => {
    const result = deriveTeachingConstraints({
      grade: '高一',
      learnerProfile: { priorKnowledge: '学生已经理解分类和概率的直观含义' },
    });
    expect(result.learnerFoundation).toBe('学生已经理解分类和概率的直观含义');
  });

  it('formats confirmed knowledge points as an authoritative boundary', () => {
    const text = formatTeachingConstraintsForPrompt(deriveTeachingConstraints({
      grade: '八年级',
      knowledgePoints: [{ id: 'kp-1', name: '文本分类', level: 'core' }],
    }));
    expect(text).toContain('kp-1: 文本分类 (core)');
    expect(text).toContain('must never become a hidden prerequisite');
  });

  it('scales the content boundary to the available course hours', () => {
    const oneHour = deriveTeachingConstraints({ grade: '高二', hours: 1 });
    const fiveHours = deriveTeachingConstraints({ grade: '高二', hours: 5 });

    expect(oneHour.totalMinutes).toBe(60);
    expect(oneHour.recommendedKnowledgePointRange).toEqual({ min: 5, max: 8 });
    expect(oneHour.scopeRule).toContain('compact');
    expect(deriveTeachingConstraints({ grade: '高二', hours: 0.5 }).recommendedKnowledgePointRange)
      .toEqual({ min: 2, max: 5 });
    expect(fiveHours.totalMinutes).toBe(300);
    expect(fiveHours.recommendedKnowledgePointRange).toEqual({ min: 15, max: 22 });
    expect(fiveHours.scopeRule).toContain('iteration');
  });

  it('includes grade, objectives, learner needs and time capacity in the authoritative prompt block', () => {
    const text = formatTeachingConstraintsForPrompt(deriveTeachingConstraints({
      grade: '八年级',
      subject: '信息科技',
      topic: '自然语言处理',
      hours: 2,
      learnerProfile: {
        priorKnowledge: '理解分类的直观含义',
        learningNeeds: '抽象算法需要图示支架',
        familiarContexts: '校园社团与短视频评论',
      },
      learningObjectives: ['使用证据比较两种文本分类方法'],
    }));

    expect(text).toContain('Grade/stage: 八年级 (middle-school)');
    expect(text).toContain('Course capacity: 2 hours / 120 minutes');
    expect(text).toContain('理解分类的直观含义');
    expect(text).toContain('抽象算法需要图示支架');
    expect(text).toContain('使用证据比较两种文本分类方法');
    expect(text).toContain('First choose the example, activity, and visual relationship');
    expect(text).toContain('taskAssociation is an optional later use');
  });
});

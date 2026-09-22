import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { buildAssessmentContext, type CompletedTeachingEvidence } from './assessment-dependencies';

function page(id: string, patch: Partial<SceneOutline> = {}): SceneOutline {
  return { id, type: 'slide', title: id, description: 'planned but not taught', keyPoints: [], order: 0, ...patch };
}
function taught(outline: SceneOutline, text = '实际讲授的解释'): CompletedTeachingEvidence {
  return { outline, speech: [{ text }] };
}
const quiz = page('quiz', { type: 'quiz', order: 10, lectureSectionId: 'section-a', teachingBrief: {
  schemaVersion: 1,
  sharedContext: { learningPurpose: '判断一条说法能否采用', caseId: 'verification', caseFacts: [], fixedWording: [], stableTerms: ['核验'], conceptBoundaries: ['删除一句依据只能说明教案没有明说，不能证明设计没有依据'] },
  explanation: '依据需要结合表述功能判断', examples: [], conditions: ['替换检验只能作为辅助线索'], evidence: [{ sourceId: 'course-source', quote: '教学理论提供底层逻辑支持。' }], assessmentFocus: '说明判断理由',
} });

describe('assessment teaching dependencies', () => {
  it('uses only completed earlier student narration from this section, in teaching order', () => {
    const context = JSON.parse(buildAssessmentContext(quiz, [
      taught(page('second', { lectureSectionId: 'section-a', order: 2 }), '第二个例子'),
      taught(page('first', { lectureSectionId: 'section-a', order: 1 }), '先讲清概念'),
      taught(page('teacher', { lectureSectionId: 'section-a', audience: 'teacher' })),
      taught(page('resource', { lectureSectionId: 'section-a', generationPurpose: 'teacher-resource' })),
      taught(page('unrelated', { lectureSectionId: 'section-b' })),
      taught(page('future', { lectureSectionId: 'section-a', order: 11 })),
      taught(page('other-quiz', { lectureSectionId: 'section-a', type: 'quiz' })),
    ]));
    expect(context.pages.map((item: { pageId: string }) => item.pageId)).toEqual(['first', 'second']);
    expect(context.pages[0].narration).toEqual(['先讲清概念']);
    expect(context.answerAuthority.conceptBoundaries[0]).toContain('不能证明设计没有依据');
    expect(context.answerAuthority.evidence[0].quote).toContain('底层逻辑支持');
    expect(context.instruction).toContain('不得因讲稿解释不足而降低标准');
    expect(JSON.stringify(context)).not.toContain('planned but not taught');
  });

  it('supports activity and course scope when no section identifier exists', () => {
    const activityQuiz = page('check', { type: 'quiz', order: 2, parentActivityId: 'activity' });
    expect(buildAssessmentContext(activityQuiz, [taught(page('teaching', { activityId: 'activity' }))]))
      .toContain('实际讲授的解释');
    expect(buildAssessmentContext(page('check', { type: 'quiz', order: 2 }), [taught(page('teaching'))]))
      .toContain('实际讲授的解释');
  });

  it('allows a cross-section final only with complete confirmed teaching-unit dependencies', () => {
    const finalQuiz = { ...quiz, lectureSectionId: 'final', assessmentUnitIds: ['unit-a', 'unit-b'] };
    const first = taught(page('a', { lectureSectionId: 'a', teachingUnitIds: ['unit-a'] }));
    const second = taught(page('b', { lectureSectionId: 'b', teachingUnitIds: ['unit-b'] }));
    expect(JSON.parse(buildAssessmentContext(finalQuiz, [first, second])).pages).toHaveLength(2);
    expect(() => buildAssessmentContext(finalQuiz, [first])).toThrow('不能降低题目标准');
    expect(() => buildAssessmentContext({ ...finalQuiz, assessmentUnitIds: [] }, [first, second])).toThrow('缺少');
  });

  it('merges current-section teaching with explicitly referenced prior teaching', () => {
    const mixedQuiz = {
      ...quiz,
      assessmentUnitIds: ['unit-local', 'unit-prior'],
    };
    const prior = taught(page('prior', {
      lectureSectionId: 'section-before', order: 1, teachingUnitIds: ['unit-prior'],
    }), '前一节已经讲清的依据');
    const local = taught(page('local', {
      lectureSectionId: 'section-a', order: 2, teachingUnitIds: ['unit-local'],
    }), '本节补充的判断方法');
    const unrelated = taught(page('unrelated-prior', {
      lectureSectionId: 'section-before', order: 0, teachingUnitIds: ['unit-other'],
    }), '没有被测验引用的内容');

    const context = JSON.parse(buildAssessmentContext(mixedQuiz, [local, unrelated, prior]));

    expect(context.pages.map((item: { pageId: string }) => item.pageId)).toEqual(['prior', 'local']);
    expect(JSON.stringify(context)).not.toContain('没有被测验引用的内容');
  });

  it('fails explicitly for quiz-only or unspoken teaching instead of inventing taught context', () => {
    for (const evidence of [[], [taught(page('empty', { lectureSectionId: 'section-a' }), '  ')]]) {
      try {
        buildAssessmentContext(quiz, evidence);
        expect.fail('missing dependencies must fail');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ASSESSMENT_TEACHING_DEPENDENCY_MISSING', isRetryable: false });
      }
    }
    expect(buildAssessmentContext(page('ordinary'), [])).toBe('');
  });

  it('keeps the predeclared understanding standard when actual narration misses a supporting unit', () => {
    const assessed = { ...quiz, teachingBrief: { ...quiz.teachingBrief!, understandingCriteria: {
      goals: ['说明两个概念如何共同作用'], answerEssentials: ['关系与理由'],
      misconceptions: ['只背名称'], supportingUnitIds: ['unit-a', 'unit-b'],
    } } };
    expect(() => buildAssessmentContext(assessed, [
      taught(page('a', { lectureSectionId: 'section-a', teachingUnitIds: ['unit-a'] })),
    ])).toThrow('不能降低题目标准');
  });
});

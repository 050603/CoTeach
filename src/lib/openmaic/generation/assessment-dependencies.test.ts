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
    expect(context.instruction).toContain('不得把讲稿里的简化线索');
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
    expect(() => buildAssessmentContext(finalQuiz, [first])).toThrow('缺少');
    expect(() => buildAssessmentContext({ ...finalQuiz, assessmentUnitIds: [] }, [first, second])).toThrow('缺少');
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
});

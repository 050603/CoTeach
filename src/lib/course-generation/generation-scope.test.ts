import { describe, expect, it } from 'vitest';
import {
  resolveFullCoursePromotionOutlines,
  selectClassroomGenerationOutlines,
} from './generation-scope';

const fullOutline = [
  { id: 's1-p1', type: 'slide', title: '第一节讲解', description: '区分教学模式与教学策略', keyPoints: ['教学概念层级'], lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 120 },
  { id: 's1-check', type: 'quiz', title: '第一节检测', description: '检查教学概念层级', keyPoints: [], lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 60 },
  { id: 's2-p1', type: 'slide', title: '项目式学习的持续探究', description: '用真实问题、协作实践和反思评价推进项目', keyPoints: ['项目式学习', '持续探究'], lectureSectionId: 's2', lectureSectionTitle: '项目式学习', targetDurationSec: 120 },
  { id: 's2-check', type: 'quiz', title: '项目式学习检测', description: '判断普通任务与项目式学习的区别', keyPoints: [], lectureSectionId: 's2', lectureSectionTitle: '项目式学习', targetDurationSec: 60 },
] as const;

describe('test lesson promotion scope', () => {
  it('recovers the canonical full outline after the course preview has been narrowed to one test section', () => {
    const selected = selectClassroomGenerationOutlines(fullOutline, 'test-lesson');
    expect(selected.outlines.map((outline) => outline.id)).toEqual(['s1-p1', 's1-check']);

    const restored = resolveFullCoursePromotionOutlines({
      persistedOutlines: fullOutline,
      expectedFullSceneCount: fullOutline.length,
      testLesson: selected.testLesson,
    });

    expect(restored?.map((outline) => outline.id)).toEqual(fullOutline.map((outline) => outline.id));
  });

  it('rejects a truncated, duplicate, or mismatched persisted outline', () => {
    const testLesson = selectClassroomGenerationOutlines(fullOutline, 'test-lesson').testLesson;
    expect(resolveFullCoursePromotionOutlines({
      persistedOutlines: fullOutline.slice(0, 2), expectedFullSceneCount: 4, testLesson,
    })).toBeNull();
    expect(resolveFullCoursePromotionOutlines({
      persistedOutlines: [fullOutline[0], fullOutline[0], fullOutline[2], fullOutline[3]], expectedFullSceneCount: 4, testLesson,
    })).toBeNull();
    expect(resolveFullCoursePromotionOutlines({
      persistedOutlines: fullOutline, expectedFullSceneCount: 4,
      testLesson: testLesson ? { ...testLesson, sceneOutlineIds: ['missing-page'] } : undefined,
    })).toBeNull();
  });

  it('uses the teacher focus to select the most relevant complete test section', () => {
    const selected = selectClassroomGenerationOutlines(
      fullOutline,
      'test-lesson',
      '请在教学中重点讲解项目式学习，并让学生看清它与普通课堂任务的区别。',
    );

    expect(selected.testLesson).toMatchObject({
      sectionId: 's2',
      sectionTitle: '项目式学习',
      sceneOutlineIds: ['s2-p1', 's2-check'],
    });
    expect(selected.outlines.map((outline) => outline.id)).toEqual(['s2-p1', 's2-check']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  resolveFullCoursePromotionOutlines,
  selectClassroomGenerationOutlines,
} from './generation-scope';

const fullOutline = [
  { id: 's1-p1', type: 'slide', title: '第一节讲解', lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 120 },
  { id: 's1-check', type: 'quiz', title: '第一节检测', lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 60 },
  { id: 's2-p1', type: 'slide', title: '第二节讲解', lectureSectionId: 's2', lectureSectionTitle: '第二节', targetDurationSec: 120 },
  { id: 's2-check', type: 'quiz', title: '第二节检测', lectureSectionId: 's2', lectureSectionTitle: '第二节', targetDurationSec: 60 },
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
});

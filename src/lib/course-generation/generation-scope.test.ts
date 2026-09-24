import { describe, expect, it } from 'vitest';
import {
  resolveFullCoursePromotionOutlines,
  selectClassroomGenerationOutlines,
} from './generation-scope';

type TestOutline = { id: string; type: 'slide' | 'quiz'; title: string; description: string; keyPoints: readonly string[]; lectureSectionId: string; lectureSectionTitle: string; targetDurationSec: number; spatialParentId?: string };

const fullOutline: readonly TestOutline[] = [
  { id: 's1-p1', type: 'slide', title: '第一节讲解', description: '区分教学模式与教学策略', keyPoints: ['教学概念层级'], lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 120 },
  { id: 's1-check', type: 'quiz', title: '第一节检测', description: '检查教学概念层级', keyPoints: [], lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 60 },
  { id: 's2-p1', type: 'slide', title: '项目式学习的持续探究', description: '用真实问题、协作实践和反思评价推进项目', keyPoints: ['项目式学习', '持续探究'], lectureSectionId: 's2', lectureSectionTitle: '项目式学习', targetDurationSec: 120 },
  { id: 's2-check', type: 'quiz', title: '项目式学习检测', description: '判断普通任务与项目式学习的区别', keyPoints: [], lectureSectionId: 's2', lectureSectionTitle: '项目式学习', targetDurationSec: 60 },
];

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

  it('honors the teacher-selected section over relevance and rejects an invalid section', () => {
    const selected = selectClassroomGenerationOutlines(
      fullOutline, 'test-lesson', '请重点讲解项目式学习', 's1',
    );
    expect(selected.testLesson).toMatchObject({
      sectionId: 's1', sceneOutlineIds: ['s1-p1', 's1-check'], durationSeconds: 180,
    });
    expect(selected.outlines.map((outline) => outline.id)).toEqual(['s1-p1', 's1-check']);
    expect(() => selectClassroomGenerationOutlines(fullOutline, 'test-lesson', '', 'missing'))
      .toThrow('所选测试小节不在当前大纲中');
  });
});

describe('promotion of compiled continuation pages', () => {
  const expanded = [
    { ...fullOutline[0], spatialParentId: fullOutline[0].id, targetDurationSec: 70 },
    { ...fullOutline[0], id: `${fullOutline[0].id}--continuation-2`, spatialParentId: fullOutline[0].id, targetDurationSec: 50 },
    fullOutline[1],
  ];
  const testLesson = selectClassroomGenerationOutlines(fullOutline, 'test-lesson').testLesson;
  it('keeps accepted expanded pages while restoring all other confirmed sections', () => {
    const promoted = resolveFullCoursePromotionOutlines({ persistedOutlines: fullOutline, acceptedTestOutlines: expanded,
      expectedFullSceneCount: 4, testLesson });
    expect(promoted).toEqual([...expanded, ...fullOutline.slice(2)]);
    expect(selectClassroomGenerationOutlines(promoted!, 'full-course').fullSceneCount).toBe(4);
    expect(selectClassroomGenerationOutlines(promoted!, 'test-lesson').testLesson).toMatchObject({
      sceneOutlineIds: ['s1-p1', 's1-check'], durationSeconds: 180,
    });
    expect(resolveFullCoursePromotionOutlines({ persistedOutlines: promoted!, acceptedTestOutlines: expanded,
      expectedFullSceneCount: 4, testLesson })).toEqual(promoted);
  });
  it('rejects dropped continuation content, changed adopted duration and foreign accepted pages', () => {
    for (const acceptedTestOutlines of [expanded.slice(1), [{ ...expanded[0]!, targetDurationSec: 60 }, ...expanded.slice(1)], [...expanded, fullOutline[2]]]) {
      expect(resolveFullCoursePromotionOutlines({ persistedOutlines: fullOutline, acceptedTestOutlines,
        expectedFullSceneCount: 4, testLesson })).toBeNull();
    }
  });
});

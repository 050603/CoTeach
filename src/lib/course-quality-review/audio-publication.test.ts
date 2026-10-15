import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { createPblTemplateCourse, encodePblTemplate } from '@/lib/platform/pbl-template';
import { computeCourseQualitySignature } from './signature';
import { audioPublicationSnapshotFingerprint, hasAuthenticCourseAudioPublication, hashJson, signCourseAudioPublication } from './audio-publication';

const secret = 'concept-map-publication-test-secret-at-least-thirty-two';
let course: Course;
let classroom: PersistedClassroomData;
beforeEach(() => {
  vi.stubEnv('JWT_SECRET', secret);
  classroom = { id: 'classroom', revision: 2, createdAt: '2026-10-14T00:00:00.000Z',
    stage: { id: 'classroom', name: '课程', createdAt: 1, updatedAt: 1 },
    scenes: [{ id: 'page', stageId: 'classroom', title: '情境性', type: 'slide', order: 0,
      content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 16 / 9,
        theme: { backgroundColor: '#ffffff', themeColors: [], fontColor: '#000000', fontName: 'Arial' }, elements: [] } },
      actions: [{ id: 'speech', type: 'speech', text: '情境性来自真实问题。', audioUrl: '/api/openmaic/classroom-media/classroom/audio/speech.wav' }] }],
  };
  course = createPblTemplateCourse('course', { name: '教学理论', aiLearningClassroomId: classroom.id,
    content: { ...createPblTemplateCourse('empty').content,
      knowledgePoints: [{ id: 'kp', name: '抛锚式教学法', description: '使用真实问题组织情境。' }],
      teachingRevisionState: { schemaVersion: 1, baseClassroomRevision: 1, classroomRevision: 2, changeType: 'narration',
        affectedSceneIds: ['page'], invalidated: [], updatedAt: '2026-10-14T00:00:00.000Z' },
    } });
  const review = { schemaVersion: 1 as const, courseId: 'course', classroomId: 'original-classroom',
    signature: 'original-review-signature', teacherId: 'teacher', confirmedAt: '2026-10-13T00:00:00.000Z',
    acceptedIssueIds: [], manualContentReview: true };
  course.content.teacherReview = { ...review, seal: createHmac('sha256', secret).update(JSON.stringify([
    'course-teacher-review-v1', review.courseId, review.classroomId, review.signature, review.teacherId,
    review.confirmedAt, [], true,
  ])).digest('hex') };
  course.content.teachingRevisionState!.audioPublication = signCourseAudioPublication({
    schemaVersion: 1, kind: 'course-audio-publication', courseId: 'course', teacherId: 'teacher',
    sourceVersionId: 'v3', sourceClassroomId: 'original-classroom', sourceSnapshotFingerprint: 'original-snapshot',
    sourceClassroomFingerprint: 'original-classroom-hash', teacherReviewSeal: course.content.teacherReview.seal,
    classroomId: classroom.id, classroomFingerprint: hashJson(classroom),
    snapshotFingerprint: audioPublicationSnapshotFingerprint(course), signature: computeCourseQualitySignature(course, classroom),
    publishedAt: '2026-10-14T00:00:00.000Z',
  });
});
afterEach(() => vi.unstubAllEnvs());

function addMap(): void {
  course.content.courseMindMap = { schemaVersion: 1, sourceFingerprint: 'derived-source', bindingFingerprint: 'derived-binding',
    rootId: 'root', nodes: [{ id: 'root', label: '教学理论', knowledgePointIds: [] },
      { id: 'method', label: '抛锚式教学法', parentId: 'root', knowledgePointIds: ['kp'] }],
    relations: [], bindings: [{ sceneId: 'page', defaultNodeId: 'method', cues: [] }], diagnostics: [] };
}

describe('audio publication compatibility with independently validated concept maps', () => {
  it('preserves the legacy snapshot hash and signed receipt when adding a derived map', () => {
    const legacy = structuredClone(encodePblTemplate(course));
    delete legacy.design.content.qualityReview; delete legacy.design.content.renderReview;
    delete legacy.design.content.teachingRevisionState!.audioPublication;
    const previousHash = hashJson(legacy);
    const previousSeal = course.content.teachingRevisionState!.audioPublication!.seal;
    expect(audioPublicationSnapshotFingerprint(course)).toBe(previousHash);
    expect(hasAuthenticCourseAudioPublication(course, classroom, 'teacher')).toBe(true);
    addMap();
    expect(audioPublicationSnapshotFingerprint(course)).toBe(previousHash);
    expect(hasAuthenticCourseAudioPublication(course, classroom, 'teacher')).toBe(true);
    expect(course.content.teachingRevisionState!.audioPublication!.seal).toBe(previousSeal);
  });

  it.each(['name', 'knowledge', 'lecture', 'receipt', 'review'] as const)('keeps rejecting changes to original %s data', (field) => {
    addMap();
    if (field === 'name') course.name = '另一门课程';
    if (field === 'knowledge') course.content.knowledgePoints[0]!.description = '未经授权的新概念';
    if (field === 'lecture') {
      const speech = classroom.scenes[0]!.actions![0]!;
      if (speech.type === 'speech') speech.text = '未经授权的新讲稿。';
    }
    if (field === 'receipt') course.content.teachingRevisionState!.audioPublication!.sourceVersionId = 'forged-source';
    if (field === 'review') course.content.teacherReview!.seal = 'a'.repeat(64);
    expect(hasAuthenticCourseAudioPublication(course, classroom, 'teacher')).toBe(false);
  });

  it('does not transfer an original receipt to another course, classroom or owner', () => {
    addMap();
    expect(hasAuthenticCourseAudioPublication(course, classroom, 'other-teacher')).toBe(false);
    expect(hasAuthenticCourseAudioPublication({ ...course, id: 'copied-course' }, classroom, 'teacher')).toBe(false);
    expect(hasAuthenticCourseAudioPublication(course, { ...classroom, id: 'other-classroom' }, 'teacher')).toBe(false);
  });
});

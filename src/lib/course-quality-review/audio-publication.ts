import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Course } from '@/lib/session/types';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { encodePblTemplate } from '@/lib/platform/pbl-template';
import { computeCourseQualitySignature } from './signature';

/** A scoped operational publication receipt, never a teacher's review of the new audio. */
export type CourseAudioPublication = {
  schemaVersion: 1;
  kind: 'course-audio-publication';
  courseId: string;
  teacherId: string;
  sourceVersionId: string;
  sourceClassroomId: string;
  sourceSnapshotFingerprint: string;
  sourceClassroomFingerprint: string;
  teacherReviewSeal: string;
  classroomId: string;
  classroomFingerprint: string;
  snapshotFingerprint: string;
  signature: string;
  publishedAt: string;
  seal: string;
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
  }) ?? 'null';
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Diagnostics and independently validated maps may refresh; teaching content and the original confirmation remain bound. */
export function audioPublicationSnapshotFingerprint(course: Course): string {
  const snapshot = encodePblTemplate(course);
  delete snapshot.design.content.qualityReview;
  delete snapshot.design.content.renderReview;
  delete snapshot.design.content.courseMindMap;
  const state = snapshot.design.content.teachingRevisionState;
  if (!state) return hashJson(snapshot);
  const { audioPublication: _receipt, ...revision } = state;
  void _receipt;
  return hashJson({ ...snapshot, design: { ...snapshot.design, content: {
    ...snapshot.design.content, teachingRevisionState: revision,
  } } });
}

function publicationSeal(publication: Omit<CourseAudioPublication, 'seal'>): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('音频发布凭证无法签名，请检查服务认证配置。');
  return createHmac('sha256', secret)
    .update(canonicalJson(['course-audio-publication-v1', publication])).digest('hex');
}

/** Only the internal publication boundary calls this after source/content/media checks. */
export function signCourseAudioPublication(publication: Omit<CourseAudioPublication, 'seal'>): CourseAudioPublication {
  return { ...publication, seal: publicationSeal(publication) };
}

export function hasAuthenticCourseAudioPublication(
  course: Course,
  classroom: PersistedClassroomData,
  teacherId?: string,
): boolean {
  const publication = course.content.teachingRevisionState?.audioPublication;
  const review = course.content.teacherReview;
  if (!publication || !review || publication.schemaVersion !== 1 || publication.kind !== 'course-audio-publication'
    || publication.courseId !== course.id || publication.teacherId !== review.teacherId
    || (teacherId && publication.teacherId !== teacherId)
    || publication.teacherReviewSeal !== review.seal || publication.classroomId !== classroom.id
    || !publication.sourceVersionId || !publication.sourceClassroomId
    || !Number.isFinite(Date.parse(publication.publishedAt))
    || typeof publication.seal !== 'string' || !/^[a-f0-9]{64}$/.test(publication.seal)) return false;
  try {
    const { seal, ...unsigned } = publication;
    if (!timingSafeEqual(Buffer.from(seal, 'hex'), Buffer.from(publicationSeal(unsigned), 'hex'))) return false;
    return publication.classroomFingerprint === hashJson(classroom)
      && publication.snapshotFingerprint === audioPublicationSnapshotFingerprint(course)
      && publication.signature === computeCourseQualitySignature({ ...course, id: review.courseId }, classroom);
  } catch {
    return false;
  }
}

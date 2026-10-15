import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Action, SpeechAction } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { prisma } from '@/lib/db/client';
import { runMutationTransaction } from '@/lib/db/transaction-retry';
import { audioDurationSec } from '@/lib/openmaic/audio/audio-duration';
import { isValidSlideVisualTarget } from '@/lib/openmaic/generation/semantic-visual-cues';
import { resolveAlignedSpeechCueAnchor, resolveAlignedSpeechCueRange } from '@/lib/openmaic/generation/speech-cue-boundaries';
import { classroomAudioStoragePath } from '@/lib/openmaic/server/classroom-asset-recovery';
import { summarizeTeachingTimingAudit } from '@/lib/openmaic/server/classroom-asset-generation';
import { CLASSROOMS_DIR, isValidClassroomId, normalizePersistedClassroom, readClassroom, type PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { audioPublicationSnapshotFingerprint, hasAuthenticCourseAudioPublication, hashJson, signCourseAudioPublication } from '@/lib/course-quality-review/audio-publication';
import { isAuthenticTeacherReview, requiresCourseTeacherReview } from '@/lib/course-quality-review/review-service';
import { computeCourseQualitySignature } from '@/lib/course-quality-review/signature';
import { resolveCourseMindMapBindings } from '@/lib/course-mind-map/bindings';
import { validateCourseMindMap } from '@/lib/course-mind-map/generation';
import { createPblTemplateCourse, decodePblTemplate, type PblTemplateSnapshot } from './pbl-template';
import { PlatformError } from './repository';

export { hashJson } from '@/lib/course-quality-review/audio-publication';

export type PublishCourseAudioInput = {
  courseId: string;
  /** An explicitly requested display-name change accompanying the audio update. */
  courseName?: string;
  sourceVersionId: string;
  sourceSnapshotFingerprint: string;
  expectedCourseUpdatedAt: string;
  sourceClassroom: PersistedClassroomData;
  candidate: PersistedClassroomData;
  snapshot: PblTemplateSnapshot;
  mediaRefs?: Prisma.InputJsonValue;
};

function assertSame(value: unknown, expected: unknown, message: string): void {
  if (hashJson(value) !== hashJson(expected)) throw new PlatformError('AUDIO_CONTENT_CHANGED', message, 409);
}

function stripFields(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function fixedAction(action: Action): boolean {
  return action.type !== 'spotlight' && action.type !== 'laser'
    && (action.type !== 'speech' || !action.text.trim());
}

/** Cloned image URLs may change owner, but their resource identity must remain the same. */
function normalizeMediaOwner(value: unknown, sourceId: string, candidateId: string): unknown {
  if (typeof value === 'string') return value.replace(
    `/api/openmaic/classroom-media/${candidateId}/`, `/api/openmaic/classroom-media/${sourceId}/`,
  );
  if (Array.isArray(value)) return value.map((item) => normalizeMediaOwner(item, sourceId, candidateId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalizeMediaOwner(item, sourceId, candidateId)]));
  return value;
}

function sceneContentProjection(scene: Scene, sourceId: string, candidateId: string): unknown {
  return normalizeMediaOwner({
    ...stripFields(scene, ['actions', 'stageId', 'updatedAt', 'narrationRevision', 'visualActionRevision']),
    actions: (scene.actions ?? []).filter(fixedAction),
  }, sourceId, candidateId);
}

function sourceSpeechFor(action: SpeechAction, speeches: SpeechAction[]): SpeechAction | undefined {
  return speeches.find((source) => source.id === action.id)
    ?? speeches.find((source) => action.id.startsWith(`${source.id}_tts_`)
      && /^[1-9]\d*$/.test(action.id.slice(source.id.length + 5)));
}

function assertClassroomAudioOnly(source: PersistedClassroomData, candidate: PersistedClassroomData, courseName?: string): void {
  if (!isValidClassroomId(source.id) || !isValidClassroomId(candidate.id) || source.id === candidate.id
    || candidate.stage.id !== candidate.id || candidate.assetGeneration?.status !== 'completed') {
    throw new PlatformError('INVALID_AUDIO_CANDIDATE', '音频候选课堂必须独立保存且资源已生成完成。', 409);
  }
  const expectedStage = { ...source.stage, ...(courseName !== undefined ? { name: courseName } : {}) };
  assertSame(stripFields(candidate.stage, ['id', 'updatedAt']), stripFields(expectedStage, ['id', 'updatedAt']), '音频更新不能改变课堂设定。');
  if (!source.scenes.length || source.scenes.length !== candidate.scenes.length) {
    throw new PlatformError('AUDIO_CONTENT_CHANGED', '音频更新不能增删页面。', 409);
  }
  source.scenes.forEach((scene, index) => {
    const next = candidate.scenes[index]!;
    if (next.stageId !== candidate.id) throw new PlatformError('INVALID_AUDIO_CANDIDATE', '候选页面没有绑定新课堂。', 409);
    assertSame(sceneContentProjection(next, source.id, candidate.id), sceneContentProjection(scene, source.id, source.id), '音频更新不能改变 PPT、题目、页面顺序或其他课堂动作。');
    const speeches = (scene.actions ?? []).filter((action): action is SpeechAction => action.type === 'speech' && Boolean(action.text.trim()));
    const originalIds: string[] = [];
    for (const action of next.actions ?? []) {
      if (action.type !== 'speech' || !action.text.trim()) continue;
      const original = sourceSpeechFor(action, speeches);
      if (!original) throw new PlatformError('AUDIO_CONTENT_CHANGED', '新讲稿必须保留原段落身份；长音频可按 TTS 规则分段。', 409);
      assertSame({ phase: action.quizNarrationPhase, voice: action.voice, speed: action.speed },
        { phase: original.quizNarrationPhase, voice: original.voice, speed: original.speed }, '音频更新不能改变测验等待语义、音色或语速。');
      if (originalIds.at(-1) !== original.id) originalIds.push(original.id);
    }
    assertSame(originalIds, speeches.map((action) => action.id), '音频更新不能删除、合并或重排讲稿段落。');
    const ids = (next.actions ?? []).map((action) => action.id);
    if (new Set(ids).size !== ids.length) throw new PlatformError('INVALID_AUDIO_CANDIDATE', '候选页面动作身份重复。', 409);
  });
}

function fixedSnapshotProjection(snapshot: PblTemplateSnapshot, sourceId: string, candidateId: string): unknown {
  const copy = JSON.parse(JSON.stringify(snapshot)) as PblTemplateSnapshot;
  const content = copy.design.content;
  delete content.teachingTimingAudit;
  delete content.teachingRevisionState;
  delete content.courseMindMap;
  for (const section of content.teachingBlueprint?.sections ?? []) {
    for (const unit of section.units) {
      for (const node of unit.explanationNodes ?? []) {
        if (!node.content?.trim()) throw new PlatformError('INVALID_AUDIO_CANDIDATE', '权威讲稿节点不能为空。', 409);
        node.content = '';
      }
    }
  }
  if (copy.design.aiLearningClassroomId === candidateId) copy.design.aiLearningClassroomId = sourceId;
  if (content._openmaicClassroomId === candidateId) content._openmaicClassroomId = sourceId;
  return copy;
}

function assertCurrentManuscript(snapshot: PblTemplateSnapshot, candidate: PersistedClassroomData): void {
  const speeches = candidate.scenes.flatMap((scene) => scene.actions ?? [])
    .filter((action): action is SpeechAction => action.type === 'speech' && Boolean(action.text.trim()));
  for (const section of snapshot.design.content.teachingBlueprint?.sections ?? []) {
    for (const unit of section.units) for (const node of unit.explanationNodes ?? []) {
      const execution = speeches.filter((action) => action.id.replace(/(?:_tts_\d+)+$/u, '') === node.id);
      if (execution.length && execution.map((action) => action.text).join('') !== node.content) {
        throw new PlatformError('MANUSCRIPT_CONFLICT', '权威讲稿节点与候选音频的执行讲稿不一致。', 409);
      }
    }
  }
  const actualAudit = summarizeTeachingTimingAudit({
    outlines: (snapshot.design.content._openmaicSceneOutlines ?? []) as SceneOutline[], studentScenes: candidate.scenes, enableTTS: true,
  });
  if (!snapshot.design.content.teachingTimingAudit) {
    throw new PlatformError('AUDIO_NOT_READY', '新版本缺少真实音频时长汇总。', 409);
  }
  assertSame(stripFields(snapshot.design.content.teachingTimingAudit, ['generatedAt']), stripFields(actualAudit, ['generatedAt']), '音频时长汇总必须来自当前候选的实际音频。');
}

async function assertCompleteAudio(candidate: PersistedClassroomData): Promise<void> {
  for (const scene of candidate.scenes) {
    const actions = scene.actions ?? [];
    const speechById = new Map(actions.flatMap((action) => action.type === 'speech' ? [[action.id, action] as const] : []));
    for (const action of actions) {
      if (action.type !== 'speech' || !action.text.trim()) continue;
      const audioPath = action.audioUrl && classroomAudioStoragePath(CLASSROOMS_DIR, action.audioUrl);
      if (!audioPath || !action.audioUrl?.startsWith(`/api/openmaic/classroom-media/${candidate.id}/audio/`)
        || action.audioInvalidated || !Number.isFinite(action.audioDurationSec) || (action.audioDurationSec ?? 0) <= 0) {
        throw new PlatformError('AUDIO_NOT_READY', '新讲稿必须绑定候选课堂的新音频和实际时长。', 409);
      }
      const bytes = await readFile(audioPath).catch(() => null);
      const duration = bytes && audioDurationSec(bytes, path.extname(audioPath).slice(1));
      const alignment = action.speechAlignment;
      if (!bytes?.length || !duration || Math.abs(duration - action.audioDurationSec!) > 0.02
        || alignment?.status !== 'aligned' || !alignment.version || !alignment.spans.length
        || alignment.textHash !== createHash('sha256').update(action.text).digest('hex')
        || alignment.audioHash !== createHash('sha256').update(bytes).digest('hex')) {
        throw new PlatformError('AUDIO_NOT_READY', '新音频文件、实际时长或讲稿对齐信息不完整。', 409);
      }
      let endChar = 0;
      let endMs = 0;
      for (const span of alignment.spans) {
        if (!Number.isInteger(span.startChar) || !Number.isInteger(span.endChar)
          || span.startChar < endChar || span.endChar <= span.startChar || span.endChar > action.text.length
          || span.text !== action.text.slice(span.startChar, span.endChar)
          || !Number.isInteger(span.startMs) || !Number.isInteger(span.endMs)
          || span.startMs < endMs || span.endMs < span.startMs || span.endMs > duration * 1000 + 1000) {
          throw new PlatformError('AUDIO_NOT_READY', '音频对齐跨度不能对应当前讲稿和音频。', 409);
        }
        endChar = span.endChar;
        endMs = span.endMs;
      }
      if (!resolveAlignedSpeechCueRange(action.text, alignment.spans, 0, action.text.length)) {
        throw new PlatformError('AUDIO_NOT_READY', '音频对齐信息没有覆盖当前讲稿的全部词句。', 409);
      }
    }
    for (const action of actions) {
      if (action.type !== 'spotlight' && action.type !== 'laser') continue;
      const speech = action.speechId ? speechById.get(action.speechId) : undefined;
      const start = speech && action.speechAnchor && speech.speechAlignment?.status === 'aligned'
        ? resolveAlignedSpeechCueAnchor(speech.text, speech.speechAlignment.spans, action.speechAnchor) : null;
      if (scene.content.type !== 'slide' || !isValidSlideVisualTarget(scene.content.canvas.elements, action)
        || !speech || !start || action.speechOffsetMs !== start.startMs) {
        throw new PlatformError('AUDIO_ANCHOR_INVALID', '页面动作必须绑定新讲稿的实际音频锚点和有效页面目标。', 409);
      }
      const endSpeech = action.type === 'spotlight' && action.endSpeechId ? speechById.get(action.endSpeechId) : speech;
      const end = endSpeech && action.endSpeechAnchor && endSpeech.speechAlignment?.status === 'aligned'
        ? resolveAlignedSpeechCueAnchor(endSpeech.text, endSpeech.speechAlignment.spans, action.endSpeechAnchor) : null;
      if (!endSpeech || actions.indexOf(endSpeech) < actions.indexOf(speech)
        || (endSpeech === speech && action.endSpeechOffsetMs !== undefined && action.endSpeechOffsetMs < start.startMs)
        || (action.endSpeechAnchor && (!end || action.endSpeechOffsetMs !== end.endMs))
        || (action.endSpeechOffsetMs !== undefined && (!Number.isFinite(action.endSpeechOffsetMs)
          || action.endSpeechOffsetMs < 0 || action.endSpeechOffsetMs > endSpeech.audioDurationSec! * 1000 + 1000))) {
        throw new PlatformError('AUDIO_ANCHOR_INVALID', '页面动作结束位置不能对应新音频。', 409);
      }
      if (action.type === 'laser') {
        for (const waypoint of action.waypoints ?? []) {
          const timing = waypoint.speechAnchor && resolveAlignedSpeechCueAnchor(speech.text, speech.speechAlignment!.spans, waypoint.speechAnchor);
          if (!timing || waypoint.speechOffsetMs !== timing.startMs
            || !isValidSlideVisualTarget(scene.content.canvas.elements, waypoint)) {
            throw new PlatformError('AUDIO_ANCHOR_INVALID', '激光路径必须完整绑定新音频和有效页面目标。', 409);
          }
        }
      }
    }
  }
}

/** Internal operations boundary for an explicitly authorized audio update; never exposed as an editor save. */
export async function publishCourseAudioVersion(
  input: PublishCourseAudioInput,
  db: PrismaClient = prisma,
): Promise<{ version: number; versionId: string; classroomId: string; courseVersion: number }> {
  const courseName = input.courseName?.trim();
  if (input.courseName !== undefined && !courseName) {
    throw new PlatformError('INVALID_COURSE_NAME', '课程名称不能为空。', 400);
  }
  const sourceClassroom = normalizePersistedClassroom(input.sourceClassroom);
  const candidate = normalizePersistedClassroom(input.candidate);
  assertClassroomAudioOnly(sourceClassroom, candidate, courseName);
  await assertCompleteAudio(candidate);
  const publish = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${input.courseId}`}, 0))`;
    await tx.$queryRaw`SELECT "id" FROM "ClassroomTemplate" WHERE "id" = ${input.courseId} FOR UPDATE`;
    const template = await tx.classroomTemplate.findUnique({ where: { id: input.courseId }, include: {
      versions: { orderBy: { version: 'desc' }, take: 1 },
    } });
    if (!template || template.status.toUpperCase() === 'DELETED') throw new PlatformError('NOT_FOUND', '课程不存在。', 404);
    if (template.status.toUpperCase() === 'ARCHIVED') throw new PlatformError('TEMPLATE_ARCHIVED', '归档课程不能更新音频。', 409);
    const source = template.versions[0];
    if (!source || source.id !== input.sourceVersionId || source.status.toUpperCase() !== 'PUBLISHED'
      || template.updatedAt.getTime() !== Date.parse(input.expectedCourseUpdatedAt)
      || hashJson(source.snapshot) !== input.sourceSnapshotFingerprint) {
      throw new PlatformError('VERSION_CONFLICT', '课程来源版本已改变，保留当前版本并重新读取来源。', 409);
    }
    const sourceDesign = decodePblTemplate(source.snapshot);
    if (!sourceDesign || (sourceDesign.aiLearningClassroomId || sourceDesign.content._openmaicClassroomId) !== sourceClassroom.id) {
      throw new PlatformError('VERSION_CONFLICT', '来源版本没有绑定已锁定的课堂。', 409);
    }
    const current = await readClassroom(sourceClassroom.id);
    if (!current || hashJson(current) !== hashJson(sourceClassroom)) {
      throw new PlatformError('CLASSROOM_CONFLICT', '来源课堂已更新，保留当前版本并重新生成候选。', 409);
    }
    const savedCandidate = await readClassroom(candidate.id);
    if (!savedCandidate || hashJson(savedCandidate) !== hashJson(candidate)) {
      throw new PlatformError('CANDIDATE_CONFLICT', '候选课堂未完整保存或已改变。', 409);
    }
    if (!decodePblTemplate(input.snapshot)
      || (input.snapshot.design.aiLearningClassroomId || input.snapshot.design.content._openmaicClassroomId) !== candidate.id) {
      throw new PlatformError('INVALID_AUDIO_CANDIDATE', '新版本没有绑定完整的候选课堂。', 409);
    }
    const expectedSnapshot = structuredClone(source.snapshot) as unknown as PblTemplateSnapshot;
    if (courseName !== undefined) expectedSnapshot.design.name = courseName;
    assertSame(fixedSnapshotProjection(input.snapshot, sourceClassroom.id, candidate.id),
      fixedSnapshotProjection(expectedSnapshot, sourceClassroom.id, sourceClassroom.id),
      '音频更新不能改变教学内容、来源、讲稿节点身份、大纲或原有审核证据。');
    const sourceMap = sourceDesign.content.courseMindMap;
    const inputMap = input.snapshot.design.content.courseMindMap;
    assertSame(inputMap ? stripFields(inputMap, ['bindings', 'bindingFingerprint']) : undefined,
      sourceMap ? stripFields(sourceMap, ['bindings', 'bindingFingerprint']) : undefined,
      '音频更新不能新增、删除或改写思维导图概念及关系。');
    assertCurrentManuscript(input.snapshot, candidate);
    const originalCourse = createPblTemplateCourse(input.courseId, sourceDesign);
    const review = originalCourse.content.teacherReview;
    if ((review || requiresCourseTeacherReview(originalCourse)) && (!review || !isAuthenticTeacherReview(review)
      || review.teacherId !== template.ownerId
      || (computeCourseQualitySignature({ ...originalCourse, id: review.courseId }, sourceClassroom) !== review.signature
        && !hasAuthenticCourseAudioPublication(originalCourse, sourceClassroom, template.ownerId)))) {
      throw new PlatformError('TEACHER_REVIEW_REQUIRED', '来源版本缺少与当前内容对应的真实教师审核证据。', 409);
    }
    const snapshot = JSON.parse(JSON.stringify(input.snapshot)) as PblTemplateSnapshot;
    const nextCourse = createPblTemplateCourse(input.courseId, snapshot.design);
    if (sourceMap) {
      const rebound = resolveCourseMindMapBindings(sourceMap, candidate.scenes);
      snapshot.design.content.courseMindMap = { ...rebound, diagnostics: [...new Set([
        ...sourceMap.diagnostics, ...validateCourseMindMap(rebound, nextCourse, candidate.scenes).issues,
      ])] };
    }
    if (review) {
      const revision = snapshot.design.content.teachingRevisionState;
      if (!revision || revision.changeType !== 'narration'
        || revision.baseClassroomRevision !== (sourceClassroom.revision ?? 1)
        || revision.classroomRevision !== (candidate.revision ?? 1) || revision.invalidated.length) {
        throw new PlatformError('INVALID_AUDIO_CANDIDATE', '新版本必须记录已完成的音频修订，不能保留失效依赖。', 409);
      }
      revision.audioPublication = signCourseAudioPublication({
        schemaVersion: 1, kind: 'course-audio-publication', courseId: input.courseId, teacherId: template.ownerId,
        sourceVersionId: source.id, sourceClassroomId: sourceClassroom.id,
        sourceSnapshotFingerprint: input.sourceSnapshotFingerprint, sourceClassroomFingerprint: hashJson(sourceClassroom),
        teacherReviewSeal: review.seal, classroomId: candidate.id, classroomFingerprint: hashJson(candidate),
        snapshotFingerprint: audioPublicationSnapshotFingerprint(nextCourse),
        signature: computeCourseQualitySignature({ ...nextCourse, id: review.courseId }, candidate),
        publishedAt: new Date().toISOString(),
      });
    }
    const version = source.version + 1;
    const created = await tx.classroomTemplateVersion.create({ data: {
      templateId: input.courseId, version, status: 'PUBLISHED', snapshot: snapshot as unknown as Prisma.InputJsonValue,
      ...(input.mediaRefs !== undefined ? { mediaRefs: input.mediaRefs } : source.mediaRefs ? { mediaRefs: source.mediaRefs as Prisma.InputJsonValue } : {}),
    } });
    const updatedAt = new Date(Math.max(Date.now(), template.updatedAt.getTime() + 1));
    await tx.classroomTemplate.update({ where: { id: input.courseId }, data: {
      updatedAt, ...(courseName !== undefined ? { title: courseName } : {}),
    } });
    return { version, versionId: created.id, classroomId: candidate.id, courseVersion: updatedAt.getTime() };
  };
  return db === prisma ? runMutationTransaction(publish) : db.$transaction(publish, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10_000,
  });
}

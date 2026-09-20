import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';
import { authorizeTemplateRequest } from '@/lib/platform/template-access';
import { prisma } from '@/lib/db/client';
import { getCourse, updateCourse } from '@/lib/session/server-store';
import type { Course, OpenMaicSceneOutlineSnapshot } from '@/lib/session/types';
import {
  ClassroomRevisionConflictError,
  copyClassroomMedia,
  persistClassroom,
  readClassroom,
  updatePersistedClassroomForEditing,
} from '@openmaic/lib/server/classroom-storage';
import {
  InvalidClassroomEditError,
  prepareClassroomEdit,
} from '@openmaic/lib/server/classroom-edit';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import {
  persistClassroomAudioUploads,
  prepareClassroomAudioUploads,
} from '@openmaic/lib/server/classroom-edit-audio';
import {
  collectGeneratedTeacherReviewItems,
  teacherReviewSummary,
} from '@/lib/course-generation/teacher-review-items';
import type { SceneOutline } from '@/lib/openmaic/types/generation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CLASSROOM_EDIT_BYTES = 16 * 1024 * 1024;

type ClassroomEditBody = {
  classroomId?: unknown;
  revision?: unknown;
  stage?: unknown;
  scenes?: unknown;
  audioUploads?: unknown;
};

function classroomIdFor(course: Course): string | undefined {
  return course.aiLearningClassroomId || course.content._openmaicClassroomId;
}

async function classroomIsPublished(courseId: string, classroomId: string): Promise<boolean> {
  const classroomPaths: Prisma.ClassroomTemplateVersionWhereInput[] = [
    { snapshot: { path: ['design', 'aiLearningClassroomId'], equals: classroomId } },
    { snapshot: { path: ['design', 'content', '_openmaicClassroomId'], equals: classroomId } },
  ];
  return Boolean(await prisma.classroomTemplateVersion.findFirst({
    where: {
      templateId: courseId,
      status: { in: ['PUBLISHED', 'published'] },
      OR: classroomPaths,
    },
    select: { id: true },
  }));
}

function syncSceneOutlines(
  course: Course,
  scenes: Scene[],
): OpenMaicSceneOutlineSnapshot[] {
  const current = course.content._openmaicSceneOutlines ?? [];
  const byId = new Map(current.map((outline) => [outline.id, outline]));
  return scenes.map((scene, index) => {
    const outlineId = scene.outlineId || scene.id;
    const previous = byId.get(outlineId) ?? byId.get(scene.id);
    return {
      ...(previous ?? {}),
      id: outlineId,
      type: scene.type,
      title: scene.title,
      description: previous?.description || scene.title,
      keyPoints: previous?.keyPoints ?? [],
      estimatedDuration:
        scene.targetDurationSec
        ?? previous?.targetDurationSec
        ?? previous?.estimatedDuration
        ?? 60,
      order: index,
      stageKey: scene.stageKey ?? previous?.stageKey ?? 'ai-learning',
      stageLabel: scene.stageLabel ?? previous?.stageLabel,
      audience: scene.audience ?? previous?.audience ?? 'student',
      generationPurpose:
        scene.generationPurpose
        ?? previous?.generationPurpose
        ?? 'knowledge-teaching',
      parentActivityId: scene.parentActivityId ?? previous?.parentActivityId,
      detailKind: scene.detailKind ?? previous?.detailKind,
      knowledgePointIds: scene.knowledgePointIds ?? previous?.knowledgePointIds ?? [],
      targetDurationSec:
        scene.targetDurationSec
        ?? previous?.targetDurationSec
        ?? previous?.estimatedDuration
        ?? 60,
      ttsPolicy: scene.ttsPolicy ?? previous?.ttsPolicy,
      timingPlan: scene.timingPlan ?? previous?.timingPlan,
      resourceTypes: scene.resourceTypes ?? previous?.resourceTypes,
      teachingToolPlan: scene.teachingToolPlan ?? previous?.teachingToolPlan,
    } satisfies OpenMaicSceneOutlineSnapshot;
  });
}

function sceneVisualMeaning(scene: Scene): unknown {
  if (scene.content.type !== 'slide') return scene.content;
  return scene.content.canvas.elements.map((element) => {
    const record = element as unknown as Record<string, unknown>;
    return Object.fromEntries(['id', 'type', 'content', 'text', 'src', 'latex', 'path', 'start', 'end', 'chartType', 'data']
      .filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
  });
}

function deriveRevisionState(before: Scene[], after: Scene[], nextRevision: number) {
  const previous = new Map(before.map((scene) => [scene.id, scene]));
  const narrationIds: string[] = [];
  const visualIds: string[] = [];
  const layoutIds: string[] = [];
  for (const scene of after) {
    const prior = previous.get(scene.id);
    if (!prior) { visualIds.push(scene.id); narrationIds.push(scene.id); continue; }
    const beforeSpeech = (prior.actions ?? []).filter((action) => action.type === 'speech').map((action) => [action.id, action.text]);
    const afterSpeech = (scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => [action.id, action.text]);
    if (JSON.stringify(beforeSpeech) !== JSON.stringify(afterSpeech)) narrationIds.push(scene.id);
    if (JSON.stringify(sceneVisualMeaning(prior)) !== JSON.stringify(sceneVisualMeaning(scene))) visualIds.push(scene.id);
    else if (JSON.stringify(prior.content) !== JSON.stringify(scene.content)) layoutIds.push(scene.id);
  }
  const afterIds = new Set(after.map((scene) => scene.id));
  for (const scene of before) if (!afterIds.has(scene.id)) {
    visualIds.push(scene.id);
    narrationIds.push(scene.id);
  }
  const affectedSceneIds = [...new Set([...narrationIds, ...visualIds, ...layoutIds])];
  const changeType: 'narration' | 'layout' | 'visual-content' | 'mixed' = narrationIds.length && (visualIds.length || layoutIds.length) ? 'mixed'
    : narrationIds.length ? 'narration'
      : visualIds.length ? 'visual-content' : 'layout';
  const invalidated = [...new Set([
    ...(narrationIds.length ? ['audio', 'narration-anchors', 'timing-audit', 'assessment-opportunity'] as const : []),
    ...(visualIds.length ? ['actions', 'narration-anchors', 'assessment-opportunity'] as const : []),
    ...(layoutIds.length ? ['actions'] as const : []),
  ])];
  return { schemaVersion: 1 as const, baseClassroomRevision: nextRevision - 1, classroomRevision: nextRevision,
    changeType, affectedSceneIds, invalidated, updatedAt: new Date().toISOString() };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: '课程不存在' }, { status: 404 });
  const classroomId = classroomIdFor(course);
  if (!classroomId) return Response.json({ error: '学生 AI 课堂尚未生成' }, { status: 404 });
  const classroom = await readClassroom(classroomId);
  if (!classroom) return Response.json({ error: '课堂资源不存在' }, { status: 404 });
  return Response.json({ success: true, classroom });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_CLASSROOM_EDIT_BYTES) {
    return Response.json({ error: '课堂资源超过可编辑大小限制' }, { status: 413 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_CLASSROOM_EDIT_BYTES) {
    return Response.json({ error: '课堂资源超过可编辑大小限制' }, { status: 413 });
  }
  let body: ClassroomEditBody;
  try {
    body = JSON.parse(rawBody) as ClassroomEditBody;
  } catch {
    return Response.json({ error: '编辑内容不是有效 JSON' }, { status: 400 });
  }
  if (
    !body || typeof body !== 'object'
    || !Number.isInteger(body.revision)
    || (body.revision as number) < 0
    || !body.stage
    || !Array.isArray(body.scenes)
  ) {
    return Response.json({ error: '编辑内容缺少课堂、页面或修订号' }, { status: 400 });
  }

  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: '课程不存在' }, { status: 404 });
  const sourceClassroomId = classroomIdFor(course);
  if (!sourceClassroomId) return Response.json({ error: '学生 AI 课堂尚未生成' }, { status: 404 });
  const existing = await readClassroom(sourceClassroomId);
  if (!existing) return Response.json({ error: '课堂资源不存在' }, { status: 404 });
  const actualRevision = existing.revision ?? 0;
  if (actualRevision !== body.revision
    || (body.classroomId !== undefined && body.classroomId !== sourceClassroomId)) {
    return Response.json({
      error: '课堂资源已在其他页面更新，请重新加载后再修改',
      code: 'REVISION_CONFLICT',
      actualRevision,
    }, { status: 409 });
  }
  if (existing.assetGeneration?.status === 'running') {
    return Response.json({
      error: '图片或语音仍在生成，请等待资源生成完成后再保存编辑',
      code: 'ASSET_GENERATION_RUNNING',
    }, { status: 409 });
  }

  try {
    const forkPublishedClassroom = await classroomIsPublished(courseId, sourceClassroomId);
    const targetClassroomId = forkPublishedClassroom
      ? `${sourceClassroomId}-edit-${nanoid(8)}`
      : sourceClassroomId;
    const prepared = prepareClassroomEdit({
      existing,
      stage: body.stage as Stage,
      scenes: body.scenes as Scene[],
      targetClassroomId,
    });
    const audio = prepareClassroomAudioUploads({
      uploads: body.audioUploads,
      submittedScenes: body.scenes as Scene[],
      scenes: prepared.scenes,
      classroomId: targetClassroomId,
    });
    prepared.scenes = audio.scenes;
    const revisionState = deriveRevisionState(existing.scenes, prepared.scenes, actualRevision + 1);
    const previousSpeech = new Map(existing.scenes.flatMap((scene) => (scene.actions ?? [])
      .filter((action) => action.type === 'speech')
      .map((action) => [JSON.stringify([scene.id, action.id]), action])));
    const narrationChanged = prepared.narrationChanged && prepared.scenes.some((scene) =>
      scene.actions?.some((action) => action.type === 'speech'
        && previousSpeech.get(JSON.stringify([scene.id, action.id]))?.text !== action.text
        && !action.audioUrl));
    let classroom;
    if (forkPublishedClassroom) {
      await copyClassroomMedia(sourceClassroomId, targetClassroomId);
      await persistClassroomAudioUploads(targetClassroomId, audio.files);
      classroom = await persistClassroom({
        id: targetClassroomId,
        stage: prepared.stage,
        scenes: prepared.scenes,
      });
    } else {
      await persistClassroomAudioUploads(targetClassroomId, audio.files);
      classroom = await updatePersistedClassroomForEditing(
        sourceClassroomId,
        { stage: prepared.stage, scenes: prepared.scenes },
        body.revision as number,
      );
    }

    await updateCourse(courseId, (current) => {
      // This updater runs under the course database lock. Two tabs forking the
      // same published resource must not both replace the course's draft link.
      if (classroomIdFor(current) !== sourceClassroomId) {
        throw new ClassroomRevisionConflictError(body.revision as number, actualRevision);
      }
      const syncedOutlines = syncSceneOutlines(current, prepared.scenes);
      const teacherReviewItems = collectGeneratedTeacherReviewItems({
        outlines: syncedOutlines as unknown as SceneOutline[],
        scenes: prepared.scenes,
      });
      return {
        ...current,
        status: 'preparing',
        aiLearningClassroomId: targetClassroomId,
        content: {
          ...current.content,
          teacherReview: undefined,
          renderReview: undefined,
          qualityReview: undefined,
          teacherReviewItems,
          teacherReviewSummary: teacherReviewSummary(teacherReviewItems),
          teacherReviewVersion: {
            generationPolicyVersion: 'teacher-edited-classroom-v1',
            classroomId: targetClassroomId,
            classroomRevision: classroom.revision,
            generatedAt: new Date().toISOString(),
          },
          teachingTimingAudit: revisionState.invalidated.includes('timing-audit')
            ? undefined : current.content.teachingTimingAudit,
          teachingRevisionState: revisionState,
          _openmaicClassroomId: targetClassroomId,
          _openmaicScenesCount: prepared.scenes.length,
          _openmaicSceneOutlines: syncedOutlines,
        },
      };
    }, { actor: { id: requestedBy, role: 'teacher' } });

    return Response.json({
      success: true,
      classroom,
      forkedDraft: forkPublishedClassroom,
      narrationChanged,
      dependencyInvalidation: revisionState,
    });
  } catch (error) {
    if (error instanceof ClassroomRevisionConflictError) {
      return Response.json({
        error: '课堂资源已在其他页面更新，请重新加载后再修改',
        code: 'REVISION_CONFLICT',
        actualRevision: error.actualRevision,
      }, { status: 409 });
    }
    if (error instanceof InvalidClassroomEditError) {
      return Response.json({ error: error.message, code: 'INVALID_CLASSROOM_EDIT' }, { status: 400 });
    }
    throw error;
  }
}

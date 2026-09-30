/** Backfill a confirmed course's original-figure contract and queue a bounded
 * classroom update. Run with DATABASE_URL and an explicit phase/course ID. */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { initializeServerProviderConfig } from '@/lib/openmaic/server/provider-config';
import { generateTTSForClassroom, resolveServerTtsTimingSelection } from '@/lib/openmaic/server/classroom-media-generation';
import { loadPblTemplateCourse } from '@/lib/platform/pbl-template-repository';
import { encodePblTemplate } from '@/lib/platform/pbl-template';
import { hydrateCourseEvidenceFigureReferences, resolveCourseTextbookFigures } from '@/lib/textbook/course-evidence';
import { assertRequiredTextbookFiguresAvailable, bindRequiredTextbookFiguresToBlueprint,
  bindRequiredTextbookFiguresToOutlines } from '@/lib/textbook/course-visual-binding';
import { recordCourseDesignEdit } from '@/lib/course-design/workspace';
import { contentGenerationJobs } from '@/lib/course-generation/job-storage';
import { estimatePersistedCourseGenerationSeconds, type PersistedCourseGenerationRequest } from '@/lib/course-generation/job-runner';
import { buildCourseTeachingConstraints, buildPblCourseRequirement } from '@/lib/openmaic/pbl/course-request';
import { getPblTemplatePublicationState } from '@/lib/platform/pbl-template-repository';
import { readClassroom, updatePersistedClassroomForEditing } from '@/lib/openmaic/server/classroom-storage';
import { mergeCourseDesignClassroomScenes, resolveCourseDesignUpdate } from '@/lib/course-design/workspace';
import { auditCourseGeneratedResources } from '@/lib/course-generation/resource-audit-server';
import { collectGeneratedTeacherReviewItems, teacherReviewSummary } from '@/lib/course-generation/teacher-review-items';
import { summarizeTeachingTimingAudit } from '@/lib/openmaic/server/classroom-asset-generation';
import { updateCourse } from '@/lib/session/server-store';
import type { Course, OpenMaicSceneOutlineSnapshot } from '@/lib/session/types';
import type { SceneOutline } from '@/lib/openmaic/types/generation';

const [phase, courseId] = process.argv.slice(2);
if (!['inspect', 'prepare', 'queue', 'adopt', 'polish'].includes(phase ?? '') || !courseId) {
  throw new Error('Usage: repair-course-textbook-originals.ts inspect|prepare|adopt|polish COURSE_ID | queue COURSE_ID SECTION_ID...');
}

async function plannedCourse() {
  const course = await loadPblTemplateCourse(courseId);
  if (!course?.content.courseEvidence || !course.content.teachingBlueprint || !course.content._openmaicSceneOutlines?.length) {
    throw new Error('Course lacks confirmed textbook evidence, blueprint, or outlines');
  }
  const evidence = course.content.courseEvidence;
  const items = await hydrateCourseEvidenceFigureReferences(evidence.items);
  const payload = {
    schemaVersion: evidence.schemaVersion, selections: evidence.selections, items,
    mappings: evidence.mappings, retrievalMode: evidence.retrievalMode, warnings: evidence.warnings,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const changed = fingerprint !== evidence.fingerprint;
  const upgradedEvidence = changed ? {
    ...evidence, ...payload, fingerprint, version: evidence.version + 1,
    createdAt: new Date().toISOString(),
  } : evidence;
  const resources = await resolveCourseTextbookFigures(upgradedEvidence, course.content.knowledgePoints);
  assertRequiredTextbookFiguresAvailable(resources);
  const blueprint = bindRequiredTextbookFiguresToBlueprint(course.content.teachingBlueprint, resources);
  const outlines = bindRequiredTextbookFiguresToOutlines(course.content._openmaicSceneOutlines as SceneOutline[], resources) as OpenMaicSceneOutlineSnapshot[];
  return { course, evidence, upgradedEvidence, changed, resources, blueprint, outlines };
}

async function prepare() {
  const planned = await plannedCourse();
  const { course, evidence, upgradedEvidence, changed, resources, blueprint, outlines } = planned;
  const required = resources.filter((item) => item.required);
  console.log(JSON.stringify({ phase, courseId, evidenceChanged: changed,
    requiredFigures: required.map((item) => ({ figureId: item.figureId,
      knowledgePointIds: item.knowledgePointIds, status: item.status })) }));
  if (phase === 'inspect') return;
  const next: Course = { ...course, status: 'preparing', content: {
    ...course.content, courseEvidence: upgradedEvidence, teachingBlueprint: blueprint,
    _openmaicSceneOutlines: outlines,
    classroomGenerationRun: course.content.classroomGenerationRun
      ? { ...course.content.classroomGenerationRun, status: 'pending', generatedAt: undefined }
      : undefined,
    teacherReview: undefined, renderReview: undefined, qualityReview: undefined,
    teachingTimingAudit: undefined, teachingRevisionState: undefined,
  } };
  next.content.designWorkspaceRevision = recordCourseDesignEdit(next, 'blueprint', { impactTargets: ['classroom'] });
  const snapshot = encodePblTemplate(next) as unknown as Prisma.InputJsonValue;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${courseId}`}, 0))`);
    const current = await tx.classroomTemplate.findUnique({ where: { id: courseId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!current || current.status !== 'ACTIVE' || current.updatedAt.getTime() !== course.version
      || !current.versions[0] || current.versions[0].status !== 'DRAFT') {
      throw new Error('Course changed or is not an active draft; inspect again before repair');
    }
    if (changed) {
      const prior = await tx.courseEvidenceSnapshot.findFirst({
        where: { templateId: courseId, isCurrent: true }, orderBy: { version: 'desc' },
      });
      if (!prior || prior.version !== evidence.version) throw new Error('Evidence version changed');
      const bindings = await tx.courseEvidenceSnapshotBinding.findMany({ where: { snapshotId: prior.id } });
      await tx.courseEvidenceSnapshot.update({ where: { id: prior.id }, data: { isCurrent: false } });
      const created = await tx.courseEvidenceSnapshot.create({ data: {
        templateId: courseId, version: upgradedEvidence.version, status: 'READY', isCurrent: true,
        fingerprint: upgradedEvidence.fingerprint, payload: upgradedEvidence as unknown as Prisma.InputJsonValue,
      } });
      if (bindings.length) await tx.courseEvidenceSnapshotBinding.createMany({ data: bindings.map((binding) => ({
        snapshotId: created.id, bindingId: binding.bindingId,
      })) });
    }
    const latest = current.versions[0];
    await tx.classroomTemplateVersion.update({ where: { id: latest.id }, data: { status: 'SUPERSEDED' } });
    await tx.classroomTemplateVersion.create({ data: {
      templateId: courseId, version: latest.version + 1, status: 'DRAFT', snapshot,
    } });
    await tx.classroomTemplate.update({ where: { id: courseId }, data: {
      updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
    } });
  });
  console.log(JSON.stringify({ phase: 'prepared', courseId, evidenceVersion: upgradedEvidence.version,
    protectedFigures: required.length }));
}

async function queue() {
  const course = await loadPblTemplateCourse(courseId);
  if (!course?.content.designWorkspaceRevision || !course.content._openmaicSceneOutlines?.length) {
    throw new Error('Prepared course not found');
  }
  const sections = new Set(process.argv.slice(4));
  if (!sections.size) throw new Error('Specify the affected teaching section IDs');
  const affected = course.content._openmaicSceneOutlines.filter((outline) => sections.has(outline.lectureSectionId ?? ''));
  if (affected.length < 2 || !course.aiLearningClassroomId
    || [...sections].some((id) => !affected.some((outline) => outline.lectureSectionId === id))) {
    throw new Error('Expected classroom sections are missing');
  }
  const job = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!job || ['queued', 'running', 'cancelling'].includes(job.status)) throw new Error('Content job is unavailable or busy');
  const prior = job.request as unknown as PersistedCourseGenerationRequest;
  const request: PersistedCourseGenerationRequest = {
    ...prior, courseId, courseTitle: course.name, generationScope: 'full-course',
    fullSceneCount: course.content._openmaicSceneOutlines.length, testLesson: undefined,
    requirement: buildPblCourseRequirement(course, course.content, affected as SceneOutline[]),
    teachingConstraints: buildCourseTeachingConstraints(course, course.content),
    sceneOutlines: affected as SceneOutline[], knowledgePoints: course.content.knowledgePoints,
    moduleTimingPlan: course.content.moduleTimingPlan,
    updateTarget: { baseDesignRevision: course.content.designWorkspaceRevision.revision,
      baseClassroomId: course.aiLearningClassroomId, affectedSectionIds: [...sections],
      affectedOutlineIds: affected.map((outline) => outline.id) },
  };
  await contentGenerationJobs.replace({
    where: { id: job.id, version: job.version, status: job.status }, checkpointPolicy: 'all',
    data: { status: 'queued', step: 'queued', progress: 0,
      message: '等待更新受教材原图影响的知识小节', scenesGenerated: 0,
      totalScenes: affected.length,
      estimatedRemainingSeconds: estimatePersistedCourseGenerationSeconds({
        totalScenes: affected.length, adaptiveBranchCount: 0,
        enableImageGeneration: request.enableImageGeneration,
        enableVideoGeneration: request.enableVideoGeneration, enableTTS: request.enableTTS,
      }),
      request: request as unknown as Prisma.InputJsonValue,
      result: Prisma.JsonNull, qualityReport: Prisma.JsonNull, events: [], error: null,
      startedAt: null, completedAt: null, lastHeartbeatAt: null,
      executionId: null, executionOwner: null, leaseExpiresAt: null,
      version: { increment: 1 },
    },
  });
  console.log(JSON.stringify({ phase: 'queued', courseId, sectionIds: [...sections], pages: affected.length }));
}

async function adopt() {
  const course = await loadPblTemplateCourse(courseId);
  const candidate = course?.content.designWorkspaceRevision?.candidateUpdates?.find((item) => item.target === 'classroom');
  if (!course || !candidate) throw new Error('No completed classroom update candidate');
  const [base, generated, job, template] = await Promise.all([
    readClassroom(candidate.baseClassroomId), readClassroom(candidate.classroomId),
    contentGenerationJobs.findUnique({ where: { courseId } }),
    prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true } }),
  ]);
  if (!base || !generated || !template || job?.status !== 'completed') throw new Error('Candidate resources or completed job missing');
  const outlineIds = course.content._openmaicSceneOutlines?.map((item) => item.id) ?? [];
  const mergedScenes = mergeCourseDesignClassroomScenes({ outlineIds,
    affectedOutlineIds: candidate.affectedOutlineIds,
    baseScenes: base.scenes, candidateScenes: generated.scenes });
  if (!mergedScenes) throw new Error('Candidate pages do not cover the requested update');
  const mergedClassroom = { ...generated, stage: base.stage, scenes: mergedScenes };
  const audit = await auditCourseGeneratedResources(courseId, { course: {
    ...course, aiLearningClassroomId: candidate.classroomId,
    content: { ...course.content, _openmaicClassroomId: candidate.classroomId },
  }, classroom: mergedClassroom });
  const originalIssues = audit.issues.filter((issue) =>
    issue.id.startsWith('media:source-image:') || issue.id.startsWith('content:source-sequence:'));
  if (originalIssues.length) throw new Error(`Candidate still omits textbook originals: ${originalIssues.map((item) => item.id).join(', ')}`);
  const persisted = await updatePersistedClassroomForEditing(candidate.classroomId,
    { stage: base.stage, scenes: mergedScenes }, generated.revision ?? 1);
  const outlines = course.content._openmaicSceneOutlines ?? [];
  const reviewItems = collectGeneratedTeacherReviewItems({ outlines: outlines as SceneOutline[], scenes: mergedScenes });
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  const timingAudit = summarizeTeachingTimingAudit({ outlines: outlines as SceneOutline[],
    studentScenes: mergedScenes, enableTTS: request.enableTTS !== false });
  await updateCourse(courseId, (current) => {
    const workspace = current.content.designWorkspaceRevision;
    if (current.version !== course.version || workspace?.revision !== candidate.baseRevision
      || (current.aiLearningClassroomId || current.content._openmaicClassroomId) !== candidate.baseClassroomId) {
      throw new Error('Course changed before candidate adoption');
    }
    const resolved = resolveCourseDesignUpdate(current.content, 'classroom');
    return { ...current, status: 'preparing', aiLearningClassroomId: candidate.classroomId,
      content: { ...current.content,
        teacherReview: undefined, renderReview: undefined, qualityReview: undefined,
        teachingTimingAudit: timingAudit, teachingRevisionState: undefined,
        teacherReviewItems: reviewItems, teacherReviewSummary: teacherReviewSummary(reviewItems),
        teacherReviewVersion: { generationPolicyVersion: 'bounded-classroom-update-v1',
          classroomId: candidate.classroomId, classroomRevision: persisted.revision,
          generatedAt: new Date().toISOString() },
        _openmaicClassroomId: candidate.classroomId, _openmaicScenesCount: mergedScenes.length,
        classroomGenerationRun: { scope: 'full-course', status: 'completed',
          generatedOutlineIds: outlineIds, fullOutlineCount: outlineIds.length,
          generatedAt: new Date().toISOString() },
        designWorkspaceRevision: { ...resolved,
          candidateUpdates: (resolved.candidateUpdates ?? []).filter((item) => item.id !== candidate.id) },
      },
    };
  }, { actor: { id: template.ownerId, role: 'teacher' } });
  const state = await getPblTemplatePublicationState(courseId);
  console.log(JSON.stringify({ phase: 'adopted', courseId, classroomId: candidate.classroomId,
    version: state.latestVersion, originalIssues: originalIssues.length, otherResourceIssues: audit.issues.length }));
}

/** Match the project-mode explanation to the six steps visible in figure 32. */
async function polish() {
  const course = await loadPblTemplateCourse(courseId);
  const classroomId = course?.aiLearningClassroomId;
  if (!course || !classroomId || courseId !== '678640e8-c6d6-4d8e-a8d4-eac570308fc2') {
    throw new Error('This verified layout repair only applies to the confirmed test course');
  }
  const original = await readClassroom(classroomId);
  if (!original) throw new Error('Current classroom is unavailable');
  const classroom = structuredClone(original);
  const scene = classroom.scenes.find((item) => item.outlineId === 'teaching-section-4-page-1');
  if (!scene || scene.content.type !== 'slide') throw new Error('Project-mode teaching slide is unavailable');
  const figures = await resolveCourseTextbookFigures(course.content.courseEvidence, course.content.knowledgePoints);
  const figure = figures.find((item) => item.figureId === 'daae5ccb-e4e2-5061-b3c1-be238f801399' && item.required);
  if (!figure?.src) throw new Error('The original figure 32 is not available');
  const elements = scene.content.canvas.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const image = byId.get('image_textbook_flow');
  const panel = byId.get('shape_def_panel');
  const definition = byId.get('text_definition');
  const annotation = byId.get('teaching-section-4-page-1-component-0-annotation');
  const narration = scene.actions?.find((action) => action.id === 'teaching-section-4-page-1:speech-3');
  if (image?.type !== 'image' || image.src !== figure.src || panel?.type !== 'shape'
    || definition?.type !== 'text' || annotation?.type !== 'text'
    || !annotation.content.includes('五个环节') || narration?.type !== 'speech'
    || !narration.text.includes('五个环节') || byId.has('teaching-section-4-page-1-component-0-node-evaluate')) {
    throw new Error('Verified project-mode slide layout changed; review before repair');
  }
  panel.width = 600;
  definition.width = 580;
  Object.assign(image, { left: 660, top: 42, width: 320, height: 186 });
  annotation.content = '<p style="font-size:18px;font-weight:700;text-align:left">原图六环节：前四项见左侧，之后展示成果、评价活动；制作作品与探究紧密衔接。</p>';
  const names = ['choose', 'plan', 'explore', 'make', 'share'];
  for (const [index, name] of names.entries()) {
    const node = byId.get(`teaching-section-4-page-1-component-0-node-${name}`);
    if (node?.type !== 'shape' || !node.text) throw new Error(`Missing original flow node: ${name}`);
    node.left = 50 + 160 * index;
    node.width = 100;
    node.text.content = node.text.content.replace('font-size:20px', 'font-size:18px');
  }
  const share = byId.get('teaching-section-4-page-1-component-0-node-share');
  if (share?.type !== 'shape' || !share.text) throw new Error('The share node is unavailable');
  const evaluation = structuredClone(share);
  evaluation.id = 'teaching-section-4-page-1-component-0-node-evaluate';
  evaluation.left = 850;
  evaluation.text!.content = evaluation.text!.content.replace('成果交流', '活动评价');
  elements.push(evaluation);
  for (let index = 0; index < 4; index += 1) {
    const edge = byId.get(`teaching-section-4-page-1-component-0-edge-${index}`);
    if (edge?.type !== 'line') throw new Error(`Missing original flow edge: ${index}`);
    edge.left = 150 + 160 * index;
    edge.end = [60, 0];
  }
  const finalEdge = byId.get('teaching-section-4-page-1-component-0-edge-3');
  if (finalEdge?.type !== 'line') throw new Error('The final flow edge is unavailable');
  elements.push({ ...structuredClone(finalEdge), id: 'teaching-section-4-page-1-component-0-edge-4', left: 790 });
  narration.text = narration.text.replace('把五个环节按顺序排开了', '把六个环节按顺序排开了')
    .replace('最后成果交流，学生把作品展示出来。',
      '接着是成果交流，学生把作品展示出来。最后进行活动评价，依据起初目标回顾作品成果和探究过程。');
  delete narration.audioUrl;
  delete narration.audioId;
  delete narration.audioDurationSec;
  delete narration.speechAlignment;
  await initializeServerProviderConfig();
  await generateTTSForClassroom([scene], classroomId, process.env.PUBLIC_BASE_URL ?? '', undefined,
    resolveServerTtsTimingSelection());
  const audit = await auditCourseGeneratedResources(courseId, { course, classroom });
  if (audit.issues.length) throw new Error(`Updated slide failed resource audit: ${audit.issues.map((issue) => issue.id).join(', ')}`);
  const timingAudit = summarizeTeachingTimingAudit({
    outlines: course.content._openmaicSceneOutlines as SceneOutline[], studentScenes: classroom.scenes, enableTTS: true,
  });
  if (!timingAudit.complete || !timingAudit.teachingRatioValid) throw new Error('Updated narration exceeds the confirmed teaching budget');
  const persisted = await updatePersistedClassroomForEditing(classroomId,
    { stage: classroom.stage, scenes: classroom.scenes }, original.revision ?? 0);
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true } });
  if (!template) throw new Error('Course owner is unavailable');
  await updateCourse(courseId, (current) => {
    if (current.version !== course.version || current.aiLearningClassroomId !== classroomId) {
      throw new Error('Course changed during verified layout repair');
    }
    return { ...current, content: { ...current.content, teachingTimingAudit: timingAudit,
      teacherReview: undefined, renderReview: undefined, qualityReview: undefined,
      teacherReviewVersion: current.content.teacherReviewVersion
        ? { ...current.content.teacherReviewVersion, classroomRevision: persisted.revision }
        : undefined } };
  }, { actor: { id: template.ownerId, role: 'teacher' } });
  console.log(JSON.stringify({ phase: 'polished', courseId, classroomId,
    classroomRevision: persisted.revision, resourceIssues: audit.issues.length,
    teachingDurationDeviationRatio: timingAudit.teachingDurationDeviationRatio }));
}

async function main() {
  try {
    if (phase === 'queue') await queue();
    else if (phase === 'adopt') await adopt();
    else if (phase === 'polish') await polish();
    else await prepare();
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

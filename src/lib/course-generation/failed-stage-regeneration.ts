import type { GeneratedSlideContent, SceneOutline } from '@/lib/openmaic/types/generation';
import type { Scene } from '@/lib/openmaic/types/stage';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { AUTHORING_RESPONSE_PREFIX, fingerprintStageAuthoringInput } from './authoring-checkpoints';
import { randomUUID } from 'node:crypto';
import { deserializeCourseGenerationFailure } from './failure-policy';
import { fingerprintSceneOutline, type PageCheckpointSnapshot, type SceneGenerationCheckpointStage,
  type SceneStageAttemptSnapshot, type SceneStageCheckpointSnapshot } from './page-checkpoints';
import { hasCompatibleOutlinePlan } from './generation-scope';
import { findFinalizedSourceContentIssues, findSectionSourceContentIssues, findSourceContentIssues, sourceTeachingSectionId,
  type SourceContentIssue, type SourceContentPage, type SourceContentRecoveryCheckpoint } from './source-content-acceptance';

type SavedRegenerationCheckpoints = {
  stageAttempts: readonly unknown[];
  stages: readonly unknown[];
  pages: readonly unknown[];
  sourceContents: readonly unknown[];
  authoringAcceptances?: readonly unknown[];
  courseFinalization?: unknown;
  preparedOutlines?: unknown;
};
export type FailedStageRegenerationPlan = {
  resetSteps: string[];
  needsExplicitSourceEdit: boolean;
  issues: string[];
};
const stages = new Set<SceneGenerationCheckpointStage>(['content', 'reviewed-content', 'narration', 'actions']);

/** Only an explicit retry of the measured failure can revise unstarted pages. */
export function explicitFailedStageRequestIdentity(error: string | null, authoringRequestId: string = randomUUID()): {
  authoringRequestId: string; capacityReplanRequestId?: string;
} {
  const failure = error ? deserializeCourseGenerationFailure(error) as Error & { code?: string } : undefined;
  return { authoringRequestId, ...(failure?.code === 'TEACHING_PAGE_PREFLIGHT_FAILED'
    ? { capacityReplanRequestId: authoringRequestId } : {}) };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function isStage(value: unknown): value is SceneStageCheckpointSnapshot {
  return record(value) && value.schemaVersion === 1 && typeof value.pageKey === 'string'
    && stages.has(value.stage as SceneGenerationCheckpointStage) && typeof value.outlineFingerprint === 'string'
    && typeof value.modelFingerprint === 'string';
}
function nativeContent(value: unknown): GeneratedSlideContent | undefined {
  return record(value) && Array.isArray(value.elements) ? value as unknown as GeneratedSlideContent : undefined;
}
function sceneContent(scene: Scene | undefined): GeneratedSlideContent | undefined {
  return scene?.content?.type === 'slide' ? nativeContent(scene.content.canvas) : undefined;
}

/** Plan an explicitly authorized replacement of failed authoring. This pure
 * function neither archives nor deletes anything; the storage transaction owns
 * history and retains all media records. A changed hash is not new permission. */
export function planFailedStageRegeneration(input: {
  saved: SavedRegenerationCheckpoints;
  request: { sceneOutlines?: readonly SceneOutline[] };
  sourceContracts?: readonly FigureSequenceContract[];
  reviewContent?: boolean;
}): FailedStageRegenerationPlan {
  const { saved } = input;
  const reset = new Set<string>();
  const issues: string[] = [];
  const accepted = new Map(saved.stages.filter(isStage).map((item) => [`${item.pageKey}:${item.stage}`, item]));
  const authoringAccepted = new Map((saved.authoringAcceptances ?? []).filter((value) => record(value)
    && value.accepted === true && isStage(value)).map((value) => {
    const receipt = value as SceneStageCheckpointSnapshot;
    return [`${receipt.pageKey}:${receipt.stage}`, receipt];
  }));
  const authoringOutlines = new Map([
    ...(input.request.sceneOutlines ?? []),
    ...(Array.isArray(saved.preparedOutlines) ? saved.preparedOutlines as SceneOutline[] : []),
  ].map((outline) => [outline.id, outline]));
  const resetAuthoring = (id: string, stage: SceneGenerationCheckpointStage) => {
    reset.add(`stage-attempt:${id}:${stage}`);
    reset.add(`${AUTHORING_RESPONSE_PREFIX}${id}:${stage}`);
    reset.add(`authoring-acceptance:${id}:${stage}`);
  };
  const resetStage = (id: string, stage: SceneGenerationCheckpointStage) => {
    reset.add(`stage:${id}:${stage}`);
    resetAuthoring(id, stage);
  };
  for (const value of saved.stageAttempts) {
    if (!isStage(value)) continue;
    const attempt = value as unknown as SceneStageAttemptSnapshot;
    if (!Number.isInteger(attempt.attemptsStarted) || attempt.attemptsStarted < 1) continue;
    const stage = accepted.get(`${attempt.pageKey}:${attempt.stage}`);
    if (stage && stage.outlineFingerprint === attempt.outlineFingerprint
      && stage.modelFingerprint === attempt.modelFingerprint && stage.inputFingerprint === attempt.inputFingerprint) continue;
    const receipt = authoringAccepted.get(`${attempt.pageKey}:${attempt.stage}`);
    const outline = authoringOutlines.get(attempt.pageKey);
    // Native compilation can change the stage input hash while retaining the
    // same validated authoring response. Preserve that exact paid draft; a
    // different source/model/request or unaccepted response still resets.
    if (stage && receipt && outline && typeof attempt.inputFingerprint === 'string'
      && stage.outlineFingerprint === attempt.outlineFingerprint && stage.modelFingerprint === attempt.modelFingerprint
      && receipt.outlineFingerprint === attempt.outlineFingerprint && receipt.modelFingerprint === attempt.modelFingerprint
      && receipt.inputFingerprint === fingerprintStageAuthoringInput(outline, attempt.stage, attempt.inputFingerprint)) continue;
    resetAuthoring(attempt.pageKey, attempt.stage);
  }
  const completed = new Map(saved.pages.filter((value): value is PageCheckpointSnapshot => record(value)
    && typeof value.pageKey === 'string' && record(value.scene)).map((page) => [page.pageKey, page]));
  for (const stage of accepted.values()) {
    if (stage.stage !== 'content' || completed.has(stage.pageKey)) continue;
    const content = record(stage.payload) && record(stage.payload.content) ? stage.payload.content : undefined;
    if (Array.isArray(content?.questions) && !Array.isArray(content.phaseNarration)
      && !accepted.has(`${stage.pageKey}:actions`)) resetStage(stage.pageKey, 'content');
  }

  if (input.reviewContent === false) return { resetSteps: [...reset].sort(), needsExplicitSourceEdit: false, issues: [] };

  const requestOutlines = input.request.sceneOutlines ?? [];
  const prepared = Array.isArray(saved.preparedOutlines) ? saved.preparedOutlines as SceneOutline[] : undefined;
  const outlines = prepared?.length && hasCompatibleOutlinePlan(requestOutlines, prepared) ? prepared : requestOutlines;
  const byId = new Map(outlines.map((outline) => [outline.id, outline]));
  const finalization = record(saved.courseFinalization) && record(saved.courseFinalization.generated)
    ? saved.courseFinalization.generated : undefined;
  const finalScenes = Array.isArray(finalization?.scenes) ? finalization.scenes as Scene[] : [];
  const finalOutlines = record(finalization?.assetContext) && Array.isArray(finalization.assetContext.outlines)
    ? finalization.assetContext.outlines as SceneOutline[] : [];
  const finalById = new Map(finalOutlines.map((outline) => [outline.id, outline]));
  const matchingFinalScenes = finalScenes.filter((scene) => {
    const id = scene.outlineId ?? scene.id;
    const current = byId.get(id), original = finalById.get(id);
    return current && original && fingerprintSceneOutline(current) === fingerprintSceneOutline(original);
  });
  const finalSceneById = new Map(matchingFinalScenes.map((scene) => [scene.outlineId ?? scene.id, scene]));
  const contentPages: SourceContentPage[] = outlines.flatMap((outline) => {
    const stage = accepted.get(`${outline.id}:content`);
    const page = completed.get(outline.id);
    const content = stage?.outlineFingerprint === fingerprintSceneOutline(outline) && record(stage.payload)
      ? nativeContent(stage.payload.content) : undefined;
    const body = content ?? (page?.outlineFingerprint === fingerprintSceneOutline(outline) ? sceneContent(page.scene) : undefined)
      ?? sceneContent(finalSceneById.get(outline.id));
    return body ? [{ outline, content: body }] : [];
  });
  const sourceIssues: SourceContentIssue[] = [];
  for (const value of saved.sourceContents) {
    if (!record(value) || value.status !== 'infeasible') continue;
    const checkpoint = value as unknown as SourceContentRecoveryCheckpoint;
    if (!Array.isArray(checkpoint.issues) || !checkpoint.issues.length) {
      issues.push(`小节 ${checkpoint.sectionId ?? '未知'} 缺少可定位的来源诊断，请先明确修改的教材或教学职责`);
      continue;
    }
    sourceIssues.push(...checkpoint.issues);
  }
  for (const issue of findFinalizedSourceContentIssues(finalOutlines, finalScenes, input.sourceContracts ?? [])) {
    if (issue.targetOutlineIds.some((id) => !finalSceneById.has(id))) {
      issues.push(`来源 ${issue.resourceId} 的旧最终稿与当前页面职责不匹配，请先确认来源修改`);
    } else sourceIssues.push(issue);
  }
  const affectedSections = new Set<string>();
  const changedContent = new Set<string>();
  const contentById = new Map(contentPages.map((page) => [page.outline.id, page]));
  const visibleIssues = findSourceContentIssues(contentPages, input.sourceContracts ?? [], { visibleOnly: true });
  const actualSpeech = (outline: SceneOutline): string[] | undefined => {
    const narration = accepted.get(`${outline.id}:narration`);
    if (narration?.outlineFingerprint === fingerprintSceneOutline(outline) && record(narration.payload)
      && record(narration.payload.teachingNarration) && Array.isArray(narration.payload.teachingNarration.segments)) {
      const speech = narration.payload.teachingNarration.segments.flatMap((segment) => record(segment)
        && typeof segment.text === 'string' ? [segment.text] : []);
      if (speech.length) return speech;
    }
    const page = completed.get(outline.id);
    const scene = page?.outlineFingerprint === fingerprintSceneOutline(outline) ? page.scene : finalSceneById.get(outline.id);
    const speech = scene?.actions?.flatMap((action) => action.type === 'speech' ? [action.text] : []);
    return speech?.length ? speech : undefined;
  };
  for (const issue of sourceIssues) {
    const targetIds = Array.isArray(issue.targetOutlineIds) && issue.targetOutlineIds.length
      ? issue.targetOutlineIds : outlines.filter((outline) => outline.type === 'slide'
        && outline.generationPurpose === 'knowledge-teaching' && sourceTeachingSectionId(outline) === issue.sectionId).map((outline) => outline.id);
    const targets = targetIds.map((id) => byId.get(id));
    const contracts = (input.sourceContracts ?? []).filter((contract) => contract.resourceId === issue.resourceId
      && contract.required && contract.orderedSteps?.length);
    const sections = new Set(targets.filter((outline): outline is SceneOutline => Boolean(outline))
      .map(sourceTeachingSectionId));
    if (!targetIds.length || targets.some((outline) => !outline || !contentById.has(outline.id))
      || !contracts.length || sections.has('__course__') || !sections.has(issue.sectionId)) {
      issues.push(`来源 ${issue.resourceId ?? '未知'} 无法从当前页面正文与教材合同确定失败阶段，请先明确来源修改`);
      continue;
    }
    const sectionPages = contentPages.filter(({ outline }) => sourceTeachingSectionId(outline) === issue.sectionId);
    const spokenPages = sectionPages.map((item) => ({ ...item, speech: actualSpeech(item.outline) }));
    if (spokenPages.length && spokenPages.every((item) => item.speech?.length)
      && !findSectionSourceContentIssues(outlines, spokenPages, contracts).length) continue;
    // The source gate reports all list participants in targetOutlineIds; only
    // repairOutlineId owns the actually missing visible clauses. Never buy a
    // new slide for every participant in that list.
    const visible = visibleIssues.filter((item) => item.resourceId === issue.resourceId
      && item.sectionId === issue.sectionId);
    for (const item of visible) {
      if (byId.has(item.repairOutlineId)) changedContent.add(item.repairOutlineId);
    }
    // A continuous section narration is one authoring result. Invalidate the
    // complete section once, preserving every accepted visual except proven
    // visible-source failures above.
    affectedSections.add(issue.sectionId);
  }
  const affectedTeaching = outlines.filter((outline) => outline.type === 'slide'
    && outline.generationPurpose === 'knowledge-teaching' && affectedSections.has(sourceTeachingSectionId(outline)));
  for (const outline of affectedTeaching) {
    if (changedContent.has(outline.id)) {
      resetStage(outline.id, 'content');
      resetStage(outline.id, 'reviewed-content');
    }
    resetStage(outline.id, 'narration');
    resetStage(outline.id, 'actions');
    reset.add(`page:${outline.id}`);
  }
  for (const sectionId of affectedSections) reset.add(`source-content:${sectionId}`);
  for (const quiz of outlines.filter((outline) => outline.type === 'quiz')) {
    const units = new Set([...(quiz.assessmentUnitIds ?? []), ...(quiz.assessmentTargets ?? []).map((target) => target.unitId),
      ...(quiz.assessmentUnitMap ?? []).map((target) => target.unitId), ...(quiz.teachingBrief?.understandingCriteria?.supportingUnitIds ?? [])]);
    const next = outlines.filter((outline) => outline.order > quiz.order && outline.audience !== 'teacher'
      && outline.generationPurpose !== 'teacher-resource').sort((a, b) => a.order - b.order)[0];
    const depends = affectedTeaching.some((page) => page.order < quiz.order
      && (sourceTeachingSectionId(page) === sourceTeachingSectionId(quiz)
        || page.teachingUnitIds?.some((unit) => units.has(unit))))
      || Boolean(next && affectedTeaching.some((page) => page.id === next.id));
    if (!depends) continue;
    for (const stage of ['content', 'reviewed-content', 'narration', 'actions'] as const) resetStage(quiz.id, stage);
    reset.add(`page:${quiz.id}`);
  }
  if (affectedSections.size) reset.add('course-finalization');
  return { resetSteps: [...reset].sort(), needsExplicitSourceEdit: issues.length > 0, issues: [...new Set(issues)] };
}

import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@/lib/db/client';
import { getCourse } from '@/lib/session/server-store';
import type { Course } from '@/lib/session/types';
import { contentGenerationJobs, type CourseGenerationJob } from '@/lib/course-generation/job-storage';
import { decodePblTemplate, type PblTemplateDesign } from '@/lib/platform/pbl-template';
import { hydrateCourseEvidenceFigureReferences, resolveCourseTextbookFigures } from '@/lib/textbook/course-evidence';
import { resolveCourseSourceSequenceContracts, type CourseEvidenceItem } from '@/lib/textbook/course-evidence-types';
import { scopeSourceSequenceContracts } from '@/lib/textbook/source-sequence-use';
import { scopeCourseTextbookFigures } from '@/lib/textbook/figure-use';
import { isValidClassroomId, readClassroom, type PersistedClassroomData } from '../../server/classroom-storage';
import type { SceneOutline } from '../../types/generation';
import { slideVisualSourceContent } from '../../generation/slide-visual-projection';
import { pageOriginalTeachingSources } from '../../generation/source-grounding';
import type { SceneContext } from '../tools/regenerate-scene-actions';

type SourceDesign = Pick<PblTemplateDesign, 'content' | 'aiLearningClassroomId' | 'teacherClassroomId'>;
type Sources = NonNullable<SceneContext['teachingSources']>;
type ContextMap = Record<string, SceneContext>;
const NO_SOURCE = '未找到与本页课堂及已采用资料一致的原始来源记录。';
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function classroomIds(design: SourceDesign): string[] {
  return [...new Set([design.aiLearningClassroomId || design.content._openmaicClassroomId,
    design.teacherClassroomId || design.content.teacherClassroomId].filter((id): id is string => Boolean(id)))];
}
function outlines(design: SourceDesign): SceneOutline[] {
  return (design.content._openmaicSceneOutlines ?? []) as SceneOutline[];
}
function adoption(point: { id: string; evidenceItemIds?: readonly string[]; sourceId?: string; sourceKnowledgePointIds?: readonly string[] }) {
  return { id: point.id, evidenceItemIds: point.evidenceItemIds ? [...point.evidenceItemIds] : undefined, sourceId: point.sourceId,
    sourceKnowledgePointIds: point.sourceKnowledgePointIds ? [...point.sourceKnowledgePointIds] : undefined };
}
function selectedSources(design: SourceDesign, outline: SceneOutline) {
  const evidence = design.content.courseEvidence;
  const ids = new Set(outline.knowledgePointIds ?? []);
  const points = design.content.knowledgePoints.filter((point) => ids.has(point.id));
  if (!evidence || !ids.size || points.length !== ids.size) return undefined;
  const adoptedIds = new Set(points.flatMap((point) => point.evidenceItemIds !== undefined ? point.evidenceItemIds
    : evidence.mappings.filter((mapping) => [point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])]
      .includes(mapping.sourceKnowledgePointId) && mapping.status !== 'none').flatMap((mapping) => mapping.evidenceItemIds)));
  const items = evidence.items.filter((item) => adoptedIds.has(item.id));
  if (!items.length || items.length !== adoptedIds.size) return undefined;
  return { evidence, points, items };
}

/** The persisted request serializes each evidence record on one JSON line.
 * Parse those records structurally; a mention of an evidence ID or a short
 * display label cannot prove the original source or its revision. */
function requestEvidence(request: Record<string, unknown>): Map<string, CourseEvidenceItem> {
  const result = new Map<string, CourseEvidenceItem>();
  const conflicting = new Set<string>();
  if (typeof request.teachingSourceContext !== 'string') return result;
  for (const line of request.teachingSourceContext.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    let value: Record<string, unknown>;
    try { value = record(JSON.parse(line)); } catch { continue; }
    const entries = Array.isArray(value.evidence) && typeof record(value.upstreamKnowledgePoint).id === 'string'
      ? value.evidence : Array.isArray(value.evidenceItems) && Array.isArray(value.mappings) ? value.evidenceItems : [];
    for (const entry of entries) {
      const item = record(entry), source = record(item.source);
      const id = typeof item.evidenceId === 'string' ? item.evidenceId : item.id;
      if (typeof id !== 'string' || typeof item.content !== 'string' || !item.content.trim()
        || typeof source.revisionId !== 'string' || typeof source.textbookId !== 'string') continue;
      const normalized = { ...item, id } as unknown as CourseEvidenceItem;
      if (result.has(id) && !isDeepStrictEqual(result.get(id), normalized)) conflicting.add(id);
      result.set(id, normalized);
    }
  }
  for (const id of conflicting) result.delete(id);
  return result;
}

/** A trusted fork points to an actual previous classroom, never an ID inferred
 * from a filename. Its current page still needs the original lesson ownership
 * and unchanged adopted source text, including saved continuation boundaries. */
function matchesOriginalScope(outline: SceneOutline, classroom: PersistedClassroomData, originals: readonly SceneOutline[]): boolean {
  const ancestorIds = new Set([outline.id, outline.spatialParentId, ...(outline.sourcePageIds ?? [])].filter(Boolean));
  const ownership = ['lectureSectionId', 'stageKey', 'activityId', 'parentActivityId', 'knowledgePointIds',
    'teachingUnitIds', 'audience', 'generationPurpose'] as const;
  return originals.some((original) => {
    if (!ancestorIds.has(original.id) || !classroom.scenes.some((scene) => (scene.outlineId ?? scene.id) === original.id
      && scene.stageId === classroom.stage.id)) return false;
    if (outline.spatialParentId && ![original.id, original.spatialParentId].includes(outline.spatialParentId)) return false;
    const originalSources = new Set([original.id, original.spatialParentId, ...(original.sourcePageIds ?? [])]);
    if (outline.sourcePageIds?.some((id) => !originalSources.has(id))) return false;
    if (ownership.some((key) => !isDeepStrictEqual(outline[key], original[key]))) return false;
    for (const key of ['evidence', 'explanation', 'conditions', 'examples'] as const) {
      if (!isDeepStrictEqual(outline.teachingBrief?.[key], original.teachingBrief?.[key])) return false;
    }
    const catalog = new Map(slideVisualSourceContent(original).map((source) => [source.id, source.text]));
    return !outline.visualSourceCatalog?.some((source) => catalog.get(source.id) !== source.text);
  });
}

function jobWitness(course: Course, classroom: PersistedClassroomData, outline: SceneOutline,
  job: CourseGenerationJob | null, witnesses: Map<string, CourseEvidenceItem>, requireOriginalScope = false): ReturnType<typeof selectedSources> {
  if (!job || job.courseId !== course.id || job.status !== 'completed') return undefined;
  const request = record(job.request), result = record(job.result);
  if (request.courseId !== course.id || (result.id !== classroom.id && result.teacherClassroomId !== classroom.id)) return undefined;
  const originalOutlines = Array.isArray(job.preparedOutlines) && job.preparedOutlines.length
    ? job.preparedOutlines : request.sceneOutlines;
  if (requireOriginalScope && (!Array.isArray(originalOutlines)
    || !matchesOriginalScope(outline, classroom, originalOutlines as unknown as SceneOutline[]))) return undefined;
  const currentPackage = course.content.resourcePackage, requestedPackage = record(request.resourcePackageIdentity);
  if (currentPackage ? !currentPackage.confirmedAt || requestedPackage.id !== currentPackage.id
    || requestedPackage.revision !== currentPackage.revision : Boolean(request.resourcePackageIdentity)) return undefined;
  const selected = selectedSources(course, outline);
  if (!selected || !Array.isArray(request.knowledgePoints)) return undefined;
  const requestedPoints = request.knowledgePoints.map(record);
  if (selected.points.some((point) => {
    const original = requestedPoints.find((candidate) => candidate.id === point.id);
    return !original || !isDeepStrictEqual(adoption(point), adoption(original as Parameters<typeof adoption>[0]));
  })) return undefined;
  // Legacy prompt records did not serialize an explicit primary marker. They
  // can prove the selection only when all adopted evidence belongs to the one
  // primary immutable textbook revision, as in generation checkpoint recovery.
  const selection = selected.evidence.selections;
  if (selection.length !== 1 || !selection[0]?.primary
    || selected.items.some((item) => item.source.revisionId !== selection[0]!.revisionId)) return undefined;
  const items: CourseEvidenceItem[] = [];
  for (const item of selected.items) {
    const witness = witnesses.get(item.id);
    if (!witness || witness.kind !== item.kind || witness.content !== item.content
      || !isDeepStrictEqual(witness.source, item.source)) return undefined;
    // Restore complete original blocks and relationships from the saved
    // request, not later mutable additions to the current evidence summary.
    items.push({ ...item, ...witness });
  }
  return { ...selected, items };
}

function immutableWitness(design: PblTemplateDesign, classroom: PersistedClassroomData,
  outline: SceneOutline): ReturnType<typeof selectedSources> {
  if (!classroomIds(design).includes(classroom.id)) return undefined;
  if (!matchesOriginalScope(outline, classroom, outlines(design))) return undefined;
  return selectedSources(design, outline);
}

async function hydrateSources(selected: NonNullable<ReturnType<typeof selectedSources>>, allOutlines: SceneOutline[]): Promise<Sources> {
  const sourceEvidence = { ...selected.evidence, items: await hydrateCourseEvidenceFigureReferences(selected.items,
    { includeAncestorIntroductions: true }) };
  const sourceKnowledgePoints = selected.points.map(adoption);
  const figureLists = sourceEvidence.items.some((item) => item.figureSequences?.length)
    ? scopeCourseTextbookFigures(await resolveCourseTextbookFigures(sourceEvidence, sourceKnowledgePoints), allOutlines) : [];
  return { sourceEvidence, sourceKnowledgePoints,
    sourceSequenceContracts: [
      ...scopeSourceSequenceContracts(resolveCourseSourceSequenceContracts(sourceEvidence, sourceKnowledgePoints), allOutlines),
      ...figureLists.filter((figure) => figure.required && figure.orderedSteps?.length).map((figure) => ({
        resourceId: figure.id, required: true, knowledgePointIds: figure.knowledgePointIds, orderedSteps: figure.orderedSteps,
        scope: 'single-page' as const, sequenceSemantics: 'ordered-steps' as const,
      })),
    ] };
}

/** Call only after course ownership authorization. Client sources are always
 * removed, including standalone requests; only explicit visual redesign reads
 * the diagnostic, so existing read/chat/edit tools retain their behavior. */
export async function hydrateAgentTeachingSourceContexts(input: {
  authorizedCourseId?: string;
  sceneContextMap: ContextMap;
}): Promise<ContextMap> {
  const contexts = Object.create(null) as ContextMap;
  for (const [id, raw] of Object.entries(record(input.sceneContextMap))) {
    const value = record(raw);
    if (!value.outline || !value.content || typeof value.stageId !== 'string') continue;
    const context = { ...value } as unknown as SceneContext;
    delete context.teachingSources;
    context.teachingSourceDiagnostic = NO_SOURCE;
    contexts[id] = context;
  }
  if (!input.authorizedCourseId || !Object.keys(contexts).length) return contexts;
  const course = await getCourse(input.authorizedCourseId);
  if (!course || course.id !== input.authorizedCourseId) return contexts;
  const classrooms = (await Promise.all(classroomIds(course).filter(isValidClassroomId).map(readClassroom)))
    .filter((classroom): classroom is PersistedClassroomData => Boolean(classroom));
  const canonical = new Map(outlines(course).map((outline) => [outline.id, outline]));
  const job = await contentGenerationJobs.findFirst({ where: { courseId: course.id, status: 'completed' } });
  const witnesses = requestEvidence(record(job?.request));
  const hydrated = new Map<string, Promise<Sources>>();
  const ancestorClassrooms = new Map<string, Promise<PersistedClassroomData | null>>();
  const publishedByClassroom = new Map<string, PblTemplateDesign[]>();
  for (const [sceneId, context] of Object.entries(contexts)) {
    const owners = classrooms.filter((classroom) => classroomIds(course).includes(classroom.id)
      && classroom.stage.id === context.stageId && classroom.scenes.some((scene) => scene.id === sceneId && scene.stageId === context.stageId));
    const classroom = owners.length === 1 ? owners[0] : undefined;
    const scene = classroom?.scenes.find((candidate) => candidate.id === sceneId);
    const outline = scene ? canonical.get(scene.outlineId ?? scene.id) : undefined;
    if (!classroom || !scene || !outline || outline.id !== context.outline.id || scene.content.type !== context.content.type) {
      context.teachingSourceDiagnostic = '页面、课堂或已保存大纲身份不一致；请保存并刷新后重试。';
      continue;
    }
    context.outline = structuredClone(outline);
    context.allOutlines = classroom.scenes.flatMap((item) => {
      const page = canonical.get(item.outlineId ?? item.id);
      return page ? [structuredClone(page)] : [];
    });
    if (outline.type !== 'slide' || outline.generationPurpose !== 'knowledge-teaching') continue;
    const ancestor = classroom.teachingSource;
    let sourceClassroom = classroom;
    if (ancestor) {
      if (ancestor.courseId !== course.id || typeof ancestor.classroomId !== 'string' || !isValidClassroomId(ancestor.classroomId)) {
        context.teachingSourceDiagnostic = '已保存的教学来源课堂不属于当前课程或身份无效。';
        continue;
      }
      let pending = ancestorClassrooms.get(ancestor.classroomId);
      if (!pending) { pending = readClassroom(ancestor.classroomId); ancestorClassrooms.set(ancestor.classroomId, pending); }
      const originalClassroom = await pending;
      if (!originalClassroom || originalClassroom.id !== ancestor.classroomId) {
        context.teachingSourceDiagnostic = '原教学来源课堂已不可读取，无法证明当前副本的来源。';
        continue;
      }
      sourceClassroom = originalClassroom;
    }
    let selected = jobWitness(course, sourceClassroom, outline, job, witnesses, Boolean(ancestor));
    if (!selected) {
      let published = publishedByClassroom.get(sourceClassroom.id);
      if (!published) {
        const versions = await prisma.classroomTemplateVersion.findMany({ where: { templateId: course.id,
          status: { in: ['PUBLISHED', 'published', 'SUPERSEDED', 'superseded'] },
          OR: [
            { snapshot: { path: ['design', 'aiLearningClassroomId'], equals: sourceClassroom.id } },
            { snapshot: { path: ['design', 'content', '_openmaicClassroomId'], equals: sourceClassroom.id } },
            { snapshot: { path: ['design', 'teacherClassroomId'], equals: sourceClassroom.id } },
            { snapshot: { path: ['design', 'content', 'teacherClassroomId'], equals: sourceClassroom.id } },
          ] }, orderBy: { version: 'desc' }, select: { snapshot: true } });
        published = versions.map((version) => decodePblTemplate(version.snapshot)).filter((design): design is PblTemplateDesign => Boolean(design));
        publishedByClassroom.set(sourceClassroom.id, published);
      }
      selected = published.map((design) => immutableWitness(design, sourceClassroom, outline)).find(Boolean);
    }
    if (selected) {
      const key = JSON.stringify({ stageId: classroom.stage.id, items: selected.items, points: selected.points.map(adoption),
        selections: selected.evidence.selections, mappings: selected.evidence.mappings });
      let sourcePromise = hydrated.get(key);
      if (!sourcePromise) {
        sourcePromise = hydrateSources(selected, context.allOutlines);
        hydrated.set(key, sourcePromise);
      }
      const sources = await sourcePromise;
      // Retrieval headings without an original passage/sequence cannot become
      // authoritative definitions merely because their evidence IDs match.
      if (!selected.points.every((point) => pageOriginalTeachingSources({ ...outline, knowledgePointIds: [point.id] }, sources).originalSources.length)) continue;
      context.teachingSources = sources;
      delete context.teachingSourceDiagnostic;
    }
  }
  return contexts;
}

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course, KnowledgePoint, OpenMaicSceneOutlineSnapshot } from '@/lib/session/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { formatCourseEvidenceContext } from '@/lib/textbook/course-evidence-types';
import { createPblTemplateCourse, encodePblTemplate } from '@/lib/platform/pbl-template';
import type { CourseGenerationJob } from '@/lib/course-generation/job-storage';
import type { PersistedClassroomData } from '../../server/classroom-storage';
import type { SceneOutline } from '../../types/generation';
import type { SceneContext } from '../tools/regenerate-scene-actions';
import { teachingVisualEditFixture } from '../../edit/teaching-visual-edit-fixture';

const mocks = vi.hoisted(() => ({ course: vi.fn(), job: vi.fn(), classroom: vi.fn(), versions: vi.fn(), hydrate: vi.fn(), figures: vi.fn() }));
vi.mock('@/lib/session/server-store', () => ({ getCourse: mocks.course }));
vi.mock('@/lib/course-generation/job-storage', () => ({ contentGenerationJobs: { findFirst: mocks.job } }));
vi.mock('@/lib/db/client', () => ({ prisma: { classroomTemplateVersion: { findMany: mocks.versions } } }));
vi.mock('@/lib/textbook/course-evidence', () => ({ hydrateCourseEvidenceFigureReferences: mocks.hydrate, resolveCourseTextbookFigures: mocks.figures }));
vi.mock('../../server/classroom-storage', () => ({ readClassroom: mocks.classroom, isValidClassroomId: (id: string) => /^[\w-]+$/u.test(id) }));
import { hydrateAgentTeachingSourceContexts } from './teaching-source-context';

function fixture() {
  const fact = '支架并非最后一次性撤销，而是随着学习者发展逐个撤除。';
  const evidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'original-book', createdAt: '2026-10-02',
    retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }], warnings: [],
    mappings: [{ sourceKnowledgePointId: 'knowledge', sourceKnowledgePointName: '支架', evidenceItemIds: ['original'], status: 'direct', rationale: '' }],
    items: [{ id: 'original', kind: 'source-block', title: '支架撤除', content: fact,
      source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'book-v1', revisionVersion: 1, sectionPath: ['支架'], quote: fact },
      completeSourceBlocks: [{ sourceBlockId: 'intro', content: '支架式教学法以学生为中心。' }] }] };
  const outline: SceneOutline = { id: 'page', type: 'slide', title: '支架撤除', description: fact, keyPoints: [fact], order: 0,
    audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['knowledge'],
    teachingBrief: { schemaVersion: 1, explanation: fact, evidence: [{ sourceId: 'original', quote: fact }], examples: [], conditions: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: fact, learnerQuestion: '', reasoningSteps: [], takeaway: '', visibleContent: [fact],
        presentationContent: [fact], narrationFocus: [] } } };
  const course = createPblTemplateCourse('course');
  course.aiLearningClassroomId = 'classroom';
  course.content._openmaicSceneOutlines = [outline as unknown as OpenMaicSceneOutlineSnapshot];
  course.content.courseEvidence = evidence;
  course.content.knowledgePoints = [{ id: 'knowledge', evidenceItemIds: ['original'] } as KnowledgePoint];
  course.content.resourcePackage = { id: 'package', revision: 1, confirmedAt: '2026-10-02' } as Course['content']['resourcePackage'];
  const content = teachingVisualEditFixture();
  const context: SceneContext = { outline: structuredClone(outline), allOutlines: [structuredClone(outline)], stageId: 'classroom', content,
    actions: [{ id: 'speech', type: 'speech', text: '教师保留的真实讲解。', audioUrl: '/saved.wav' }] };
  const classroom = { id: 'classroom', stage: { id: 'classroom' }, scenes: [{ id: 'scene', outlineId: 'page', stageId: 'classroom', content }] } as PersistedClassroomData;
  const job = { id: 'paid-generation', courseId: 'course', status: 'completed', result: { id: 'classroom' }, request: {
    courseId: 'course', resourcePackageIdentity: { id: 'package', revision: 1 }, knowledgePoints: structuredClone(course.content.knowledgePoints),
    teachingSourceContext: formatCourseEvidenceContext(evidence),
  } } as unknown as CourseGenerationJob;
  mocks.course.mockResolvedValue(course); mocks.classroom.mockResolvedValue(classroom); mocks.job.mockResolvedValue(job);
  return { context, course, classroom, job, evidence, outline };
}
function forkFixture() {
  const input = fixture();
  const ancestor = structuredClone(input.classroom);
  const originalOutline = structuredClone(input.outline);
  const originalVersion = encodePblTemplate(structuredClone(input.course));
  const draftId = 'classroom-edit-draft';
  input.course.aiLearningClassroomId = draftId;
  input.classroom.id = draftId;
  input.classroom.stage.id = draftId;
  input.classroom.scenes[0]!.stageId = draftId;
  input.classroom.teachingSource = { courseId: 'course', classroomId: ancestor.id };
  input.context.stageId = draftId;
  (input.job.request as Record<string, unknown>).sceneOutlines = [originalOutline];
  mocks.classroom.mockImplementation(async (id: string) => id === input.classroom.id ? input.classroom : id === ancestor.id ? ancestor : null);
  return { ...input, ancestor, originalOutline, originalVersion };
}
const hydrate = (context: SceneContext) => hydrateAgentTeachingSourceContexts({ authorizedCourseId: 'course', sceneContextMap: { scene: context } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.versions.mockResolvedValue([]); mocks.figures.mockResolvedValue([]);
  mocks.hydrate.mockImplementation(async (items) => structuredClone(items));
});

describe('server-owned teaching source hydration', () => {
  it('restores complete adopted book passages and canonical scope without trusting client evidence or shortening original quotes', async () => {
    const { context, course, evidence, outline } = fixture();
    context.teachingSources = { sourceEvidence: { ...evidence, fingerprint: 'forged' } };
    context.teachingSourceDiagnostic = 'client says approved';
    context.outline.teachingBrief!.evidence = [{ sourceId: 'forged-book', quote: '虚构定义' }];
    context.allOutlines = [{ ...outline, id: 'foreign-page' }];
    delete course.content.courseEvidence!.items[0]!.completeSourceBlocks;
    const saved = structuredClone(context);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSourceDiagnostic).toBeUndefined();
    expect(result.teachingSources?.sourceEvidence?.fingerprint).toBe('original-book');
    expect(result.teachingSources?.sourceEvidence?.items[0]?.completeSourceBlocks?.[0]?.content).toBe('支架式教学法以学生为中心。');
    expect(result.outline.teachingBrief!.evidence).toEqual(outline.teachingBrief!.evidence);
    expect(result.allOutlines.map((item) => item.id)).toEqual(['page']);
    expect(result.content).toBe(context.content); expect(result.actions).toBe(context.actions);
    expect(context).toEqual(saved);
    expect(mocks.course).toHaveBeenCalledWith('course');
    expect(mocks.job).toHaveBeenCalledWith({ where: { courseId: 'course', status: 'completed' } });
    expect(mocks.hydrate).toHaveBeenCalledWith(expect.any(Array), { includeAncestorIntroductions: true });
  });

  it('strips supplied teaching sources in standalone mode while leaving old chat/read context intact', async () => {
    const { context, evidence } = fixture(); context.teachingSources = { sourceEvidence: evidence };
    const result = (await hydrateAgentTeachingSourceContexts({ sceneContextMap: { scene: context } })).scene!;
    expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
    expect(result.content).toBe(context.content); expect(result.outline).toBe(context.outline);
    expect(mocks.course).not.toHaveBeenCalled(); expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it.each(['stage', 'scene', 'outline', 'classroom'] as const)('rejects a mismatched %s identity before source hydration', async (field) => {
    const { context, classroom } = fixture();
    if (field === 'stage') context.stageId = 'foreign-stage';
    if (field === 'outline') context.outline.id = 'foreign-outline';
    if (field === 'scene') classroom.scenes[0]!.id = 'foreign-scene';
    if (field === 'classroom') classroom.id = 'foreign-classroom';
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toContain('身份不一致');
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it.each(['course', 'request-course', 'result', 'package', 'revision', 'adoption', 'body', 'short-label'] as const)
    ('does not adopt source records with a changed %s', async (field) => {
      const { context, course, job } = fixture();
      const request = job.request as Record<string, unknown>;
      if (field === 'course') job.courseId = 'foreign-course';
      if (field === 'request-course') request.courseId = 'foreign-course';
      if (field === 'result') job.result = { id: 'another-classroom' };
      if (field === 'package') course.content.resourcePackage!.revision = 2;
      if (field === 'revision') course.content.courseEvidence!.items[0]!.source.revisionId = 'book-v2';
      if (field === 'adoption') course.content.knowledgePoints[0]!.evidenceItemIds = [];
      if (field === 'body') course.content.courseEvidence!.items[0]!.content = '后来修改的另一段原文。';
      if (field === 'short-label') request.teachingSourceContext = 'original：逐步撤除';
      const result = (await hydrate(context)).scene!;
      expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
      expect(result.outline.teachingBrief?.evidence).toEqual(context.outline.teachingBrief?.evidence);
      expect(mocks.hydrate).not.toHaveBeenCalled();
    });

  it('uses a matching immutable course version when current evidence or a newer task no longer matches', async () => {
    const { context, course } = fixture();
    const published = encodePblTemplate(structuredClone(course));
    course.content.courseEvidence = undefined;
    mocks.job.mockResolvedValue(null); mocks.versions.mockResolvedValue([{ snapshot: published }]);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSourceDiagnostic).toBeUndefined();
    expect(result.teachingSources?.sourceEvidence?.items[0]?.source.revisionId).toBe('book-v1');
    expect(mocks.versions.mock.calls[0]![0].where).toMatchObject({ templateId: 'course',
      status: { in: ['PUBLISHED', 'published', 'SUPERSEDED', 'superseded'] } });
  });

  it.each(['classroom', 'page', 'quote'] as const)('does not use an immutable snapshot with another %s', async (field) => {
    const { context, course } = fixture();
    const published = encodePblTemplate(structuredClone(course));
    if (field === 'classroom') published.design.aiLearningClassroomId = 'foreign-classroom';
    if (field === 'page') published.design.content._openmaicSceneOutlines![0]!.id = 'foreign-page';
    if (field === 'quote') (published.design.content._openmaicSceneOutlines![0]! as unknown as SceneOutline).teachingBrief!.evidence = [];
    mocks.job.mockResolvedValue(null); mocks.versions.mockResolvedValue([{ snapshot: published }]);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it('keeps saved split-page ownership and rejects an unsaved client-only continuation', async () => {
    const { context, course, classroom, outline } = fixture();
    const split = { ...structuredClone(outline), id: 'page--continuation-2', sourcePageIds: ['page'],
      visualSourceCatalog: [{ id: 'adopted-content-1', text: outline.keyPoints[0]! }] };
    const sibling: SceneContext = { ...context, outline: split };
    let result = await hydrateAgentTeachingSourceContexts({ authorizedCourseId: 'course', sceneContextMap: { 'split-scene': sibling } });
    expect(result['split-scene']!.teachingSources).toBeUndefined();
    course.content._openmaicSceneOutlines!.push(split);
    classroom.scenes.push({ ...classroom.scenes[0]!, id: 'split-scene', outlineId: split.id });
    result = await hydrateAgentTeachingSourceContexts({ authorizedCourseId: 'course', sceneContextMap: { scene: context, 'split-scene': sibling } });
    expect(result['split-scene']!.teachingSourceDiagnostic).toBeUndefined();
    expect(result['split-scene']!.outline.visualSourceCatalog).toEqual(split.visualSourceCatalog);
    expect(result['split-scene']!.allOutlines.map((page) => page.id)).toEqual(['page', split.id]);
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade a source storage failure into a successful source check', async () => {
    const { context } = fixture(); mocks.hydrate.mockRejectedValue(new Error('source store unavailable'));
    await expect(hydrate(context)).rejects.toThrow('source store unavailable');
  });

  it('retains adopted textbook figure sequence obligations alongside the original prose', async () => {
    const { context } = fixture();
    const steps = [{ label: '提供支持', sourceBlockId: 'start' }, { label: '逐步撤除', sourceBlockId: 'finish' }];
    mocks.hydrate.mockImplementation(async (items) => items.map((item: CourseEvidenceSnapshot['items'][number]) => ({ ...item,
      figureSequences: [{ figureId: 'figure', kind: 'ordered-steps', steps }] })));
    mocks.figures.mockResolvedValue([{ id: 'textbook_fig_original', figureId: 'figure', required: true,
      knowledgePointIds: ['knowledge'], orderedSteps: steps }]);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSources?.sourceSequenceContracts).toContainEqual({ resourceId: 'textbook_fig_original',
      required: true, knowledgePointIds: ['knowledge'], orderedSteps: steps, scope: 'single-page', sequenceSemantics: 'ordered-steps' });
  });

  it('rehydrates a saved continuation after repeated authorized forks through its unchanged server ancestor', async () => {
    const { context, course, classroom, outline } = forkFixture();
    const continuation: SceneOutline = { ...structuredClone(outline), id: 'page--continuation-2', spatialParentId: 'page', sourcePageIds: ['page'],
      visualSourceCatalog: [{ id: 'adopted-content-1', text: outline.keyPoints[0]! }] };
    course.content._openmaicSceneOutlines!.push(continuation as unknown as OpenMaicSceneOutlineSnapshot);
    classroom.scenes.push({ ...classroom.scenes[0]!, id: 'split-scene', outlineId: continuation.id });
    for (const id of ['classroom-edit-draft', 'another-saved-draft']) {
      classroom.id = id; classroom.stage.id = id; course.aiLearningClassroomId = id;
      classroom.scenes.forEach((scene) => { scene.stageId = id; });
      const result = await hydrateAgentTeachingSourceContexts({ authorizedCourseId: 'course', sceneContextMap: {
        'split-scene': { ...context, stageId: id, outline: continuation },
      } });
      expect(result['split-scene']!.teachingSourceDiagnostic).toBeUndefined();
      expect(result['split-scene']!.teachingSources?.sourceEvidence?.items[0]?.source.revisionId).toBe('book-v1');
      expect(result['split-scene']!.outline.visualSourceCatalog).toEqual(continuation.visualSourceCatalog);
    }
    expect(mocks.classroom).toHaveBeenCalledWith('classroom');
  });

  it.each(['ancestor-course', 'missing-ancestor', 'missing-original-page', 'source-stage', 'job-course', 'parent', 'source-page', 'section', 'unit', 'source-text'] as const)
    ('rejects a fork whose %s does not prove its original source ownership', async (field) => {
      const { context, classroom, ancestor, job, outline } = forkFixture();
      if (field === 'ancestor-course') classroom.teachingSource!.courseId = 'foreign-course';
      if (field === 'missing-ancestor') classroom.teachingSource!.classroomId = 'missing';
      if (field === 'missing-original-page') ancestor.scenes = [];
      if (field === 'source-stage') ancestor.scenes[0]!.stageId = 'another-stage';
      if (field === 'job-course') job.courseId = 'foreign-course';
      if (field === 'parent') outline.spatialParentId = 'foreign-parent';
      if (field === 'source-page') outline.sourcePageIds = ['foreign-source'];
      if (field === 'section') outline.lectureSectionId = 'foreign-section';
      if (field === 'unit') outline.teachingUnitIds = ['foreign-unit'];
      if (field === 'source-text') outline.visualSourceCatalog = [{ id: 'adopted-content-1', text: '与原页无关的另一事实。' }];
      const result = (await hydrate(context)).scene!;
      expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
      expect(mocks.hydrate).not.toHaveBeenCalled();
      if (field === 'ancestor-course') expect(mocks.classroom).not.toHaveBeenCalledWith('classroom');
    });

  it('accepts an immutable same-course ancestor snapshot when the current task no longer witnesses the fork', async () => {
    const { context, originalVersion } = forkFixture();
    mocks.job.mockResolvedValue(null); mocks.versions.mockResolvedValue([{ snapshot: originalVersion }]);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSourceDiagnostic).toBeUndefined();
    expect(mocks.versions.mock.calls[0]![0].where).toMatchObject({ templateId: 'course', OR: expect.arrayContaining([
      { snapshot: { path: ['design', 'aiLearningClassroomId'], equals: 'classroom' } },
    ]) });
  });

  it('never infers an ancestor from a draft name or a client-supplied provenance field', async () => {
    const { context, classroom } = forkFixture();
    delete classroom.teachingSource;
    Object.assign(context, { teachingSource: { courseId: 'course', classroomId: 'classroom' } });
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
    expect(mocks.classroom).not.toHaveBeenCalledWith('classroom');
  });

  it('does not treat a witnessed retrieval label without an original passage as a textbook source', async () => {
    const { context, course, job } = fixture();
    const item = course.content.courseEvidence!.items[0]!;
    item.kind = 'concept'; item.content = '逐步撤除'; delete item.source.quote; delete item.completeSourceBlocks;
    (job.request as Record<string, unknown>).teachingSourceContext = formatCourseEvidenceContext(course.content.courseEvidence);
    const result = (await hydrate(context)).scene!;
    expect(result.teachingSources).toBeUndefined(); expect(result.teachingSourceDiagnostic).toBeTruthy();
    expect(result.outline.teachingBrief?.evidence).toEqual(context.outline.teachingBrief?.evidence);
  });
});

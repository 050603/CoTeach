// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { CourseContent, StudentAiProgress } from '@/lib/session/types';
import type { CourseEvidenceItem, CourseEvidenceSource } from '@/lib/textbook/course-evidence-types';
import type { Scene } from '@openmaic/lib/types/stage';

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), search: vi.fn(), records: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/observability/logger', () => ({ logger: { warn: mocks.warn } }));
vi.mock('@/lib/db/client', () => ({ prisma: {
  $queryRaw: mocks.query, textbookRetrievalItem: { findMany: mocks.records },
} }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  readClassroom: mocks.read,
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}));
vi.mock('@/lib/textbook/service', () => ({ searchTextbookEvidence: mocks.search }));
vi.mock('@/lib/platform/repository', () => ({ PlatformError: class extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
} }));

import { loadLectureChatContext, resolveLectureChatEvidence, type LectureChatContext } from './lecture-chat-context';
import { lectureChatSystemPrompt } from './lecture-chat-answer';

const source = (overrides: Partial<CourseEvidenceSource> = {}): CourseEvidenceSource => ({
  textbookId: 'book', textbookTitle: '科学教材', revisionId: 'primary-revision', revisionVersion: 1,
  sectionId: 'selected-section', sectionPath: ['第一章', '力与运动'], sourceBlockId: 'adopted-block', ...overrides,
});
const evidence = (overrides: Partial<CourseEvidenceItem> = {}): CourseEvidenceItem => ({
  id: 'adopted', kind: 'concept', title: '惯性', content: '整理后的描述不能冒充原文', source: source({ quote: '惯性是物体保持原有运动状态的性质。' }),
  completeSourceBlocks: [{ sourceBlockId: 'adopted-block', content: '惯性是物体保持原有运动状态的性质。', source: source() }],
  ...overrides,
});
function contentFixture(): Partial<CourseContent> {
  return {
    knowledgePoints: [{ id: 'inertia', name: '惯性', description: '描述惯性', evidenceItemIds: ['adopted'] }],
    textbookSelections: [{ revisionId: 'primary-revision', primary: true, sectionIds: ['selected-section'] }],
    courseEvidence: { schemaVersion: 2, version: 2, fingerprint: 'evidence-fingerprint', createdAt: '2026-10-15T00:00:00Z',
      retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [], items: [evidence()] },
  };
}
function lectureScene(overrides: Record<string, unknown> = {}): Scene {
  return {
    id: 'page', stageId: 'main-classroom', outlineId: 'page-outline', order: 0, type: 'slide', title: '惯性的含义',
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['inertia'], teachingUnitIds: ['unit'],
    content: { type: 'slide', canvas: { elements: [{ type: 'text', content: '<p>运动状态</p><p>保持不变</p>' }] } },
    actions: [{ id: 'speech-one', type: 'speech', text: '现在解释惯性的含义。' },
      { id: 'visual', type: 'laser' }, { id: 'speech-two', type: 'speech', text: '惯性与受力不是同一个概念。' }],
    ...overrides,
  } as unknown as Scene;
}
let row: Record<string, unknown>;
let content: Partial<CourseContent>;
let mainScenes: Scene[];
let extraScenes: Scene[];
let progress: StudentAiProgress;
const page = { classroomId: 'main-classroom', sceneId: 'page' };
const position = { actionIndex: 2, mediaTimeMs: 1_250 };

beforeEach(() => {
  vi.resetAllMocks();
  content = contentFixture();
  mainScenes = [lectureScene(), lectureScene({ id: 'quiz', outlineId: 'quiz-outline', type: 'quiz', content: { type: 'quiz', questions: [] } })];
  extraScenes = [lectureScene({ id: 'extra-page', stageId: 'branch-classroom' })];
  progress = { classroomId: 'main-classroom', studentId: 'student', currentSceneIndex: 0, totalScenes: 2,
    completedScenes: [], lastActiveAt: '2026-10-15T00:00:00Z', masteryLevel: 'in-progress' };
  row = { participationId: 'participation', offeringId: 'offering', templateVersionId: 'version', templateStatus: 'PUBLISHED',
    classroomStatus: 'TEACHING', enrollmentStatus: 'ACTIVE', offeringStatus: 'OPEN', archivedAt: null,
    userStatus: 'ACTIVE', userRole: 'STUDENT', sessionVersion: 4, progress };
  mocks.query.mockImplementation(async () => [{ ...row, snapshot: { schemaVersion: 2, kind: 'pbl-course',
    design: { name: '课程', stages: [], aiLearningClassroomId: 'main-classroom', content } } }]);
  mocks.read.mockImplementation(async (id: string) => ({ id, scenes: id === 'main-classroom' ? mainScenes : extraScenes }));
  mocks.search.mockResolvedValue({ hits: [], degraded: false, degradationReason: null });
  mocks.records.mockResolvedValue([]);
});

describe('lecture chat authored context and access', () => {
  it('loads the enrolled student only, and derives the current lecture from saved authored actions', async () => {
    const context = await loadLectureChatContext('course', 'student', page, position);
    expect(context).toMatchObject({ courseId: 'course', studentId: 'student', participationId: 'participation', templateVersionId: 'version',
      sessionVersion: 4, pageTitle: '惯性的含义', knowledgePointNames: ['惯性'], teachingUnitIds: ['unit'], position,
      currentSpeech: '惯性与受力不是同一个概念。', writable: true, blockedByQuiz: false, pageText: '运动状态\n保持不变' });
    expect(context.narration).toContain('现在解释惯性的含义。');
    expect(mocks.query.mock.calls[0].slice(1)).toEqual(['course', 'student']);
    const previousSpeech = await loadLectureChatContext('course', 'student', page, { actionIndex: 1 });
    expect(previousSpeech.currentSpeech).toBe('现在解释惯性的含义。');
  });

  it.each([
    ['userStatus', 'DISABLED'], ['userRole', 'TEACHER'], ['enrollmentStatus', 'WITHDRAWN'],
  ])('rejects an ineligible account or enrollment (%s)', async (key, value) => {
    row[key] = value;
    await expect(loadLectureChatContext('course', 'student', page, position)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('does not fall back to a foreign template or classroom when participation is absent', async () => {
    mocks.query.mockResolvedValue([]);
    await expect(loadLectureChatContext('foreign-course', 'student', page, position)).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND', status: 403 });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('reads closed/completed history but disallows writing, and never uses draft versions', async () => {
    row.classroomStatus = 'FINISHED'; row.enrollmentStatus = 'COMPLETED';
    expect(await loadLectureChatContext('course', 'student', page, position)).toMatchObject({ writable: false });
    row.templateStatus = 'DRAFT';
    await expect(loadLectureChatContext('course', 'student', page, position)).rejects.toMatchObject({ code: 'COURSE_VERSION_UNAVAILABLE', status: 409 });
  });

  it('rejects teacher pages, quiz pages and invalid classroom paths', async () => {
    mainScenes.push(lectureScene({ id: 'teacher-page', audience: 'teacher', generationPurpose: 'teacher-resource' }));
    await expect(loadLectureChatContext('course', 'student', { ...page, sceneId: 'teacher-page' }, position)).rejects.toMatchObject({ code: 'SCENE_NOT_FOUND' });
    await expect(loadLectureChatContext('course', 'student', { ...page, sceneId: 'quiz' }, position)).rejects.toMatchObject({ code: 'LECTURE_CHAT_UNAVAILABLE' });
    await expect(loadLectureChatContext('course', 'student', { ...page, classroomId: '../other-classroom' }, position)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('requires both a published prepared branch and the learner’s accepted path for supplementary pages', async () => {
    const extraPage = { classroomId: 'branch-classroom', sceneId: 'extra-page' };
    const plan: NonNullable<CourseContent['adaptiveLearningPlan']> = {
      enabled: true, status: 'teacher-confirmed', updatedAt: '2026-10-15T00:00:00Z', timeBudgetMin: 10,
      thresholds: { enrichmentMasteryMin: 80 },
      pretest: { title: '课前诊断', introduction: '', estimatedMinutes: 0, questions: [] },
      branches: [{ id: 'branch', enabled: true, status: 'teacher-confirmed', kind: 'extension', title: '补充讲解',
        objective: '解释概念', keyPoints: [], anchorKnowledgePointIds: ['inertia'], prerequisiteKnowledgePointIds: [],
        noveltyStatement: '补充一个例子', mainCourseOverlapSceneIds: [], sceneType: 'slide', targetDurationSec: 60,
        preparedResource: { status: 'ready', classroomId: 'branch-classroom' } }],
    };
    content.adaptiveLearningPlan = plan;
    await expect(loadLectureChatContext('course', 'student', extraPage, position)).rejects.toMatchObject({ code: 'FORBIDDEN_PAGE' });
    progress.adaptiveLearning = { evidence: [], branchRuns: [{ id: 'run', branchOutlineId: 'branch', kind: 'extension', status: 'ready',
      classroomId: 'branch-classroom', reason: '扩展', createdAt: '2026-10-15T00:00:00Z' }], microLessons: [] };
    expect(await loadLectureChatContext('course', 'student', extraPage, position)).toMatchObject({ classroomId: 'branch-classroom', sceneId: 'extra-page', writable: true });
    plan.branches[0].preparedResource!.classroomId = 'foreign-classroom';
    await expect(loadLectureChatContext('course', 'student', extraPage, position)).rejects.toMatchObject({ code: 'FORBIDDEN_PAGE' });
  });

  it('blocks a new lecture question while the current quiz is awaiting a trusted submission, without blocking history', async () => {
    progress.currentSceneIndex = 1;
    expect(await loadLectureChatContext('course', 'student', page, position)).toMatchObject({ blockedByQuiz: true, writable: false });
    progress.knowledgeLectureAttempts = [{ id: 'attempt', runtimeSceneId: 'quiz', quizOutlineId: 'quiz-outline', gradingSource: 'legacy-unverified' }] as StudentAiProgress['knowledgeLectureAttempts'];
    expect(await loadLectureChatContext('course', 'student', page, position)).toMatchObject({ blockedByQuiz: true });
    progress.knowledgeLectureAttempts![0].gradingSource = 'server';
    expect(await loadLectureChatContext('course', 'student', page, position)).toMatchObject({ blockedByQuiz: false, writable: true });
  });

  it('keeps adaptive pretest questions outside the lecture answer path', async () => {
    content.adaptiveLearningPlan = {
      enabled: true, status: 'teacher-confirmed', updatedAt: '2026-10-15T00:00:00Z', timeBudgetMin: 10,
      thresholds: { enrichmentMasteryMin: 80 }, branches: [],
      pretest: { title: '课前诊断', introduction: '确认先备知识', estimatedMinutes: 1,
        questions: [{ id: 'pretest-question', prompt: '力会影响运动状态吗？', options: ['会', '不会'], correctOptionIndex: 0, knowledgePointIds: ['inertia'] }] },
    };
    expect(await loadLectureChatContext('course', 'student', page, position)).toMatchObject({ blockedByQuiz: true, writable: false });
  });

  it('uses the caller transaction and fingerprints actual page changes as well as published version changes', async () => {
    const context = await loadLectureChatContext('course', 'student', page, position);
    const query = vi.fn().mockImplementation(mocks.query);
    const db = { $queryRaw: query } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
    mainScenes[0] = lectureScene({ title: '新版解释' }); row.templateVersionId = 'version-two';
    const latest = await loadLectureChatContext('course', 'student', page, position, db);
    expect(query).toHaveBeenCalledTimes(1);
    expect(latest.templateVersionId).toBe('version-two');
    expect(latest.sceneFingerprint).not.toBe(context.sceneFingerprint);
  });

  it.each([{ actionIndex: -1 }, { actionIndex: 2.1 }, { actionIndex: 1, mediaTimeMs: Number.NaN }])('rejects invalid positions %j', async badPosition => {
    await expect(loadLectureChatContext('course', 'student', page, badPosition)).rejects.toMatchObject({ code: 'INVALID_POSITION' });
  });
  it('rejects a cursor beyond the saved action list and permits the exhausted cursor', async () => {
    await expect(loadLectureChatContext('course', 'student', page, { actionIndex: 4 })).rejects.toMatchObject({ code: 'INVALID_POSITION', status: 409 });
    expect(await loadLectureChatContext('course', 'student', page, { actionIndex: 3 })).toMatchObject({ currentSpeech: '惯性与受力不是同一个概念。' });
  });
});

describe('lecture chat original textbook evidence', () => {
  const load = () => loadLectureChatContext('course', 'student', page, position);
  it('prefers the current page’s adopted raw blocks, deduplicates originals and keeps lecture position in the prompt', async () => {
    const context = await load();
    const result = await resolveLectureChatEvidence(context, '这是什么意思？');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ textbookTitle: '科学教材', sectionPath: ['第一章', '力与运动'], quote: '惯性是物体保持原有运动状态的性质。', sourceBlockId: 'adopted-block' });
    expect(result.prompt).toContain('adoptedForPage":true');
    const prompt = lectureChatSystemPrompt(context, result);
    expect(prompt).toContain('mediaTimeMs":1250');
    expect(prompt).toContain('惯性与受力不是同一个概念。');
    expect(result.prompt).not.toContain('整理后的描述不能冒充原文');
  });

  it('filters adopted originals outside the selected revision or section, and does not treat ungrounded author quotes as originals', async () => {
    content.courseEvidence!.items = [evidence({ source: source({ sectionId: 'other-section' }), completeSourceBlocks: [] }),
      evidence({ id: 'foreign', source: source({ revisionId: 'foreign-revision' }), completeSourceBlocks: [] })];
    content.knowledgePoints![0].evidenceItemIds = ['adopted', 'foreign'];
    const result = await resolveLectureChatEvidence(await load(), '什么是惯性');
    expect(result.citations).toEqual([]);
    expect(result.prompt).toContain('本次没有取得可引用的教材原文');
    expect(lectureChatSystemPrompt(await load(), result)).toContain('仍可运用你掌握的可靠通用知识清楚解答');
  });

  it('does not invent original evidence from a concept summary without a source quote', async () => {
    content.courseEvidence!.items = [evidence({ source: source(), completeSourceBlocks: [] })];
    const result = await resolveLectureChatEvidence(await load(), '什么是惯性');
    expect(result.citations).toEqual([]);
    expect(result.prompt).not.toContain('整理后的描述不能冒充原文');
  });

  it('does not inherit an adopted section for an expanded source block without its own location', async () => {
    content.courseEvidence!.items = [evidence({ completeSourceBlocks: [
      { sourceBlockId: 'parent-block', content: '另一个章节中的内容，未保存其原始位置。' },
    ] })];
    const result = await resolveLectureChatEvidence(await load(), '这是什么意思？');
    expect(result.citations.map(item => item.sourceBlockId)).toEqual(['adopted-block']);
    expect(result.prompt).not.toContain('另一个章节中的内容');
  });

  it('searches only bound revisions and sections and hydrates actual source blocks instead of hit summaries', async () => {
    content.courseEvidence!.items = [];
    content.textbookSelections!.push({ revisionId: 'secondary-revision', primary: false, sectionIds: ['secondary-section'] });
    mocks.search.mockImplementation(async ({ revisionIds }: { revisionIds: string[] }) => ({ degraded: false, hits: [
      { retrievalItemId: revisionIds[0], revisionId: revisionIds[0], sectionId: revisionIds[0] === 'primary-revision' ? 'selected-section' : 'secondary-section', content: '召回整理摘要' },
      { retrievalItemId: 'outside', revisionId: 'foreign-revision', sectionId: 'foreign-section' },
    ] }));
    mocks.records.mockResolvedValue(['secondary-revision', 'primary-revision'].map(revisionId => {
      const sectionId = revisionId === 'primary-revision' ? 'selected-section' : 'secondary-section';
      return { id: revisionId, revisionId, sectionId, revision: { revision: 1, textbookId: 'book', textbook: { title: `${revisionId}教材` } },
        sourceBlock: { id: `${revisionId}-block`, revisionId, sectionId, content: `${revisionId}真实原文`, section: { path: '第一章 / 惯性' } }, concept: null, example: null };
    }));
    const result = await resolveLectureChatEvidence(await load(), '什么是惯性');
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ revisionIds: ['primary-revision'], sectionIds: ['selected-section'] }));
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ revisionIds: ['secondary-revision'], sectionIds: ['secondary-section'] }));
    expect(mocks.records.mock.calls[0][0].where.id.in).toEqual(['primary-revision', 'secondary-revision']);
    expect(result.citations.map(item => item.revisionId)).toEqual(['primary-revision', 'secondary-revision']);
    expect(result.prompt).toContain('primary-revision真实原文');
    expect(result.prompt).not.toContain('召回整理摘要');
  });

  it('does not trust a hydrated record outside the scoped textbook range', async () => {
    content.courseEvidence!.items = [];
    mocks.search.mockResolvedValue({ degraded: false, hits: [{ retrievalItemId: 'hit', revisionId: 'primary-revision', sectionId: 'selected-section' }] });
    mocks.records.mockResolvedValue([{ id: 'hit', revisionId: 'foreign-revision', sectionId: 'foreign-section' }]);
    expect((await resolveLectureChatEvidence(await load(), '什么是惯性')).citations).toEqual([]);
  });

  it('continues after search failure with or without adopted originals while retaining a distinct diagnostic', async () => {
    mocks.search.mockRejectedValue(new Error('database unavailable'));
    expect(await resolveLectureChatEvidence(await load(), '什么是惯性')).toMatchObject({ degraded: true, citations: [expect.objectContaining({ sourceBlockId: 'adopted-block' })] });
    content.courseEvidence!.items = [];
    const result = await resolveLectureChatEvidence(await load(), '什么是劣构问题');
    expect(result).toMatchObject({ degraded: true, citations: [] });
    expect(result.prompt).toContain('本次查询发生故障');
    expect(result.prompt).not.toContain('教材暂未提供足够信息');
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'lecture-chat-textbook-retrieval-failed', phase: 'search', revisionId: 'primary-revision', errorName: 'Error',
    }), expect.any(String));
  });

  it('keeps adopted originals when loading searched source blocks fails and does not turn the failure into missing material', async () => {
    mocks.search.mockResolvedValue({ degraded: false, hits: [{ retrievalItemId: 'hit', revisionId: 'primary-revision', sectionId: 'selected-section' }] });
    mocks.records.mockRejectedValue(Object.assign(new Error('database unavailable'), { code: 'P1001' }));
    const result = await resolveLectureChatEvidence(await load(), '这是什么意思？');
    expect(result).toMatchObject({ degraded: true, citations: [expect.objectContaining({ sourceBlockId: 'adopted-block' })] });
    expect(result.prompt).toContain('本次查询发生故障');
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ phase: 'source-blocks', errorCode: 'P1001' }), expect.any(String));
  });

  it('retains a keyword-only answer without falsely reporting an infrastructure failure or missing textbook', async () => {
    mocks.search.mockResolvedValue({ degraded: true, degradationReason: '该教材尚无向量索引', hits: [] });
    const result = await resolveLectureChatEvidence(await load(), '什么是惯性');
    expect(result).toMatchObject({ degraded: true, citations: [expect.anything()] });
    expect(result.prompt).toContain('关键词检索');
    expect(result.prompt).not.toContain('查询发生故障');
  });

  it('provides no invented sources when no textbook is bound, allows model knowledge and never searches the library', async () => {
    content.textbookSelections = [];
    const result = await resolveLectureChatEvidence(await load(), '教材里怎么说');
    expect(result.citations).toEqual([]);
    expect(result.prompt).toContain('课程未绑定教材，未执行教材查询');
    expect(result.degraded).toBe(false);
    expect(lectureChatSystemPrompt(await load(), result)).toContain('仍可运用你掌握的可靠通用知识清楚解答');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('cancels pending retrieval promptly and never misreports cancellation as missing evidence', async () => {
    mocks.search.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = resolveLectureChatEvidence(await load(), '什么是惯性', controller.signal);
    controller.abort(new Error('student disconnected'));
    await expect(pending).rejects.toThrow('student disconnected');
  });

  it('preserves the whole source block even when a published search excerpt is shorter', async () => {
    const original = '惯性是物体保持原有运动状态的性质。这里继续说明适用条件。';
    content.courseEvidence!.items = [evidence({ source: source({ quote: '惯性是物体保持原有运动状态的性质。' }),
      completeSourceBlocks: [{ sourceBlockId: 'adopted-block', content: original, source: source() }] })];
    const result = await resolveLectureChatEvidence(await load(), '条件是什么');
    expect(result.citations[0].quote).toBe(original);
  });

  it('uses only page-related evidence instead of all knowledge point evidence in the course', async () => {
    content.courseEvidence!.items.push(evidence({ id: 'other-point', source: source({ sourceBlockId: 'other-block', quote: '未讲的内容' }), completeSourceBlocks: [] }));
    content.knowledgePoints!.push({ id: 'other', name: '其他知识', description: '', evidenceItemIds: ['other-point'] });
    const context: LectureChatContext = await load();
    const result = await resolveLectureChatEvidence(context, '这里是什么意思');
    expect(result.citations).toHaveLength(1);
    expect(result.prompt).not.toContain('未讲的内容');
  });
});

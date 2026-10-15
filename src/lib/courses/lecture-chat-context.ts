import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { decodePblTemplate } from '@/lib/platform/pbl-template';
import { PlatformError } from '@/lib/platform/repository';
import { logger } from '@/lib/observability/logger';
import type { CourseContent, StudentAiProgress } from '@/lib/session/types';
import { searchTextbookEvidence } from '@/lib/textbook/service';
import type { CourseEvidenceSource, CourseTextbookSelection } from '@/lib/textbook/course-evidence-types';
import { isValidClassroomId, readClassroom } from '@openmaic/lib/server/classroom-storage';
import { selectStudentLearningScenes } from '@openmaic/lib/pbl/scene-routing';
import type { Scene } from '@openmaic/lib/types/stage';
import { knowledgeTutorEvidence } from './knowledge-tutor-evidence';
import type { LectureChatCitation, LectureChatPage, LectureChatPosition } from './lecture-chat-types';

export type LectureChatContext = {
  courseId: string;
  studentId: string;
  participationId: string;
  offeringId: string;
  templateVersionId: string;
  sessionVersion: number;
  classroomId: string;
  sceneId: string;
  pageTitle: string;
  position: LectureChatPosition;
  sceneFingerprint: string;
  writable: boolean;
  blockedByQuiz: boolean;
  knowledgePointIds: string[];
  teachingUnitIds: string[];
  knowledgePointNames: string[];
  pageText: string;
  narration: string;
  currentSpeech: string;
  content: Partial<CourseContent>;
};

type ContextDb = Pick<Prisma.TransactionClient, '$queryRaw'>;
type ContextRow = {
  participationId: string;
  offeringId: string;
  templateVersionId: string;
  templateStatus: string;
  snapshot: unknown;
  classroomStatus: string;
  enrollmentStatus: string;
  offeringStatus: string;
  archivedAt: Date | null;
  userStatus: string;
  userRole: string;
  sessionVersion: number;
  progress: StudentAiProgress | null;
};

function pageText(scene: Scene): string {
  if (scene.content.type === 'interactive') return scene.title;
  if (scene.content.type !== 'slide') return '';
  const lines: string[] = [];
  const collect = (value: unknown, depth = 0) => {
    if (depth > 10 || value == null) return;
    if (Array.isArray(value)) { value.forEach(item => collect(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['content', 'text', 'latex'].includes(key) && typeof item === 'string') {
        const plain = item.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
          .replace(/<\s*br\s*\/?>|<\/(?:p|div|li|tr)>/gi, '\n').replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
        if (plain) lines.push(plain);
      } else if (item && typeof item === 'object') collect(item, depth + 1);
    }
  };
  collect(scene.content.canvas.elements);
  return [...new Set(lines)].join('\n');
}

/** The optional db keeps admission/finalization checks under the caller's course lock. */
export async function loadLectureChatContext(
  courseId: string,
  studentId: string,
  page: LectureChatPage,
  position: LectureChatPosition,
  db: ContextDb = prisma,
): Promise<LectureChatContext> {
  if (!courseId || !studentId || !isValidClassroomId(page.classroomId) || !page.sceneId.trim()) {
    throw new PlatformError('INVALID_REQUEST', '课堂或页面标识无效', 400);
  }
  if (!Number.isInteger(position.actionIndex) || position.actionIndex < 0
    || (position.mediaTimeMs !== undefined && (!Number.isFinite(position.mediaTimeMs) || position.mediaTimeMs < 0))) {
    throw new PlatformError('INVALID_POSITION', '讲解位置无效', 400);
  }
  const [row] = await db.$queryRaw<ContextRow[]>`
    SELECT p.id AS "participationId", e."offeringId", ci."templateVersionId", v.status AS "templateStatus", v.snapshot,
      ci.status AS "classroomStatus", e.status AS "enrollmentStatus", o.status AS "offeringStatus", a."archivedAt",
      u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
      w."projectState" -> 'aiLearningProgress' AS progress
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "User" u ON u.id = e."userId" JOIN "ClassroomInstance" ci ON ci.id = p."instanceId"
    JOIN "ClassroomTemplateVersion" v ON v.id = ci."templateVersionId"
    JOIN "Activity" a ON a.id = ci."activityId" JOIN "Chapter" c ON c.id = a."chapterId"
    JOIN "CourseOffering" o ON o.id = c."offeringId" AND o.id = e."offeringId"
    LEFT JOIN "StudentProjectWorkspace" w ON w."participationId" = p.id
    WHERE ci.id = ${courseId} AND e."userId" = ${studentId}`;
  if (!row) throw new PlatformError('STUDENT_NOT_FOUND', '未加入该课堂', 403);
  if (row.userStatus.toUpperCase() !== 'ACTIVE' || row.userRole.toUpperCase() !== 'STUDENT'
    || !['ACTIVE', 'COMPLETED'].includes(row.enrollmentStatus.toUpperCase())) {
    throw new PlatformError('FORBIDDEN', '账户或选课权限已变化', 403);
  }
  const design = decodePblTemplate(row.snapshot);
  if (!design || !['PUBLISHED', 'SUPERSEDED'].includes(row.templateStatus.toUpperCase())) {
    throw new PlatformError('COURSE_VERSION_UNAVAILABLE', '课堂发布版本不可用', 409);
  }
  const content: Partial<CourseContent> = design.content;
  const mainClassroomId = design.aiLearningClassroomId || content._openmaicClassroomId;
  if (!mainClassroomId || !isValidClassroomId(mainClassroomId)) {
    throw new PlatformError('CLASSROOM_NOT_FOUND', '课堂尚未准备好', 409);
  }
  const progress = row.progress?.classroomId === mainClassroomId ? row.progress : undefined;
  const adaptive = progress?.adaptiveLearning;
  const branch = page.classroomId !== mainClassroomId ? (content.adaptiveLearningPlan?.branches ?? []).find(item =>
    item.enabled !== false && item.status === 'teacher-confirmed'
    && item.preparedResource?.status === 'ready' && item.preparedResource.classroomId === page.classroomId
    && adaptive?.branchRuns.some(run => run.branchOutlineId === item.id && run.classroomId === page.classroomId
      && ['ready', 'completed'].includes(run.status))) : undefined;
  if (page.classroomId !== mainClassroomId && !branch) {
    throw new PlatformError('FORBIDDEN_PAGE', '该页面不属于当前学习路径', 403);
  }
  const main = await readClassroom(mainClassroomId);
  const classroom = page.classroomId === mainClassroomId ? main : await readClassroom(page.classroomId);
  if (!main || !classroom) throw new PlatformError('CLASSROOM_NOT_FOUND', '讲解页面暂不可用', 404);
  const scenes = selectStudentLearningScenes(classroom.scenes);
  const scene = scenes.find(item => item.id === page.sceneId);
  if (!scene) throw new PlatformError('SCENE_NOT_FOUND', '该页面不属于当前课堂', 404);
  if (!['slide', 'interactive'].includes(scene.type) || !['slide', 'interactive'].includes(scene.content.type)) {
    throw new PlatformError('LECTURE_CHAT_UNAVAILABLE', '小测请使用提交后的题目讲解与追问', 409);
  }
  const actions = scene.actions ?? [];
  if (position.actionIndex > actions.length) throw new PlatformError('INVALID_POSITION', '讲解位置已变化，请重新提问', 409);
  const mainScenes = selectStudentLearningScenes(main.scenes);
  const currentScene = progress ? mainScenes[progress.currentSceneIndex] : undefined;
  const submittedCurrentQuiz = currentScene && (progress?.knowledgeLectureAttempts ?? []).some(attempt =>
    attempt.gradingSource === 'server' && (attempt.runtimeSceneId === currentScene.id
      || attempt.quizOutlineId === (currentScene.outlineId || currentScene.id)));
  const plan = content.adaptiveLearningPlan;
  const awaitingPretest = plan?.enabled && plan.status === 'teacher-confirmed' && adaptive?.enabled !== false
    && plan.pretest.questions.length > 0 && !adaptive?.pretestCompletedAt;
  const blockedByQuiz = Boolean(awaitingPretest || (currentScene?.content.type === 'quiz' && !submittedCurrentQuiz));
  const outline = (content._openmaicSceneOutlines ?? []).find(item => item.id === (scene.outlineId || scene.id));
  const knowledgePointIds = [...new Set(scene.knowledgePointIds ?? outline?.knowledgePointIds ?? branch?.anchorKnowledgePointIds ?? [])];
  const teachingUnitIds = [...new Set(scene.teachingUnitIds ?? outline?.teachingUnitIds ?? [])];
  const speeches = actions.flatMap((action, index) => action.type === 'speech' ? [{ index, text: action.text }] : []);
  const currentSpeech = speeches.find(item => item.index === position.actionIndex)
    ?? [...speeches].reverse().find(item => item.index < position.actionIndex);
  return {
    courseId, studentId, participationId: row.participationId, offeringId: row.offeringId,
    templateVersionId: row.templateVersionId, sessionVersion: row.sessionVersion,
    classroomId: page.classroomId, sceneId: scene.id, pageTitle: scene.title,
    position: { ...position }, sceneFingerprint: createHash('sha256').update(JSON.stringify({
      templateVersionId: row.templateVersionId, classroomId: page.classroomId, scene,
    })).digest('hex'),
    writable: !blockedByQuiz && row.enrollmentStatus.toUpperCase() === 'ACTIVE'
      && row.classroomStatus.toUpperCase() === 'TEACHING' && row.offeringStatus.toUpperCase() === 'OPEN' && !row.archivedAt,
    blockedByQuiz, knowledgePointIds, teachingUnitIds,
    knowledgePointNames: (content.knowledgePoints ?? []).filter(point => knowledgePointIds.includes(point.id)).map(point => point.name),
    pageText: pageText(scene), narration: speeches.map(item => item.text).join('\n'),
    currentSpeech: currentSpeech?.text ?? '', content,
  };
}

function selectionsFor(content: Partial<CourseContent>): CourseTextbookSelection[] {
  return (content.textbookSelections ?? content.courseEvidence?.selections ?? [])
    .filter(item => Boolean(item.revisionId)).map(item => ({ ...item, sectionIds: [...new Set(item.sectionIds ?? [])] }))
    .sort((left, right) => Number(right.primary) - Number(left.primary));
}

function inScope(source: Pick<CourseEvidenceSource, 'revisionId' | 'sectionId'>, selections: CourseTextbookSelection[]): boolean {
  return selections.some(selection => selection.revisionId === source.revisionId
    && (!selection.sectionIds.length || (source.sectionId !== undefined && selection.sectionIds.includes(source.sectionId))));
}

function citation(source: Pick<CourseEvidenceSource, 'textbookTitle' | 'revisionId' | 'sectionPath' | 'sourceBlockId'>, quote: string): LectureChatCitation {
  return {
    id: `source-${createHash('sha256').update(JSON.stringify([source.revisionId, source.sourceBlockId ?? quote])).digest('hex').slice(0, 16)}`,
    textbookTitle: source.textbookTitle, revisionId: source.revisionId, sectionPath: source.sectionPath,
    quote, ...(source.sourceBlockId ? { sourceBlockId: source.sourceBlockId } : {}),
  };
}

async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('ABORTED'));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Only immutable adopted originals and scoped source-block reads become citations. */
export async function resolveLectureChatEvidence(
  context: LectureChatContext,
  message: string,
  signal?: AbortSignal,
): Promise<{ citations: LectureChatCitation[]; prompt: string; degraded: boolean }> {
  signal?.throwIfAborted();
  const selections = selectionsFor(context.content);
  const primaryRevisionId = selections.find(item => item.primary)?.revisionId;
  const adopted = knowledgeTutorEvidence(context.content, context.knowledgePointIds, context.teachingUnitIds);
  const candidates = new Map<string, LectureChatCitation>();
  const add = (source: CourseEvidenceSource, quote: string) => {
    if (!inScope(source, selections) || !quote.trim()) return;
    const item = citation(source, quote);
    if (!candidates.has(item.id)) candidates.set(item.id, item);
  };
  for (const item of adopted.items.sort((a, b) => Number(b.source.revisionId === primaryRevisionId) - Number(a.source.revisionId === primaryRevisionId))) {
    for (const block of item.completeSourceBlocks ?? []) {
      // Older expanded blocks omitted their own location. A different block's
      // section cannot safely be inferred when the teacher restricted sections.
      if (!block.source && block.sourceBlockId !== item.source.sourceBlockId
        && selections.some(selection => selection.revisionId === item.source.revisionId && selection.sectionIds.length)) continue;
      add(block.source ?? { ...item.source, sourceBlockId: block.sourceBlockId }, block.content);
    }
    if (item.source.quote) add(item.source, item.source.quote);
    else if (context.content.courseEvidence?.items.find(value => value.id === item.id)?.kind === 'source-block') add(item.source, item.content);
  }
  const adoptedIds = new Set(candidates.keys());
  const query = [message, context.pageTitle, ...context.knowledgePointNames, context.currentSpeech].filter(Boolean).join('\n').slice(0, 2_000);
  let degraded = false;
  let retrievalFailed = false;
  const recordFailure = (phase: 'search' | 'source-blocks', error: unknown, revisionId?: string) => {
    retrievalFailed = true; degraded = true;
    logger.warn({ event: 'lecture-chat-textbook-retrieval-failed', courseId: context.courseId,
      classroomId: context.classroomId, sceneId: context.sceneId, phase, revisionId,
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined },
    'Lecture chat continues with available evidence and model knowledge');
  };
  const results = await Promise.allSettled(selections.map(async selection => {
    const result = await cancellable(searchTextbookEvidence({
      revisionIds: [selection.revisionId], sectionIds: selection.sectionIds.length ? selection.sectionIds : undefined,
      query, limit: 6,
    }), signal);
    return { selection, result };
  }));
  signal?.throwIfAborted();
  const hits: Array<{ id: string; primary: boolean }> = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') { recordFailure('search', result.reason, selections[index].revisionId); continue; }
    degraded ||= result.value.result.degraded;
    for (const hit of result.value.result.hits) {
      if (inScope({ revisionId: hit.revisionId, sectionId: hit.sectionId ?? undefined }, [result.value.selection])) {
        hits.push({ id: hit.retrievalItemId, primary: result.value.selection.primary });
      }
    }
  }
  if (hits.length) {
    try {
      const records = await cancellable(prisma.textbookRetrievalItem.findMany({
        where: { id: { in: [...new Set(hits.map(item => item.id))] } },
        include: {
          revision: { include: { textbook: true } }, section: true, sourceBlock: { include: { section: true } },
          concept: { include: { evidence: { include: { sourceBlock: { include: { section: true } } } } } },
          example: { include: { sourceBlock: { include: { section: true } } } },
        },
      }), signal);
      const byId = new Map(records.map(record => [record.id, record]));
      for (const hit of hits.sort((left, right) => Number(right.primary) - Number(left.primary))) {
        const record = byId.get(hit.id);
        if (!record || !inScope({ revisionId: record.revisionId, sectionId: record.sectionId ?? undefined }, selections)) continue;
        const blocks = [record.sourceBlock, ...(record.concept?.evidence.map(item => item.sourceBlock) ?? []), record.example?.sourceBlock].filter(item => item != null);
        for (const block of blocks) {
          if (block.revisionId !== record.revisionId) continue;
          add({
            textbookId: record.revision.textbookId, textbookTitle: record.revision.textbook.title,
            revisionId: block.revisionId, revisionVersion: record.revision.revision,
            sectionId: block.sectionId, sectionPath: block.section.path.split(/\s*\/\s*/).filter(Boolean), sourceBlockId: block.id,
          }, block.content);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      recordFailure('source-blocks', error);
    }
  }
  const citations = [...candidates.values()].slice(0, 16);
  const prompt = [
    `主教材版本：${primaryRevisionId ?? '未绑定'}。`,
    `本课绑定的检索范围：${JSON.stringify(selections.map(item => ({ revisionId: item.revisionId, sectionIds: item.sectionIds, primary: item.primary })))}`,
    'adoptedForPage 表示本页实际采用的原文；其余为检索候选，相关性及是否支持具体论断需结合问题核对。',
    citations.length ? '本次可用的教材原文：' : '本次没有取得可引用的教材原文。',
    ...citations.map(item => JSON.stringify({ ...item, adoptedForPage: adoptedIds.has(item.id) })),
    retrievalFailed ? '检索状态：本次查询发生故障；以上已取得的原文仍可用，未取得的部分无法核实。'
      : degraded ? '检索状态：使用关键词检索，语义检索降级。'
        : selections.length ? '检索状态：课程绑定范围内的查询已完成。' : '检索状态：课程未绑定教材，未执行教材查询。',
  ].join('\n');
  return { citations, prompt, degraded };
}

import type { AssessmentMode, SceneOutline } from "@openmaic/lib/types/generation";
import { allocateLectureBudget } from "@/lib/classroom/knowledge-lecture-budget";
import { normalizeTeachingBrief } from "@/lib/openmaic/generation/teaching-brief";
import type {
  Course,
  KnowledgeGraph,
  KnowledgeLectureAttempt,
  KnowledgeLectureSection,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
  StudentAiProgress,
} from "@/lib/session/types";

type LectureOutline = SceneOutline & OpenMaicSceneOutlineSnapshot;

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function connectedKnowledgeGroups(
  knowledgePoints: readonly KnowledgePoint[],
  knowledgeGraph?: KnowledgeGraph,
): string[][] {
  const orderedIds = unique(knowledgePoints.map((point) => point.id));
  if (!orderedIds.length) return [];
  if (knowledgePoints.some((point) => point.groupId)) {
    const groups = new Map<string, string[]>();
    for (const point of knowledgePoints) {
      const key = point.groupId || point.id;
      groups.set(key, [...(groups.get(key) ?? []), point.id]);
    }
    return [...groups.values()];
  }
  const allowed = new Set(orderedIds);
  const neighbors = new Map(orderedIds.map((id) => [id, new Set<string>()]));
  for (const edge of knowledgeGraph?.edges ?? []) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  for (const point of knowledgePoints) {
    for (const relatedId of point.relatedIds ?? []) {
      if (!allowed.has(relatedId)) continue;
      neighbors.get(point.id)?.add(relatedId);
      neighbors.get(relatedId)?.add(point.id);
    }
  }

  const remaining = new Set(orderedIds);
  const groups: string[][] = [];
  while (remaining.size) {
    const seed = orderedIds.find((id) => remaining.has(id));
    if (!seed) break;
    const group = [seed];
    remaining.delete(seed);
    while (group.length < 3) {
      const next = orderedIds.find((id) =>
        remaining.has(id) && group.some((member) => neighbors.get(member)?.has(id)),
      );
      if (!next) break;
      group.push(next);
      remaining.delete(next);
    }
    groups.push(group);
  }
  return groups;
}

function sectionTitle(
  order: number,
  knowledgePointIds: readonly string[],
  pointNames: ReadonlyMap<string, string>,
): string {
  const names = knowledgePointIds.map((id) => pointNames.get(id)).filter(Boolean) as string[];
  return names.length
    ? `第 ${order + 1} 节 · ${names.join("与")}`
    : `第 ${order + 1} 节 · 核心知识`;
}

/**
 * Turns an AI-learning outline into a stable section sequence. Every section
 * ends in a section check with a 2–5 minute budget. Ordinary checks use
 * 2–4 lightweight questions; deep-response mode uses one synthesis response.
 */
export function organizeKnowledgeLectureOutlines(
  outlines: readonly LectureOutline[],
  input: {
    totalDurationSec: number;
    knowledgePoints: readonly KnowledgePoint[];
    knowledgeGraph?: KnowledgeGraph;
    assessmentMode?: AssessmentMode;
  },
): { outlines: LectureOutline[]; sections: KnowledgeLectureSection[] } {
  const teaching = outlines.filter((outline) => outline.type !== "quiz");
  if (!teaching.length) return { outlines: [...outlines], sections: [] };

  const pointNames = new Map(input.knowledgePoints.map((point) => [point.id, point.name]));
  const groups = connectedKnowledgeGroups(input.knowledgePoints, input.knowledgeGraph);
  const effectiveGroups = groups.length ? groups : [unique(teaching.flatMap((item) => item.knowledgePointIds ?? []))];
  const assigned = effectiveGroups.map(() => [] as LectureOutline[]);

  teaching.forEach((outline, outlineIndex) => {
    const ids = new Set(outline.knowledgePointIds ?? []);
    const overlaps = effectiveGroups.map((group) => group.filter((id) => ids.has(id)).length);
    const bestOverlap = Math.max(...overlaps);
    const balancedFallback = Math.min(
      effectiveGroups.length - 1,
      Math.floor((outlineIndex * effectiveGroups.length) / Math.max(1, teaching.length)),
    );
    const target = bestOverlap > 0 && ids.size < input.knowledgePoints.length
      ? overlaps.findIndex((value) => value === bestOverlap)
      : balancedFallback;
    assigned[Math.max(0, target)].push(outline);
  });

  const nonEmpty = assigned
    .map((scenes, index) => ({ scenes, knowledgePointIds: effectiveGroups[index] ?? [] }))
    .filter((entry) => entry.scenes.length > 0);
  // Keep semantic knowledge groups intact even when a concise group needs
  // only one teaching page. The quiz belongs immediately after that group;
  // only an actually impossible time budget may merge adjacent sections.
  const totalSeconds = Math.round(input.totalDurationSec);
  // Never add quiz time on top of the approved lecture budget. If necessary,
  // combine adjacent sections, preserving every teaching page and knowledge ID.
  while (nonEmpty.length > 1 && totalSeconds < nonEmpty.length * 120 + teaching.length * 45) {
    const last = nonEmpty.pop()!;
    const previous = nonEmpty.at(-1)!;
    previous.scenes.push(...last.scenes);
    previous.knowledgePointIds = unique([...previous.knowledgePointIds, ...last.knowledgePointIds]);
  }
  const preferredQuizDurations = nonEmpty.map((entry) => (entry.knowledgePointIds.length >= 3 ? 240 : 180));
  const quizDurations = allocateLectureBudget(
    Math.min(preferredQuizDurations.reduce((sum, value) => sum + value, 0), totalSeconds - teaching.length * 45),
    preferredQuizDurations,
    120,
  );
  const quizBudgetSec = quizDurations.reduce((sum, value) => sum + value, 0);
  const teachingDurations = allocateLectureBudget(
    totalSeconds - quizBudgetSec,
    nonEmpty.flatMap((entry) => entry.scenes.map((outline) => outline.targetDurationSec ?? outline.estimatedDuration ?? 60)),
    45,
  );
  let teachingIndex = 0;

  const result: LectureOutline[] = [];
  const sections: KnowledgeLectureSection[] = [];
  nonEmpty.forEach((entry, sectionIndex) => {
    const sectionId = `knowledge-section-${sectionIndex + 1}`;
    const knowledgePointIds = unique([
      ...entry.knowledgePointIds,
      ...entry.scenes.flatMap((scene) => scene.knowledgePointIds ?? []),
    ]).filter((id) => pointNames.has(id));
    const sourceGroupNames = unique(input.knowledgePoints.filter((point) => knowledgePointIds.includes(point.id)).map((point) => point.groupName ?? ""));
    const title = sourceGroupNames.length ? `第 ${sectionIndex + 1} 节 · ${sourceGroupNames.join("与")}` : sectionTitle(sectionIndex, knowledgePointIds, pointNames);
    const sectionScenes = entry.scenes.map((outline) => {
      const targetDurationSec = teachingDurations[teachingIndex++]!;
      return {
        ...outline,
        lectureSectionId: sectionId,
        lectureSectionTitle: title,
        activityId: sectionId,
        parentActivityId: sectionId,
        targetDurationSec,
        estimatedDuration: targetDurationSec,
      } as LectureOutline;
    });
    const constructedResponse = input.assessmentMode === "constructed-response";
    const questionCount = constructedResponse
      ? 1
      : Math.max(2, Math.min(4, knowledgePointIds.length >= 3 ? 3 : 2));
    const quizDurationSec = quizDurations[sectionIndex] ?? 180;
    const quizOutlineId = `${sectionId}-check`;
    const keyPoints = knowledgePointIds.map((id) => pointNames.get(id)).filter(Boolean) as string[];
    const anchor = sectionScenes.at(-1)!;
    const briefs = sectionScenes.map(normalizeTeachingBrief);
    const quiz: LectureOutline = {
      ...anchor,
      visualPlan: undefined,
      teachingBrief: {
        schemaVersion: 1,
        explanation: briefs.map((brief) => brief.explanation).join("\n"),
        examples: unique(briefs.flatMap((brief) => brief.examples)),
        conditions: unique(briefs.flatMap((brief) => brief.conditions)),
        evidence: [...new Map(briefs.flatMap((brief) => brief.evidence).map((item) => [`${item.sourceId}:${item.quote}`, item])).values()],
        assessmentFocus: unique(briefs.map((brief) => brief.assessmentFocus)).join("；"),
      },
      id: quizOutlineId,
      type: "quiz",
      title: `${title} · 节末小测`,
      description: constructedResponse
        ? `围绕本小节的${keyPoints.join("、") || "核心知识"}设置 1 道综合简答题，要求给出结论与理由，预计 ${Math.round(quizDurationSec / 60)} 分钟完成；由 AI 自动批阅并进入助教讲解。`
        : `围绕本小节的${keyPoints.join("、") || "核心知识"}设置 ${questionCount} 道单选、多选、判断、填空或必要的配对题。全部题目合计覆盖本小节所有知识点，选择与判断直接作答，填空只填写关键词、数值或短语，预计 ${Math.round(quizDurationSec / 60)} 分钟完成。`,
      keyPoints,
      teachingObjective: constructedResponse
        ? "用综合简答检查学生能否整合本小节知识给出结论与理由，并为逐题讲解形成证据。"
        : "用轻量题检查学生能否识别、判断或补全本小节核心知识，并为逐题讲解形成证据。",
      knowledgePointIds,
      lectureSectionId: sectionId,
      lectureSectionTitle: title,
      activityId: sectionId,
      parentActivityId: sectionId,
      detailKind: "other",
      targetDurationSec: quizDurationSec,
      estimatedDuration: quizDurationSec,
      ttsPolicy: "target-duration",
      narrationMode: "embedded-segment",
      resourceTypes: [],
      quizConfig: {
        difficulty: "medium",
        questionTypes: constructedResponse
          ? ["short_answer"]
          : ["single", "multiple", "true_false", "fill_blank", "matching"],
        questionCount,
        coveragePolicy: "section-synthesis",
        minShortAnswerQuestions: constructedResponse ? 1 : 0,
        maxShortAnswerQuestions: constructedResponse ? 1 : 0,
      },
      widgetType: undefined,
      widgetOutline: undefined,
      interactiveConfig: undefined,
      mediaGenerations: undefined,
      suggestedImageIds: undefined,
    };
    const sceneOutlineIds = sectionScenes.map((scene) => scene.id);
    result.push(...sectionScenes, quiz);
    sections.push({
      id: sectionId,
      title,
      order: sectionIndex,
      knowledgePointIds,
      sceneOutlineIds,
      quizOutlineId,
      estimatedMinutes: Math.max(
        2,
        Math.round((sectionScenes.reduce((sum, scene) => sum + (scene.targetDurationSec ?? 0), 0) + quizDurationSec) / 60),
      ),
    });
  });

  return {
    outlines: result.map((outline, index) => ({ ...outline, order: index })),
    sections,
  };
}

export function deriveKnowledgeLectureSectionsFromOutlines(
  outlines: readonly OpenMaicSceneOutlineSnapshot[],
): KnowledgeLectureSection[] {
  const grouped = new Map<string, OpenMaicSceneOutlineSnapshot[]>();
  for (const outline of outlines) {
    const sectionId = typeof outline.lectureSectionId === "string"
      ? outline.lectureSectionId
      : undefined;
    if (!sectionId) continue;
    grouped.set(sectionId, [...(grouped.get(sectionId) ?? []), outline]);
  }
  return [...grouped.entries()].flatMap(([id, scenes], order) => {
    const quiz = scenes.find((scene) => scene.type === "quiz");
    if (!quiz) return [];
    const title = typeof scenes[0]?.lectureSectionTitle === "string"
      ? scenes[0].lectureSectionTitle
      : `第 ${order + 1} 节`;
    return [{
      id,
      title,
      order,
      knowledgePointIds: unique(scenes.flatMap((scene) => scene.knowledgePointIds ?? [])),
      sceneOutlineIds: scenes.filter((scene) => scene.type !== "quiz").map((scene) => scene.id),
      quizOutlineId: quiz.id,
      estimatedMinutes: Math.max(2, Math.round(scenes.reduce(
        (sum, scene) => sum + Math.max(0, scene.targetDurationSec ?? scene.estimatedDuration ?? 0),
        0,
      ) / 60)),
    }];
  });
}

export type KnowledgePointMasteryRow = {
  knowledgePointId: string;
  name: string;
  answeredStudents: number;
  responseCount: number;
  incorrectStudents: number;
  earned: number;
  maxScore: number;
  unmetRate: number;
  scoreLossRate: number;
  responseCoverage: number;
  minimumSampleSize: number;
  status: "collecting" | "observing" | "confirmed" | "clear";
  misconceptionGroups: Array<{
    code: "unanswered" | "concept" | "interpretation" | "method" | "calculation" | "evidence" | "other";
    label: string;
    studentCount: number;
    examples: string[];
  }>;
};

/**
 * Section quizzes allow one submission only. Historical snapshots can still
 * contain duplicates from the former retry flow, so readers keep the earliest
 * valid submission for each quiz outline.
 */
export function firstKnowledgeLectureAttempts(
  progress?: StudentAiProgress,
): KnowledgeLectureAttempt[] {
  const first = new Map<string, KnowledgeLectureAttempt>();
  for (const attempt of progress?.knowledgeLectureAttempts ?? []) {
    const current = first.get(attempt.quizOutlineId);
    if (!current || Date.parse(attempt.submittedAt) < Date.parse(current.submittedAt)) {
      first.set(attempt.quizOutlineId, attempt);
    }
  }
  return [...first.values()];
}

export function knowledgeLectureQuizEstimate(
  course: Pick<Course, "content" | "aiLearningProgress">,
  section: KnowledgeLectureSection,
): { questionCount: number; estimatedMinutes: number } {
  const outline = course.content._openmaicSceneOutlines?.find(
    (item) => item.id === section.quizOutlineId,
  );
  const quizConfig = outline?.quizConfig && typeof outline.quizConfig === "object"
    ? outline.quizConfig as Record<string, unknown>
    : undefined;
  const configuredCount = Number(quizConfig?.questionCount);
  const attemptCounts = Object.values(course.aiLearningProgress ?? {}).flatMap((entry) =>
    firstKnowledgeLectureAttempts(entry)
      .filter((attempt) => attempt.sectionId === section.id)
      .map((attempt) => attempt.questions.length),
  );
  const questionCount = Number.isSafeInteger(configuredCount) && configuredCount > 0
    ? configuredCount
    : attemptCounts[0] ?? (section.knowledgePointIds.length >= 3 ? 3 : 2);
  const durationSeconds = Number(outline?.targetDurationSec ?? outline?.estimatedDuration);
  const estimatedMinutes = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(1, Math.round(durationSeconds / 60))
    : Math.max(2, Math.min(5, questionCount + 1));
  return { questionCount, estimatedMinutes };
}

export function aggregateKnowledgePointMastery(
  course: Pick<Course, "content" | "aiLearningProgress" | "students">,
  progressOverride?: Record<string, StudentAiProgress>,
): KnowledgePointMasteryRow[] {
  const progress = progressOverride ?? course.aiLearningProgress ?? {};
  const totalStudents = course.students.length;
  const minimumSampleSize = totalStudents > 0
    ? Math.min(totalStudents, Math.max(3, Math.ceil(totalStudents * 0.4)))
    : 0;
  const accumulators = new Map(course.content.knowledgePoints.map((point) => [point.id, {
    knowledgePointId: point.id,
    name: point.name,
    studentIds: new Set<string>(),
    incorrectStudentIds: new Set<string>(),
    responseCount: 0,
    earned: 0,
    maxScore: 0,
    misconceptionGroups: new Map<string, { code: KnowledgePointMasteryRow["misconceptionGroups"][number]["code"]; label: string; studentIds: Set<string>; examples: Set<string> }>(),
  }]));

  for (const [studentId, entry] of Object.entries(progress)) {
    for (const attempt of firstKnowledgeLectureAttempts(entry)) {
      for (const question of attempt.questions) {
        const ids = question.knowledgePointIds.length
          ? question.knowledgePointIds
          : attempt.knowledgePointIds;
        for (const knowledgePointId of unique(ids)) {
          const accumulator = accumulators.get(knowledgePointId);
          if (!accumulator) continue;
          accumulator.studentIds.add(studentId);
          accumulator.responseCount += 1;
          accumulator.earned += question.earned;
          accumulator.maxScore += question.points;
          if (question.points <= 0 || question.earned / question.points < 0.8) {
            accumulator.incorrectStudentIds.add(studentId);
            const misconception = classifyMisconception(question.answer, question.feedback);
            const group = accumulator.misconceptionGroups.get(misconception.code) ?? {
              ...misconception,
              studentIds: new Set<string>(),
              examples: new Set<string>(),
            };
            group.studentIds.add(studentId);
            if (question.feedback.trim()) group.examples.add(question.feedback.trim());
            accumulator.misconceptionGroups.set(misconception.code, group);
          }
        }
      }
    }
  }

  return [...accumulators.values()]
    .map((item) => {
      const answeredStudents = item.studentIds.size;
      const incorrectStudents = item.incorrectStudentIds.size;
      const unmetRate = answeredStudents > 0 ? Math.round(incorrectStudents / answeredStudents * 100) : 0;
      const enoughEvidence = answeredStudents >= minimumSampleSize;
      const candidate = incorrectStudents >= 2 && unmetRate >= 30;
      return {
        knowledgePointId: item.knowledgePointId,
        name: item.name,
        answeredStudents,
        responseCount: item.responseCount,
        incorrectStudents,
        earned: item.earned,
        maxScore: item.maxScore,
        unmetRate,
        scoreLossRate: item.maxScore > 0
          ? Math.round((1 - item.earned / item.maxScore) * 100)
          : 0,
        responseCoverage: totalStudents > 0 ? Math.round(answeredStudents / totalStudents * 100) : 0,
        minimumSampleSize,
        status: candidate ? (enoughEvidence ? "confirmed" as const : "observing" as const) : enoughEvidence ? "clear" as const : "collecting" as const,
        misconceptionGroups: [...item.misconceptionGroups.values()]
          .map((group) => ({ code: group.code, label: group.label, studentCount: group.studentIds.size, examples: [...group.examples].slice(0, 2) }))
          .sort((left, right) => right.studentCount - left.studentCount),
      };
    })
    .sort((a, b) => b.unmetRate - a.unmetRate || b.scoreLossRate - a.scoreLossRate || b.answeredStudents - a.answeredStudents);
}

function classifyMisconception(answer: string, feedback: string): {
  code: KnowledgePointMasteryRow["misconceptionGroups"][number]["code"];
  label: string;
} {
  if (!answer.trim()) return { code: "unanswered", label: "未作答" };
  const evidence = feedback.toLowerCase();
  if (/(概念|定义|混淆|含义|理解)/.test(evidence)) return { code: "concept", label: "概念理解错误" };
  if (/(题意|审题|条件|关键词|答非所问)/.test(evidence)) return { code: "interpretation", label: "题意或条件识别错误" };
  if (/(计算|运算|数值|单位)/.test(evidence)) return { code: "calculation", label: "计算或操作错误" };
  if (/(证据|理由|依据|说明为什么)/.test(evidence)) return { code: "evidence", label: "证据或理由不足" };
  if (/(步骤|方法|过程|推理|关系|方向)/.test(evidence)) return { code: "method", label: "方法或步骤缺失" };
  return { code: "other", label: "其他理解偏差" };
}

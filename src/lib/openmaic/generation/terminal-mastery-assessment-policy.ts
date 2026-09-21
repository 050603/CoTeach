import type { AssessmentMode, SceneOutline } from "@openmaic/lib/types/generation";

function isStudentKnowledgeScene(outline: SceneOutline): boolean {
  return (
    outline.stageKey === "ai-learning" && outline.audience === "student"
  ) || (!outline.stageKey && !outline.audience);
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSectionQuiz(
  anchor: SceneOutline,
  quiz: SceneOutline | undefined,
  knowledgePointIds: string[],
  sectionIndex: number,
  assessmentMode: AssessmentMode,
): SceneOutline {
  const constructedResponse = assessmentMode === "constructed-response";
  const questionCount = constructedResponse
    ? 1
    : Math.max(2, Math.min(4, knowledgePointIds.length >= 3 ? 3 : 2));
  const plannedSeconds = quiz?.targetDurationSec ?? quiz?.estimatedDuration;
  const targetDurationSec = typeof plannedSeconds === "number" && Number.isFinite(plannedSeconds)
    ? Math.max(120, Math.min(300, Math.round(plannedSeconds)))
    : questionCount === 3 ? 240 : 180;
  return {
    ...(quiz ?? anchor),
    id: quiz?.id || `section-${sectionIndex + 1}-check-${anchor.id || "knowledge"}`,
    type: "quiz",
    title: `第 ${sectionIndex + 1} 节 · 节末小测`,
    description: constructedResponse
      ? `围绕本小节设置 1 道综合简答题，要求学生给出结论与理由，预计 ${Math.round(targetDurationSec / 60)} 分钟完成。`
      : `围绕本小节设置 ${questionCount} 道单选、多选、判断、填空或必要的配对题，全部题目合计覆盖本小节所有知识点，预计 ${Math.round(targetDurationSec / 60)} 分钟完成。`,
    keyPoints: unique([...(quiz?.keyPoints ?? []), ...(anchor.keyPoints ?? [])]),
    teachingObjective: "形成小节级知识点理解证据，并在提交后进入 AI 助教逐题讲解。",
    detailKind: "other",
    knowledgePointIds,
    targetDurationSec,
    estimatedDuration: targetDurationSec,
    ttsPolicy: "target-duration",
    quizConfig: {
      difficulty: quiz?.quizConfig?.difficulty ?? "medium",
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
    // A generated quiz may inherit from the preceding teaching page when the
    // model omitted an assessment. Page-level teaching tools belong to that
    // source page and cannot be fulfilled by quiz action generation.
    teachingToolPlan: undefined,
  };
}

/**
 * Keeps generated knowledge sections intact and guarantees that each section
 * ends with the selected assessment mode. Older outlines with no section
 * markers remain one section for backward compatibility.
 */
export function ensureTerminalMasteryAssessment(
  outlines: readonly SceneOutline[],
  assessmentMode: AssessmentMode = "adaptive",
): SceneOutline[] {
  const studentKnowledge = outlines.filter(isStudentKnowledgeScene);
  if (studentKnowledge.length === 0) return [...outlines];

  const generatedSections: Array<{ teaching: SceneOutline[]; quiz?: SceneOutline }> = [];
  let teaching: SceneOutline[] = [];
  for (const outline of studentKnowledge) {
    if (outline.type === "quiz") {
      if (teaching.length) {
        generatedSections.push({ teaching, quiz: outline });
        teaching = [];
      }
      continue;
    }
    teaching.push(outline);
  }
  if (teaching.length) generatedSections.push({ teaching });
  if (!generatedSections.length) return [...outlines];

  const normalizedStudent = generatedSections.flatMap((section, sectionIndex) => {
    const knowledgePointIds = unique(section.teaching.flatMap((outline) => outline.knowledgePointIds ?? []));
    if (!knowledgePointIds.length) return section.teaching;
    const anchor = section.teaching.at(-1)!;
    return [
      ...section.teaching,
      normalizeSectionQuiz(anchor, section.quiz, knowledgePointIds, sectionIndex, assessmentMode),
    ];
  });

  let inserted = false;
  const result: SceneOutline[] = [];
  for (const outline of outlines) {
    if (isStudentKnowledgeScene(outline)) {
      if (!inserted) {
        result.push(...normalizedStudent);
        inserted = true;
      }
      continue;
    }
    result.push(outline);
  }
  return result.map((outline, index) => ({ ...outline, order: index }));
}

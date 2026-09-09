import type { SceneOutline } from "@openmaic/lib/types/generation";

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
): SceneOutline {
  const questionCount = knowledgePointIds.length >= 3 ? 3 : 2;
  const plannedSeconds = quiz?.targetDurationSec ?? quiz?.estimatedDuration;
  const targetDurationSec = typeof plannedSeconds === "number" && Number.isFinite(plannedSeconds)
    ? Math.max(120, Math.min(300, Math.round(plannedSeconds)))
    : questionCount === 3 ? 240 : 180;
  return {
    ...(quiz ?? anchor),
    id: quiz?.id || `section-${sectionIndex + 1}-check-${anchor.id || "knowledge"}`,
    type: "quiz",
    title: `第 ${sectionIndex + 1} 节 · 节末小测`,
    description: `围绕本小节设置 ${questionCount} 道简短主观题。学生只需用关键词和一两句话作答，预计 ${Math.round(targetDurationSec / 60)} 分钟完成；每题必须标注对应知识点并提供 AI 评分要点。`,
    keyPoints: unique([...(quiz?.keyPoints ?? []), ...(anchor.keyPoints ?? [])]),
    teachingObjective: "形成小节级知识点理解证据，并在提交后进入 AI 助教逐题讲解。",
    detailKind: "other",
    knowledgePointIds,
    targetDurationSec,
    estimatedDuration: targetDurationSec,
    ttsPolicy: "target-duration",
    quizConfig: {
      difficulty: quiz?.quizConfig?.difficulty ?? "medium",
      questionTypes: ["short_answer"],
      questionCount,
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
 * ends with a short subjective check. Older outlines with no section markers
 * remain one section for backward compatibility.
 */
export function ensureTerminalMasteryAssessment(
  outlines: readonly SceneOutline[],
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
      normalizeSectionQuiz(anchor, section.quiz, knowledgePointIds, sectionIndex),
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

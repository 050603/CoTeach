import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline, UserRequirements } from '@openmaic/lib/types/generation';
import { normalizeQuizQuestions } from '@openmaic/lib/quiz/quality';

export interface CourseQualityReport {
  status?: 'not-checked' | 'completed';
  ok: boolean;
  corrections: string[];
  warnings: string[];
  baselineVersion?: string;
  generationMethod?: 'classic-one-click';
  generationModelString?: string;
  referenceProfileVersion?: string;
  teachingEnhancementVersion?: string;
  narrationEnhancementVersion?: string;
  reviewPolicyVersion?: string;
  reviewMode?: 'local-technical';
  disposition?: 'ready' | 'needs-review' | 'audit-unavailable';
  visualConsistency?: {
    expectedBackground?: string;
    slideCount: number;
    matchingBackgroundCount: number;
    distinctBackgrounds: string[];
    passed: boolean;
    deepBlueTitleCount?: number;
    subtitleCount?: number;
    semanticStructurePageCount?: number;
    semanticStructureRequiredCount?: number;
    paletteDeviationCount?: number;
    repeatedLayoutPageCount?: number;
    averageVisibleTextCharacters?: number;
    averageElementCount?: number;
    averageSemanticElementCount?: number;
    referenceProfileVersion?: string;
  };
  layoutAudit?: {
    status: 'completed' | 'partial' | 'unavailable';
    pages: Array<{
      outlineId: string;
      title: string;
      status: 'checked' | 'unavailable' | 'checkpoint-not-rechecked';
      initialIssues: string[];
      finalIssues: string[];
      repairAttempted: boolean;
      adopted: 'first-draft' | 'repair' | 'checkpoint';
      initialKnowledgeCoverage?: number;
      finalKnowledgeCoverage?: number;
      initialDensityIssues?: string[];
      finalDensityIssues?: string[];
      initialVisibleTextCharacters?: number;
      finalVisibleTextCharacters?: number;
      initialVerticalSpan?: number;
      finalVerticalSpan?: number;
      initialContentAreaUtilization?: number;
      finalContentAreaUtilization?: number;
      initialMaxBlankBand?: number;
      finalMaxBlankBand?: number;
      initialHasDeepBlueTitle?: boolean;
      finalHasDeepBlueTitle?: boolean;
      initialHasSubtitle?: boolean;
      finalHasSubtitle?: boolean;
      semanticStructureRequired?: boolean;
      initialSemanticStructures?: string[];
      finalSemanticStructures?: string[];
      initialSemanticStructureSatisfied?: boolean;
      finalSemanticStructureSatisfied?: boolean;
      initialPaletteDeviationCount?: number;
      finalPaletteDeviationCount?: number;
      initialElementCount?: number;
      finalElementCount?: number;
      initialSemanticElementCount?: number;
      finalSemanticElementCount?: number;
      initialQualityScore?: number;
      finalQualityScore?: number;
      reason?: string;
    }>;
  };
}

export function auditAndRepairGeneratedCourse(
  outlines: ReadonlyArray<SceneOutline>,
  scenes: ReadonlyArray<Scene>,
  constraints?: UserRequirements['teachingConstraints'],
): { scenes: Scene[]; report: CourseQualityReport } {
  const corrections: string[] = [];
  const warnings: string[] = [];
  const allowedKnowledgeIds = new Set(constraints?.allowedKnowledgePoints.map((point) => point.id) ?? []);
  const seenTitles = new Set<string>();

  for (const outline of outlines) {
    const normalizedTitle = outline.title.trim().toLowerCase();
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      warnings.push(`重复页面标题：${outline.title}`);
    }
    seenTitles.add(normalizedTitle);
    if (allowedKnowledgeIds.size > 0) {
      const unknown = (outline.knowledgePointIds ?? []).filter((id) => !allowedKnowledgeIds.has(id));
      if (unknown.length > 0) warnings.push(`${outline.title} 引用了边界外知识点 ID：${unknown.join('、')}`);
    }
    if (outline.audience === 'student' && outline.stageKey === 'ai-learning' && !outline.teachingObjective && !outline.description.trim()) {
      warnings.push(`${outline.title} 缺少可验证的教学目标`);
    }
  }

  const correctedScenes: Scene[] = scenes.map((scene): Scene => {
    if (scene.content.type !== 'quiz') return { ...scene };
    const normalized = normalizeQuizQuestions(scene.content.questions);
    if (normalized.issues.length > 0) {
      corrections.push(`${scene.title}：${normalized.issues.join('；')}`);
    }
    if (normalized.questions.length === 0) {
      warnings.push(`${scene.title} 没有可用题目`);
      return { ...scene };
    }
    return {
      ...scene,
      content: { ...scene.content, questions: normalized.questions },
    } as Scene;
  });

  const firstStudentScene = outlines.find((outline) => outline.audience === 'student' && outline.stageKey === 'ai-learning');
  if (firstStudentScene?.type === 'quiz') {
    warnings.push('知识讲授的首个学生页面是测验，建议先激活前置知识或提供具体示例');
  }
  if (constraints && constraints.learningObjectives.length === 0) {
    warnings.push('课程未提供显式学习目标，当前仅按知识图谱和页面目标控制质量');
  }

  return {
    scenes: correctedScenes,
    report: { status: 'completed', ok: warnings.length === 0, corrections, warnings },
  };
}

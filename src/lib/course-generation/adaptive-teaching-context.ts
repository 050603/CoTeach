import type { AdaptiveBranchOutline, AdaptiveLearningPlan, Course } from '@/lib/session/types';
import { deriveTeachingConstraints, formatTeachingConstraintsForChinesePrompt } from '@/lib/openmaic/pedagogy/teaching-constraints';
import { buildAdaptiveResourceRequirement } from '@/lib/adaptive-learning';

/** Prepared branches use the confirmed class profile, never a particular
 * student's identity or diagnostic record. Their explicit scope wins over
 * the broader course objectives. */
export function buildAdaptiveBranchTeachingContext(
  course: Course,
  branch: AdaptiveBranchOutline,
  plan: AdaptiveLearningPlan,
) {
  const prerequisite = branch.kind === 'prerequisite';
  const requestedIds = new Set(prerequisite
    ? branch.prerequisiteKnowledgePointIds : branch.anchorKnowledgePointIds);
  const catalog = prerequisite ? plan.prerequisiteKnowledgePoints ?? [] : course.content.knowledgePoints;
  const knowledgePoints = catalog.filter((point) => requestedIds.has(point.id));
  if (!knowledgePoints.length || knowledgePoints.length !== requestedIds.size) {
    throw new Error('个性化资源的知识边界已失效，请重新确认分支知识点后生成');
  }
  if (!Number.isFinite(branch.targetDurationSec) || branch.targetDurationSec <= 0) {
    throw new Error('个性化资源的片段时长无效，请重新确认时长后生成');
  }
  const classConstraints = deriveTeachingConstraints({
    grade: course.grade,
    subject: course.subject,
    topic: branch.title,
    hours: branch.targetDurationSec / 3600,
    difficulty: course.pblConfig?.difficultyLevel,
    learnerProfile: course.learnerProfile,
    learningObjectives: [branch.objective],
    knowledgePoints,
  });
  // Course-scale defaults round short lessons up to one hour and suggest
  // several new concepts. A branch already has its own confirmed capacity.
  const teachingConstraints = {
    ...classConstraints,
    courseHours: branch.targetDurationSec / 3600,
    totalMinutes: branch.targetDurationSec / 60,
    recommendedKnowledgePointRange: { min: knowledgePoints.length, max: knowledgePoints.length },
    scopeRule: `本片段总时长 ${branch.targetDurationSec} 秒，仅围绕已确认的分支目标与知识边界组织讲解；依据理解需要选择解释和活动，不额外增加知识点或完整课程步骤来填充时间。`,
  };
  const sourceLines = knowledgePoints.map((point) => {
    const prior = prerequisite ? plan.prerequisiteKnowledgePoints?.find((item) => item.id === point.id) : undefined;
    return [point.name, point.description, point.masteryBoundary,
      prior?.diagnosticBoundary, prior?.expectedPriorKnowledgeEvidence, prior?.necessityRationale,
    ].filter(Boolean).join('：');
  });
  return {
    knowledgePoints,
    teachingConstraints,
    teachingSourceContext: `已确认的分支知识依据（备课资料，不代表任何学生的个人测评结果）：\n${sourceLines.join('\n')}`,
    requirement: [
      buildAdaptiveResourceRequirement(course.name, branch, plan),
      formatTeachingConstraintsForChinesePrompt(teachingConstraints),
      `主课程目标（仅作衔接背景，不扩大本分支教学范围）：${(course.learningObjectives ?? []).join('；') || '遵循已确认主课程大纲'}`,
      '优先遵循已确认的分支目标、先修诊断边界及教师分支指导；班级基础只用于选择词汇、例子和支架，不要求本片段重新讲完整课程。',
      '这些资源将预先生成供符合条件的学生使用。不得声称知道某个学生的具体答案、分数或经历，也不得朗读学情画像或给学生贴标签。',
    ].join('\n\n'),
  };
}

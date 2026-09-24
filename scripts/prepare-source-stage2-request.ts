/** Build an authenticated source-course generation request from its saved design using production domain builders. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { buildCourseTeachingSourceContext } from '../src/lib/course-design/job-runner';
import { mergeTeacherRequirementBriefs } from '../src/lib/course-design/teaching-requirements';
import { buildPblActivityCatalog, buildCourseTeachingConstraints } from '../src/lib/openmaic/pbl/course-request';
import { formatTeachingConstraintsForChinesePrompt } from '../src/lib/openmaic/pedagogy/teaching-constraints';
import { normalizePblCourseConfig } from '../src/lib/pbl-course-config';
import { formatCourseEvidenceContext } from '../src/lib/textbook/course-evidence-types';
import { resolveCourseTextbookFigures } from '../src/lib/textbook/course-evidence';
import { assertRequiredTextbookFiguresAvailable } from '../src/lib/textbook/course-visual-binding';
import { selectClassroomGenerationOutlines } from '../src/lib/course-generation/generation-scope';
import { ZH_CN_COURSE_LANGUAGE_DIRECTIVE } from '../src/lib/openmaic/generation/course-language';
import type { Course } from '../src/lib/session/types';
import type { SceneOutline } from '../src/lib/openmaic/types/generation';
import type { QuickDesignRequest } from '../src/lib/course-design/job-runner';

async function main() {
  const sourceId = process.argv[2] ?? '836c48ed-728c-41c4-8625-cd32ba8daf9f';
  const output = path.resolve(process.argv[3] ?? '.openpbl-runtime/course-upgrade-20260923/source-stage2-full-request.json');
  process.env.DATABASE_URL ??= (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim();
  const db = new PrismaClient();
  try {
    const [version, job, contentJob] = await Promise.all([
      db.classroomTemplateVersion.findFirstOrThrow({ where: { templateId: sourceId, status: 'DRAFT' }, orderBy: { version: 'desc' } }),
      db.generationJob.findFirstOrThrow({ where: { targetId: sourceId, jobType: 'COURSE_DESIGN' }, orderBy: { createdAt: 'desc' } }),
      db.generationJob.findFirstOrThrow({ where: { targetId: sourceId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' } }),
    ]);
    assert.equal(contentJob.status, 'CANCELLED');
    const course = { ...(version.snapshot as unknown as { design: Course }).design, id: sourceId };
    const design = job.request as unknown as QuickDesignRequest;
    const teacherBrief = mergeTeacherRequirementBriefs([design.teacherBrief, design.supplementalAnswers?.brief]);
    assert.match(teacherBrief, /第二阶段/);
    const figures = await resolveCourseTextbookFigures(design.textbookEvidence, course.content.knowledgePoints);
    assertRequiredTextbookFiguresAvailable(figures);
    const textbookImages = figures.flatMap((resource) => resource.status === 'available' && resource.assetId && resource.src ? [{ ...resource, assetId: resource.assetId, src: resource.src, textbookRelation: resource.relation, relationReason: resource.description }] : []);
    const textbookFigureContext = textbookImages.length ? ['本课已授权使用的教材原图（required=true 的资源必须出现在对应知识点首次完整讲解页；候选图只在确有教学帮助时使用；资源 ID 必须原样保留）：', ...textbookImages.map((image) => `${image.id}：${image.description ?? '教材原图'}；figureId=${image.figureId}；required=${image.required}；knowledgePointIds=${image.knowledgePointIds.join(',') || 'none'}`)].join('\n') : '';
    const outlines = (course.content._openmaicSceneOutlines ?? []).map((scene, index) => ({ ...scene, type: scene.type === 'quiz' || scene.type === 'interactive' || scene.type === 'pbl' ? scene.type : 'slide', description: scene.description || scene.title, keyPoints: scene.keyPoints ?? [], estimatedDuration: scene.estimatedDuration ?? scene.targetDurationSec ?? 300, order: scene.order ?? index })) as SceneOutline[];
    assert.equal(outlines.length, 22);
    assert.ok(outlines.every((scene) => scene.stageKey === 'ai-learning'));
    assert.ok(outlines.some((scene) => scene.mediaGenerations?.some((item) => item.type === 'image') && JSON.stringify(scene).includes('鱼形身体')));
    const sourceContext = [buildCourseTeachingSourceContext(course.content.resourcePackage, teacherBrief, design.referenceMaterials ?? []), formatCourseEvidenceContext(design.textbookEvidence), textbookFigureContext].filter(Boolean).join('\n\n');
    const selected = selectClassroomGenerationOutlines(outlines, 'full-course', teacherBrief);
    const request = {
      courseId: sourceId,
      ...(design.generationContractVersion ? { generationContractVersion: design.generationContractVersion } : {}),
      ...(design.assessmentMode ? { assessmentMode: design.assessmentMode } : {}),
      generationModelString: design.generationModelString,
      teachingSourceContext: sourceContext,
      systemMode: 'new', courseTitle: course.name,
      requirement: [`课程：${course.name}（${course.subject}，${course.grade}）`, `课程学习目标：${(course.learningObjectives ?? []).join('；') || course.summary || '未单独提供；遵循已确认页面目标'}`, formatTeachingConstraintsForChinesePrompt(buildCourseTeachingConstraints(course, course.content)), '只根据已确认 sceneOutlines 制作第二阶段知识讲授的学生课堂。', '不得新增其他阶段页面，不得生成教师课堂或教师资源。', sourceContext, '页面内容须解释已确认知识点，提供具体且适龄的例证、必要推理和常见误解；练习与检测对齐页面已讲内容及学习目标，不可用空泛口号或重复概念填充预算。'].join('\n'),
      generationMode: design.generationMode ?? 'standard',
      pblProfile: normalizePblCourseConfig({ ...course.pblConfig, generationTemplate: 'new-ai-learning-only' }),
      moduleTimingPlan: course.content.moduleTimingPlan,
      ...(course.content.resourcePackage ? { resourcePackageIdentity: { id: course.content.resourcePackage.id, revision: course.content.resourcePackage.revision } } : {}),
      pblTeachingActivities: [], pblActivityCatalog: buildPblActivityCatalog(course.content), knowledgePoints: course.content.knowledgePoints, teachingConstraints: buildCourseTeachingConstraints(course, course.content), sceneOutlines: outlines,
      ...(textbookImages.length ? { textbookImages } : {}), adaptiveBranchCount: 0, enableWebSearch: false,
      enableImageGeneration: design.options?.enableImageGeneration ?? true, enableVideoGeneration: design.options?.enableVideoGeneration ?? false, enableTTS: design.options?.enableTTS ?? true,
      languageDirective: outlines.find((scene) => scene.courseLanguageDirective?.trim())?.courseLanguageDirective || ZH_CN_COURSE_LANGUAGE_DIRECTIVE,
      ttsLanguage: 'zh-CN', agentMode: 'default', generationScope: 'full-course', fullSceneCount: selected.fullSceneCount,
    };
    assert.ok(request.generationModelString);
    await writeFile(output, `${JSON.stringify(request, null, 2)}\n`);
    console.log(JSON.stringify({ output, courseId: sourceId, scenes: outlines.length, images: outlines.flatMap((scene) => scene.mediaGenerations ?? []).length, aiStageOnly: true, teacherBrief: teacherBrief.slice(0, 150), model: request.generationModelString, contentJobStatus: contentJob.status, providerCalls: 0 }));
  } finally { await db.$disconnect(); }
}
void main();

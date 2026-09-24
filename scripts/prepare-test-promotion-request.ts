/** Read-only harness: mirror enqueue's wiring using its production domain builders. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
  const output = path.resolve(process.argv[2] ?? '.openpbl-runtime/course-upgrade-20260923/test-promotion-retry');
  const input = path.resolve(process.argv[3] ?? '.openpbl-runtime/course-upgrade-20260923/managed/course-2');
  const run = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
  process.env.DATABASE_URL ??= (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim();
  const db = new PrismaClient();
  try {
    const snapshot = await db.classroomTemplateVersion.findFirstOrThrow({ where: { templateId: run.sourceId }, orderBy: { version: 'desc' } });
    const sourceDesign = await db.generationJob.findFirstOrThrow({ where: { targetId: run.sourceId, jobType: 'COURSE_DESIGN' }, orderBy: { createdAt: 'desc' } });
    const sourceContent = await db.generationJob.findFirstOrThrow({ where: { targetId: run.sourceId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' } });
    const course = { ...(snapshot.snapshot as unknown as { design: Course }).design, id: run.courseId };
    const design = sourceDesign.request as unknown as QuickDesignRequest;
    const teacherBrief = mergeTeacherRequirementBriefs([design.teacherBrief, design.supplementalAnswers?.brief]);
    const figures = await resolveCourseTextbookFigures(design.textbookEvidence, course.content.knowledgePoints);
    assertRequiredTextbookFiguresAvailable(figures);
    const textbookImages = figures.flatMap((resource) => resource.status === 'available' && resource.assetId && resource.src ? [{ ...resource, assetId: resource.assetId, src: resource.src, textbookRelation: resource.relation, relationReason: resource.description }] : []);
    const textbookFigureContext = textbookImages.length ? ['本课已授权使用的教材原图（required=true 的资源必须出现在对应知识点首次完整讲解页；候选图只在确有教学帮助时使用；资源 ID 必须原样保留）：', ...textbookImages.map((image) => `${image.id}：${image.description ?? '教材原图'}；figureId=${image.figureId}；required=${image.required}；knowledgePointIds=${image.knowledgePointIds.join(',') || 'none'}`)].join('\n') : '';
    const outlines = (JSON.parse(await readFile(path.join(input, 'outlines.json'), 'utf8')) as SceneOutline[]).map((scene, index) => ({ ...scene, type: scene.type === 'quiz' || scene.type === 'interactive' || scene.type === 'pbl' ? scene.type : 'slide', description: scene.description || scene.title, keyPoints: scene.keyPoints ?? [], estimatedDuration: scene.estimatedDuration ?? scene.targetDurationSec ?? 300, order: scene.order ?? index })) as SceneOutline[];
    const sourceContext = [buildCourseTeachingSourceContext(course.content.resourcePackage, teacherBrief, design.referenceMaterials ?? []), formatCourseEvidenceContext(design.textbookEvidence), textbookFigureContext].filter(Boolean).join('\n\n');
    const shared = {
      courseId: run.courseId,
      ...(design.generationContractVersion ? { generationContractVersion: design.generationContractVersion } : {}),
      ...(design.assessmentMode ? { assessmentMode: design.assessmentMode } : {}),
      generationModelString: design.generationModelString,
      teachingSourceContext: sourceContext, systemMode: 'new', courseTitle: course.name,
      requirement: [`课程：${course.name}（${course.subject}，${course.grade}）`, `课程学习目标：${(course.learningObjectives ?? []).join('；') || course.summary || '未单独提供；遵循已确认页面目标'}`, formatTeachingConstraintsForChinesePrompt(buildCourseTeachingConstraints(course, course.content)), '只根据已确认 sceneOutlines 制作第二阶段知识讲授的学生课堂。', '不得新增其他阶段页面，不得生成教师课堂或教师资源。', sourceContext, '页面内容须解释已确认知识点，提供具体且适龄的例证、必要推理和常见误解；练习与检测对齐页面已讲内容及学习目标，不可用空泛口号或重复概念填充预算。'].join('\n'),
      generationMode: design.generationMode ?? 'standard',
      pblProfile: normalizePblCourseConfig({ ...course.pblConfig, generationTemplate: 'new-ai-learning-only' }),
      moduleTimingPlan: course.content.moduleTimingPlan,
      ...(course.content.resourcePackage ? { resourcePackageIdentity: { id: course.content.resourcePackage.id, revision: course.content.resourcePackage.revision } } : {}),
      pblTeachingActivities: [], pblActivityCatalog: buildPblActivityCatalog(course.content), knowledgePoints: course.content.knowledgePoints, teachingConstraints: buildCourseTeachingConstraints(course, course.content), sceneOutlines: outlines,
      ...(textbookImages.length ? { textbookImages } : {}), adaptiveBranchCount: 0, enableWebSearch: false,
      enableImageGeneration: design.options?.enableImageGeneration ?? true, enableVideoGeneration: design.options?.enableVideoGeneration ?? false, enableTTS: design.options?.enableTTS ?? true,
      languageDirective: outlines.find((scene) => scene.courseLanguageDirective?.trim())?.courseLanguageDirective || ZH_CN_COURSE_LANGUAGE_DIRECTIVE,
      ttsLanguage: 'zh-CN', agentMode: 'default',
    };
    assert.ok(shared.generationModelString, 'Fixture design must carry its confirmed model');
    const build = (scope: 'test-lesson' | 'full-course') => { const selected = selectClassroomGenerationOutlines(outlines, scope, teacherBrief); return { ...shared, generationScope: scope, fullSceneCount: selected.fullSceneCount, ...(selected.testLesson ? { testLesson: selected.testLesson } : {}) }; };
    const test = build('test-lesson'); const full = build('full-course');
    const plain = (value: object) => JSON.parse(JSON.stringify(value));
    const difference = (left: Record<string, unknown>, right: Record<string, unknown>) => [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => !isDeepStrictEqual(left[key], right[key]));
    const differences = difference(plain(test), plain(full));
    assert.deepEqual(differences.sort(), ['generationScope', 'testLesson']);
    const sourceDifferences = difference(sourceContent.request as Record<string, unknown>, plain(full));
    const audit = { courseId: run.courseId, builtAt: new Date().toISOString(), productionWiring: 'src/lib/course-design/job-runner.ts enqueueClassroomGeneration', testFullDifferences: differences, sourceRequestDifferences: sourceDifferences, testedSection: test.testLesson, comparedKeys: Object.keys(full).sort(), providerCalls: 0 };
    for (const [name, value] of [['test-normal-request.json', test], ['full-normal-request.json', full], ['request-input-audit.json', audit]] as const) await writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
    console.log(JSON.stringify(audit));
  } finally { await db.$disconnect(); }
}
void main();

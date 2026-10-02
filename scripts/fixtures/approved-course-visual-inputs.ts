import type { PdfImage, SceneOutline } from '../../src/lib/openmaic/types/generation';
import type { Scene } from '../../src/lib/openmaic/types/stage';
import { pageOriginalTeachingSources } from '../../src/lib/openmaic/generation/source-grounding';
import type { ApprovedVisualInput } from './approved-teaching-visual-inputs';

export const APPROVED_VISUAL_COURSE_ID = '9b5d0f76-499c-48fc-b5c2-f2e71f936257';
export type CourseVisualImage = PdfImage & {
  originalSrc: string;
  originalElementIds: string[];
  assetId?: string;
  bytesSha256?: string;
  mimeType?: string;
};
export type ApprovedCourseVisualInput = Omit<ApprovedVisualInput, 'kind' | 'source'> & {
  kind: 'process' | 'structure' | 'comparison';
  images: CourseVisualImage[];
  coursePage: { courseId: string; classroomId: string; sceneId: string; outlineId: string; pageNumber: number };
  source: ApprovedVisualInput['source'] & {
    courseId: string; classroomId: string; originalSceneId: string; originalPageId: string; pageNumber: number;
    evidenceIds: string[]; textbookRevisionIds: string[];
  };
};

const SELECTED = [
  { pageNumber: 15, outlineId: 'teaching-section-5-page-1', kind: 'process', checks: [
    '完整四环节及三条真实有向边', '显性任务线索与隐性知识脉络均保留', '真实情境、目标、最近发展区及趣味性的必要条件完整',
  ] },
  { pageNumber: 16, outlineId: 'teaching-section-5-page-2', kind: 'comparison', checks: [
    '形式化任务与知识承载任务的判断标准完整', '保留观看演示后填写定义的原案例', '修正方向必须要求调用目标知识，不能把有产出等同于学习',
  ] },
  { pageNumber: 18, outlineId: 'teaching-section-6-page-1', kind: 'structure', checks: [
    '原教材最近发展区图完整保留且实际可加载', '实际水平、潜在水平与支架支持的关系不重绘或编造',
    '学生中心、小步调、逐渐减少、独立完成以及三类支架和可调节性均保留',
  ] },
  { pageNumber: 22, outlineId: 'teaching-section-6-page-4', kind: 'comparison', checks: [
    '两种教学法在适合阶段与核心作用两个维度下完整对齐', '技能习得初期与综合应用阶段不颠倒', '保留一节课不同环节可以结合使用的边界',
  ] },
] as const;

/** Real course inputs only. Existing native elements are inspected for media
 * identity, never supplied as a handwritten candidate scene or layout recipe. */
export function createApprovedCourseVisualInputs(input: {
  courseId: string;
  classroom: { id: string; stage: { id: string }; scenes: Scene[] };
  outlines: SceneOutline[];
  textbookImages: Array<PdfImage & { assetId?: string; status?: string }>;
  sources: Parameters<typeof pageOriginalTeachingSources>[1];
  snapshotReference: string;
}): ApprovedCourseVisualInput[] {
  if (input.courseId !== APPROVED_VISUAL_COURSE_ID) throw new Error('真实课程验证的课程身份不匹配');
  return SELECTED.map((selection): ApprovedCourseVisualInput => {
    const outlines = input.outlines.filter((outline) => outline.id === selection.outlineId);
    if (outlines.length !== 1) throw new Error(`缺少唯一的原课程大纲：${selection.outlineId}`);
    const outline = outlines[0]!;
    const scenes = input.classroom.scenes.filter((scene) => scene.outlineId === outline.id || scene.id === outline.id);
    if (scenes.length !== 1) throw new Error(`缺少稳定大纲身份匹配的原课堂页面：${outline.id}`);
    const scene = scenes[0]!;
    if (outline.type !== 'slide' || scene.type !== 'slide' || scene.content.type !== 'slide'
      || outline.audience === 'teacher' || outline.order + 1 !== selection.pageNumber
      || scene.stageId !== input.classroom.stage.id || scene.order !== outline.order) {
      throw new Error(`原页面类型、页号或课堂归属不匹配：${outline.id}`);
    }
    if (outline.mediaGenerations?.length || scene.content.canvas.elements.some((element) => element.type === 'video')
      || scene.content.canvas.background?.type === 'image') throw new Error(`当前只读PPT样本不能另行生成或忽略原媒体：${outline.id}`);
    const originals = pageOriginalTeachingSources(outline, input.sources);
    if (!originals.originalSources.length || originals.originalSources.some((source) => !source.passages.length)
      || !outline.teachingBrief?.teachingPlan?.presentationContent?.length) {
      throw new Error(`原页面缺少可核对的原文或已采用教学责任：${outline.id}`);
    }
    const references = new Set([
      ...(outline.suggestedImageIds ?? []),
      ...(outline.visualIntent?.resourceRefs ?? []).filter((reference) => reference.kind === 'source-image').map((reference) => reference.resourceId),
      ...(outline.teachingBrief?.resourceNeeds ?? []).filter((need) => need.kind === 'source-image' && need.assetId).map((need) => need.assetId!),
    ]);
    const nativeImages = scene.content.canvas.elements.filter((element) => element.type === 'image');
    const images = input.textbookImages.filter((image) => references.has(image.id) || Boolean(image.assetId && references.has(image.assetId))
      || nativeImages.some((element) => element.src === image.src));
    if ([...references].some((id) => !images.some((image) => image.id === id || image.assetId === id))
      || nativeImages.some((element) => !images.some((image) => image.src === element.src))) {
      throw new Error(`原教材图片与已采用资源清单无法完整对应：${outline.id}`);
    }
    if (images.some((image) => !image.src || image.status === 'unavailable')) throw new Error(`原教材图片不可用：${outline.id}`);
    const coursePage = { courseId: input.courseId, classroomId: input.classroom.id, sceneId: scene.id,
      outlineId: outline.id, pageNumber: selection.pageNumber };
    return {
      id: `course-page-${selection.pageNumber}`, kind: selection.kind, sample: false, outline: structuredClone(outline),
      coursePage, images: images.map((image) => ({ ...structuredClone(image), required: true, originalSrc: image.src,
        originalElementIds: nativeImages.filter((element) => element.src === image.src).map((element) => element.id) })),
      checks: [...selection.checks, '保留完整原页教学责任、原始证据、已有媒体与计划时长；只生成PPT，不生成讲稿或音频'],
      source: { kind: 'course-snapshot', title: outline.title, reference: input.snapshotReference,
        courseId: input.courseId, classroomId: input.classroom.id, originalSceneId: scene.id, originalPageId: outline.id,
        pageNumber: selection.pageNumber, evidenceIds: originals.originalSources.map((source) => source.evidenceId),
        textbookRevisionIds: [...new Set(originals.originalSources.map((source) => source.revisionId))],
        note: `同一测试课程原第${selection.pageNumber}页；原大纲和已采用教材原文完整保留，原媒体独立绑定。模型只接收真实教学输入，没有手工scene、坐标或新插画。` },
    };
  });
}

import { parseJsonResponse, type AuthoringContentItem } from '@openmaic/generation/browser';
import type { SlidePresentationItem, SlidePresentationProjection } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import type { AICallFn } from './pipeline-types';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import { pageOriginalTeachingSources } from './source-grounding';

export const SLIDE_VISUAL_LAYOUT_VERSION = 'teaching-infographic-v1' as const;
export const SLIDE_VISUAL_PROJECTION_OPERATION = 'PPT_VISUAL_PROJECTION_V1';

/** Visual authoring and legacy native authoring have separate saved responses. */
export function slideVisualOperation(system: string): 'scene' | 'projection' | 'native' {
  if (system.includes('PPT_TEACHING_VISUAL_V2')) return 'scene';
  if (system.includes(SLIDE_VISUAL_PROJECTION_OPERATION)) return 'projection';
  return 'native';
}

export function usesSlideVisualProjection(outline: SceneOutline): boolean {
  const plan = outline.teachingBrief?.teachingPlan;
  return outline.type === 'slide' && outline.audience !== 'teacher'
    && outline.generationPurpose === 'knowledge-teaching'
    && Boolean(plan?.presentationItems?.length || plan?.presentationContent?.length)
    // Quantitative charts retain the existing native chart authoring contract.
    // The text/relation projection must not silently replace a planned chart.
    && outline.visualIntent?.representation !== 'native-chart'
    && !outline.mediaGenerations?.some((media) => media.type === 'video');
}

export function slideVisualSourceContent(outline: SceneOutline): AuthoringContentItem[] {
  const points = adoptedPageAuthoringContent(outline);
  const annotation = outline.visualIntent?.diagram?.annotation;
  return [...points, ...(annotation?.trim()
    ? [{ id: 'diagram-annotation', text: annotation.trim(), required: true }] : [])];
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw Object.assign(new Error(`PPT visual output: ${detail}`), {
    code: 'INVALID_GENERATED_OUTPUT', isRetryable: false,
  });
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());
}

function projectionData(raw: string): SlidePresentationProjection {
  const data = parseJsonResponse(raw);
  if (!object(data) || !Array.isArray(data.items) || !data.items.length) {
    return invalid('a nonempty items array is required');
  }
  const ids = new Set<string>();
  const items = data.items.map((item): SlidePresentationItem => {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || !strings(item.sourceContentIds) || !item.sourceContentIds.length
      || typeof item.text !== 'string' || !item.text.trim()
      || ['label', 'row', 'column'].some((key) => item[key] !== undefined
        && (typeof item[key] !== 'string' || !String(item[key]).trim()))
      || item.emphasis !== undefined && !strings(item.emphasis)
      || item.sourceEvidenceIds !== undefined && !strings(item.sourceEvidenceIds)) {
      return invalid('each item needs a unique id, sourceContentIds and text, with valid optional labels');
    }
    ids.add(item.id);
    const text = item.text.trim();
    const emphasis = item.emphasis as string[] | undefined;
    if (emphasis?.some((part) => !text.includes(part))) return invalid('emphasis must select literal display text');
    return { id: item.id, sourceContentIds: [...new Set(item.sourceContentIds)], text,
      ...(typeof item.label === 'string' ? { label: item.label.trim() } : {}),
      ...(typeof item.row === 'string' ? { row: item.row.trim() } : {}),
      ...(typeof item.column === 'string' ? { column: item.column.trim() } : {}),
      ...(emphasis?.length ? { emphasis } : {}),
      ...(item.sourceEvidenceIds ? { sourceEvidenceIds: [...new Set(item.sourceEvidenceIds as string[])] } : {}),
    };
  });
  if (data.links !== undefined && (!Array.isArray(data.links) || data.links.some((link) =>
    !object(link) || typeof link.from !== 'string' || !ids.has(link.from)
    || typeof link.to !== 'string' || !ids.has(link.to) || link.from === link.to
    || link.label !== undefined && (typeof link.label !== 'string' || !link.label.trim())))) {
    return invalid('links must connect existing distinct display items');
  }
  return { schemaVersion: 1, layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION, verified: false,
    items, ...(Array.isArray(data.links) && data.links.length
      ? { links: data.links as NonNullable<SlidePresentationProjection['links']> } : {}), elementIdsBySource: {} };
}

/** Only an explicit dimension | object: description is a comparison cell. */
export function unchangedSlideProjection(sources: readonly AuthoringContentItem[]): SlidePresentationProjection {
  const items = sources.map((source): SlidePresentationItem => {
    const comparison = source.text.match(/^\s*([^｜|：:\n]+)[｜|]([^｜|：:\n]+)[：:]\s*([^｜|]+)$/u);
    if (comparison && comparison[1]!.trim() !== '特征') {
      return { id: source.id, sourceContentIds: [source.id], row: comparison[1]!.trim(),
        column: comparison[2]!.trim(), text: comparison[3]!.trim() };
    }
    const characteristic = source.text.match(/^\s*特征[｜|]([^：:\n]+)[：:]\s*(.+)$/u);
    const labeled = characteristic ?? source.text.match(/^\s*([^：:\n]{2,16})[：:]\s*(.+)$/u);
    return { id: source.id, sourceContentIds: [source.id],
      ...(labeled ? { label: labeled[1]!.trim(), text: labeled[2]!.trim() } : { text: source.text }) };
  });
  // Structural parsing preserves original words without another model request.
  // The caller enables the host contract only after preserving the whole catalog.
  return { schemaVersion: 1, layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
    items, verified: false, elementIdsBySource: {} };
}

/** Metadata is useful only when the mapped display prose really exists
 * in its mapped, visible native elements. It cannot substitute for teaching. */
export function projectedSourceDisplayText(projection: SlidePresentationProjection, sourceId: string): string {
  return projection.items.filter((item) => item.sourceContentIds.includes(sourceId))
    .map((item) => [item.row, item.column, item.label, item.text].filter(Boolean).join('：')).join('\n');
}

function deterministicProjectionIssues(projection: SlidePresentationProjection,
  sources: readonly AuthoringContentItem[], evidenceIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const item of projection.items) {
    if (item.sourceContentIds.some((id) => !sourceIds.has(id))) issues.push(`Unknown source for ${item.id}`);
    if (item.sourceEvidenceIds?.some((id) => !evidenceIds.has(id))) issues.push(`Unadopted evidence for ${item.id}`);
    if (evidenceIds.size && !item.sourceEvidenceIds?.length) issues.push(`Missing adopted evidence for ${item.id}`);
  }
  for (const source of sources) {
    const displayed = projectedSourceDisplayText(projection, source.id);
    if (!displayed) issues.push(`Missing adopted point ${source.id}`);
    const numbers = source.text.match(/\d+(?:\.\d+)?(?:%|％)?/gu) ?? [];
    const displayedNumbers: string[] = displayed.match(/\d+(?:\.\d+)?(?:%|％)?/gu) ?? [];
    if (numbers.some((number) => !displayedNumbers.includes(number))) {
      issues.push(`Changed or omitted quantity in ${source.id}`);
    }
    // Keep the existing quantity contract meaningful for ranges as well as
    // digits. "at least 3" and "3" are different teaching facts.
    const lowerBound = /(?:至少|不少于|不低于|≥|>=)\s*(\d+(?:\.\d+)?(?:%|％)?)/gu;
    const upperBound = /(?:至多|最多|不超过|不高于|≤|<=)\s*(\d+(?:\.\d+)?(?:%|％)?)/gu;
    for (const [pattern, equivalent] of [[lowerBound, '(?:至少|不少于|不低于|≥|>=)'],
      [upperBound, '(?:至多|最多|不超过|不高于|≤|<=)']] as const) {
      for (const match of source.text.matchAll(pattern)) {
        const quantity = match[1]!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        if (!new RegExp(`${equivalent}\\s*${quantity}(?![\\d.])`, 'u').test(displayed)) {
          issues.push(`Changed or omitted quantity boundary in ${source.id}`);
        }
      }
    }
  }
  const comparison = projection.items.filter((item) => item.row || item.column);
  if (comparison.length) {
    const rows = [...new Set(comparison.map((item) => item.row))];
    const columns = [...new Set(comparison.map((item) => item.column))];
    if (comparison.some((item) => !item.row || !item.column) || columns.length < 2
      || rows.some((row) => columns.some((column) => comparison.filter((item) =>
        item.row === row && item.column === column).length !== 1))) {
      issues.push('Comparison dimensions are incomplete or ambiguous');
    }
  }
  return issues;
}

export async function generateSlideVisualProjection(outline: SceneOutline, aiCall: AICallFn,
  options: Parameters<typeof pageOriginalTeachingSources>[1] & { languageDirective?: string } = {}): Promise<{
    projection: SlidePresentationProjection; diagnostics: string[];
  } | null> {
  const sources = slideVisualSourceContent(outline);
  if (!sources.length) return null;
  const original = pageOriginalTeachingSources(outline, options);
  const evidenceIds = new Set(original.originalSources.map((source) => source.evidenceId));
  const context = { title: outline.title, adoptedDisplayContent: sources, originalTeachingSources: original,
    diagram: outline.visualIntent?.diagram,
    visualRelationship: outline.teachingBrief?.teachingPlan?.visualRelationship,
    resources: outline.visualIntent?.resourceRefs,
  };
  const raw = await aiCall([
    `## ${SLIDE_VISUAL_PROJECTION_OPERATION}`,
    '你负责仅用于 PPT 的视觉表达。课程讲稿、编排、语音和原教学计划是独立输入，保持原样。将当前页已采纳要点精炼成可观察的短句、标签和图解结构；每个事实、数量、否定、必要条件、比较对象和真实关系必须完整表达。解释展开留在原讲稿中，不要复制教材长段或讲稿。原始资料用于核对含义，不能扩大当前页面范围。',
    '采用清爽教学信息图：白底、深蓝标题、灰蓝结构、单一强调色，少量关键词强调。不要把每个段落改成彩框；优先真正的对照、过程、关系和图示标注。教材图片及已规划的生成图片由宿主保留。不要重绘教材图、添加不存在的图片或改变媒体请求。',
    '原有 diagram 的全部节点、顺序、分支、反馈和边由宿主保留，不在返回值重写图。diagram-annotation 可精炼为必要的关系说明，不要重复全部流程。与原流程某节点对应的解释可用该节点的完整名称作为 label，不得创造阶段、把渐进变化误放在最后一步或改变进入/退出条件。',
    '每个 items 项包含 id（唯一）、sourceContentIds（原目录的精确 ID 数组）、text（短而有完整含义的纯文本）；可用 label（简短小标题）、emphasis（text 的精确子串数组）、sourceEvidenceIds（实际采用的证据 ID）。允许一个原要点拆成多个项。必须覆盖全部 adoptedDisplayContent，包括 diagram-annotation。',
    '主动精炼措辞：把长段转成短句、并列术语或必要的图解标注，通常一到两行一层含义。不要逐字复制长句，也不要用重复标题占独立正文区。原目录的 heading 可与对应解释合并在同一项，并在 sourceContentIds 保留双方来源。每项通常只强调一个决定理解的条件或区别，不能将大半段文字全部加粗。',
    '采用“条件 → 变化”“主体 / 内容”等可观察表达。例如“在完成3次测量后再计算平均值”可等义表达为“3次测量 → 计算平均值”，不能变成“测量 → 计算”。性质名称、先后关系与否定边界必须保留，可分别放在 label 与 text 中，不用长句重复标签。并列的必要项目一个也不能丢。',
    '同一事实被多个原目录项重复描述时，上屏只表达一次，并把全部对应来源 ID 一起写入该项的 sourceContentIds。例如撤除节奏同时出现在正文与 diagram-annotation，就在该节奏项引用两个来源；图注其余条件可以另项展示。每项在有原始证据时必须引用实际的 sourceEvidenceIds。',
    '真正的比较项同时用 row（比较维度）、column（比较对象），text 仅放该单元格的解释，同一比较保留完整行列；普通特征用 label 与 text。原文的竖线只是标记，不能残留在 label、row、column 或 text 中模拟关系。不要把数学、代码中的竖线当分隔。',
    'links:[{from,to,label?}] 仅用于原要点明确支持的概念关系，连接 items 的 id。并列项没有连线；阅读顺序不代表因果。原 diagram 已表达的关系不重复创建。优先使用短句和空间关系，不能以只有标题或关键词代替应教解释。',
    '如果已有 diagram，其教学步骤由宿主完整保留；items 对应节点的短说明使用原节点名 label。若本页还有原文明确的条件与变化、概念与影响等核心关系，可用两个短 items 与一条 links 单独表达，不能重复教学流程。用来源映射覆盖各条件，余下边界用一条简短说明；不要再输出一整段重复图注。',
    '此操作的唯一输出协议是 JSON {"items":[...],"links":[]}，没有 elements、components、讲稿或几何坐标。其他调用上下文的原生布局协议仅用于后续编译，不适用于本操作。',
    options.languageDirective ?? '学生可见文字使用简体中文。',
  ].join('\n'), JSON.stringify(context));
  const projection = projectionData(raw);
  const diagnostics = deterministicProjectionIssues(projection, sources, evidenceIds);
  // One production model call. Existing source/quantity contracts only report
  // concrete structural failures; they never launch a judge or repair request.
  // A failed mapping retains every original display point for native compilation.
  return { projection: diagnostics.length
    ? { ...unchangedSlideProjection(sources), verified: true }
    : { ...projection, verified: true }, diagnostics };
}

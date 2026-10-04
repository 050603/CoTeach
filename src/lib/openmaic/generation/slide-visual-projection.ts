import { parseJsonResponse, type AuthoringContentItem } from '@openmaic/generation';
import type { SlidePresentationDesign, SlidePresentationItem, SlidePresentationProjection } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import type { AICallFn } from './pipeline-types';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import { pageOriginalTeachingSources } from './source-grounding';
import { buildFirstPassTeachingInput, type TeachingAuthoringKnowledgePoint } from './first-pass-authoring';
import { formatLecturePresentationReference } from './lecture-presentation-reference';
import { buildSlideSemanticGroups } from './slide-semantic-hierarchy';
import { buildNativeDisplayFactSets } from './native-display-fact-sets';

export const SLIDE_VISUAL_LAYOUT_VERSION = 'teaching-infographic-v2' as const;
export const SLIDE_VISUAL_PROJECTION_OPERATION = 'PPT_VISUAL_PROJECTION_V1';
export const SLIDE_VISUAL_AUTHORING_VERSION = 'ppt-visual-authoring-v11-reference-lecture-composition';

/** These are authoring roles, not concepts for students to read on the slide. */
export function slidePresentationLabel(label?: string): string | undefined {
  return label && !/^(?:本页结论|本页要点|本页重点|核心主张|核心结论|关键结论|一句话总结|由此看到|案例观察|结论|要点|小结|总结|提示)$/u.test(label.trim())
    ? label.trim() : undefined;
}

/** Visual authoring and legacy native authoring have separate saved responses. */
export function slideVisualOperation(system: string): 'projection' | 'native' | 'native-lecture' {
  if (system.includes('PPT_NATIVE_LECTURE_V1')) return 'native-lecture';
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

function authoredDesign(value: unknown, ids: Set<string>, diagnostics: string[]): SlidePresentationDesign | undefined {
  if (value === undefined) return undefined;
  if (object(value) && ['rows', 'columns'].includes(String(value.flow))
    && ['start', 'center'].includes(String(value.align)) && typeof value.gap === 'number'
    && value.gap >= 16 && value.gap <= 40 && Array.isArray(value.groups) && value.groups.length > 0
    && value.groups.every((group) => object(group) && typeof group.id === 'string' && group.id.trim()
      && strings(group.itemIds) && group.itemIds.length > 0 && group.itemIds.every((id) => ids.has(id))
      && typeof group.span === 'number' && Number.isInteger(group.span) && group.span >= 1 && group.span <= 12
      && (group.columns === undefined || [1, 2, 3].includes(Number(group.columns)) && typeof group.columns === 'number')
      && ['plain', 'panel', 'accent'].includes(String(group.treatment)))) {
    const groups = value.groups as SlidePresentationDesign['groups'];
    const assigned = groups.flatMap((group) => group.itemIds);
    const media = value.media;
    if (new Set(groups.map((group) => group.id)).size === groups.length
      && assigned.length === ids.size && new Set(assigned).size === ids.size
      && (media === undefined || object(media) && ['left', 'right', 'top', 'bottom'].includes(String(media.placement))
        && typeof media.fraction === 'number' && media.fraction >= 0.35 && media.fraction <= 0.65)) {
      return { flow: value.flow as SlidePresentationDesign['flow'], align: value.align as SlidePresentationDesign['align'],
        gap: value.gap, groups, ...(media ? { media: media as SlidePresentationDesign['media'] } : {}) };
    }
  }
  diagnostics.push('Invalid optional spatial design; retained all teaching content for measured automatic layout');
  return undefined;
}

/** A wording fallback may reuse spatial proportions, never unsupported words or
 * arrows. Rebind groups to original items only when ownership is unambiguous. */
function originalSpatialDesign(projection: SlidePresentationProjection, sources: readonly AuthoringContentItem[]): SlidePresentationDesign | undefined {
  if (!projection.design) return undefined;
  const byId = new Map(projection.items.map((item) => [item.id, item]));
  const groups = projection.design.groups.map((group) => ({ ...group,
    itemIds: [...new Set(group.itemIds.flatMap((id) => byId.get(id)?.sourceContentIds ?? []))] }));
  return authoredDesign({ ...projection.design, groups }, new Set(sources.map((source) => source.id)), []);
}

export function projectionData(raw: string, diagnostics: string[]): SlidePresentationProjection {
  const data = parseJsonResponse(raw);
  if (!object(data) || !Array.isArray(data.items) || !data.items.length) {
    return invalid('a nonempty items array is required');
  }
  const ids = new Set<string>();
  const items = data.items.map((item): SlidePresentationItem => {
    if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || !strings(item.sourceContentIds)
      || typeof item.text !== 'string' || !item.text.trim()
      || ['label', 'row', 'column', 'diagramNodeId'].some((key) => item[key] !== undefined
        && (typeof item[key] !== 'string' || !String(item[key]).trim()))
      || item.emphasis !== undefined && !strings(item.emphasis)
      || item.sourceEvidenceIds !== undefined && !strings(item.sourceEvidenceIds)) {
      return invalid('each item needs a unique id, sourceContentIds and text, with valid optional labels');
    }
    ids.add(item.id);
    const text = item.text.trim();
    const suppliedEmphasis = item.emphasis as string[] | undefined;
    const emphasis = suppliedEmphasis?.filter((part) => text.includes(part));
    if (emphasis?.length !== suppliedEmphasis?.length) diagnostics.push(`Omitted nonliteral optional emphasis in ${item.id}`);
    // Optional semantic metadata is a quality contract. Invalid metadata must
    // not discard an executable first draft or trigger a second model request.
    let semanticBindings: SlidePresentationItem['semanticBindings'];
    if (item.semanticBindings !== undefined) {
      if (Array.isArray(item.semanticBindings) && item.semanticBindings.every((binding) => object(binding)
        && typeof binding.groupId === 'string' && binding.groupId.trim()
        && ['overview', 'member', 'context'].includes(String(binding.role))
        && (binding.memberId === undefined || typeof binding.memberId === 'string' && binding.memberId.trim()))) {
        semanticBindings = item.semanticBindings.map((binding) => ({
          groupId: binding.groupId.trim(), role: binding.role,
          ...(binding.memberId !== undefined ? { memberId: binding.memberId.trim() } : {}),
        }));
      } else diagnostics.push(`Invalid semantic hierarchy metadata in ${item.id}; retained the display wording`);
    }
    return { id: item.id, sourceContentIds: [...new Set(item.sourceContentIds)], text,
      ...(typeof item.label === 'string' && slidePresentationLabel(item.label) ? { label: slidePresentationLabel(item.label) } : {}),
      ...(typeof item.row === 'string' ? { row: item.row.trim() } : {}),
      ...(typeof item.column === 'string' ? { column: item.column.trim() } : {}),
      ...(typeof item.diagramNodeId === 'string' ? { diagramNodeId: item.diagramNodeId.trim() } : {}),
      ...(emphasis?.length ? { emphasis } : {}),
      ...(['bold', 'color', 'highlight'].includes(String(item.emphasisStyle))
        ? { emphasisStyle: item.emphasisStyle as SlidePresentationItem['emphasisStyle'] } : {}),
      ...(item.sourceEvidenceIds ? { sourceEvidenceIds: [...new Set(item.sourceEvidenceIds as string[])] } : {}),
      ...(semanticBindings ? { semanticBindings } : {}),
    };
  });
  if (data.links !== undefined && (!Array.isArray(data.links) || data.links.some((link) =>
    !object(link) || typeof link.from !== 'string' || !ids.has(link.from)
    || typeof link.to !== 'string' || !ids.has(link.to) || link.from === link.to
    || link.label !== undefined && (typeof link.label !== 'string' || !link.label.trim())))) {
    return invalid('links must connect existing distinct display items');
  }
  const design = authoredDesign(data.design, ids, diagnostics);
  return { schemaVersion: 1, layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION, verified: false,
    ...(design ? { design } : {}),
    ...(['focus', 'comparison', 'process', 'image-focus', 'relationship', 'editorial'].includes(String(data.composition))
      ? { composition: data.composition as SlidePresentationProjection['composition'] } : {}),
    ...(typeof data.focusItemId === 'string' && ids.has(data.focusItemId) ? { focusItemId: data.focusItemId } : {}),
    ...(typeof data.takeawayItemId === 'string' && ids.has(data.takeawayItemId) ? { takeawayItemId: data.takeawayItemId } : {}),
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
      ...(labeled ? { label: slidePresentationLabel(labeled[1]), text: labeled[2]!.trim() } : { text: source.text }) };
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

export function deterministicProjectionIssues(projection: SlidePresentationProjection,
  sources: readonly AuthoringContentItem[], evidenceIds: ReadonlySet<string>, diagramNodes: readonly { id: string; label: string }[] = []): string[] {
  const issues: string[] = [];
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const item of projection.items) {
    if (!item.sourceContentIds.length) issues.push(`Missing adopted source mapping for ${item.id}`);
    if (item.sourceContentIds.some((id) => !sourceIds.has(id))) issues.push(`Unknown source for ${item.id}`);
    if (item.sourceEvidenceIds?.some((id) => !evidenceIds.has(id))) issues.push(`Unadopted evidence for ${item.id}`);
    if (evidenceIds.size && !item.sourceEvidenceIds?.length) issues.push(`Missing adopted evidence for ${item.id}`);
  }
  for (const source of sources) {
    // The bound native node already displays its step number/name. Requiring
    // the same number in its explanation would recreate duplicate step lists.
    const labels = projection.items.filter((item) => item.sourceContentIds.includes(source.id))
      .flatMap((item) => diagramNodes.filter((node) => node.id === item.diagramNodeId).map((node) => node.label));
    const displayed = [projectedSourceDisplayText(projection, source.id), ...labels].join('\n').trim();
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

export function buildSlideDisplayAuthoringContext(outline: SceneOutline,
  options: Parameters<typeof pageOriginalTeachingSources>[1] & {
    languageDirective?: string; teachingAuthoringKnowledge?: readonly TeachingAuthoringKnowledgePoint[];
  } = {}) {
  const sources = slideVisualSourceContent(outline);
  const original = pageOriginalTeachingSources(outline, options);
  const spoken = Boolean(outline.teachingBrief?.manuscript);
  const firstPass = !spoken && outline.teachingBrief?.authoring
    ? buildFirstPassTeachingInput([outline], options.teachingAuthoringKnowledge ?? options.sourceKnowledgePoints) : undefined;
  const pageAuthoring = firstPass?.pages.get(outline.id);
  const adoptedSourceBindings = sources.map((source) => {
    const items = outline.teachingBrief?.teachingPlan?.presentationItems
      ?.flatMap((item, index) => item.text.trim() === source.text.trim() ? [{ item, index }] : []) ?? [];
    const nodeIds = new Set(items.flatMap(({ item }) => item.nodeIds ?? []));
    return { sourceContentId: source.id, presentationItemIndexes: items.map(({ index }) => index),
      nodeRefs: pageAuthoring?.nodeDuties.filter((duty) => nodeIds.has(duty.nodeId))
        .flatMap((duty) => duty.nodeRef ? [duty.nodeRef] : []) ?? [] };
  });
  const evidenceIds = new Set(original.originalSources.map((source) => source.evidenceId));
  const context = { title: outline.title, adoptedDisplayContent: sources, originalTeachingSources: original,
    semanticGroups: buildSlideSemanticGroups(sources),
    requiredFactSets: buildNativeDisplayFactSets(sources),
    adoptedEvidenceIds: [...evidenceIds],
    ...(spoken ? {} : { teachingAuthoring: firstPass?.catalog, pageAuthoring, adoptedSourceBindings }),
    diagram: outline.visualIntent?.diagram,
    visualRelationship: outline.teachingBrief?.teachingPlan?.visualRelationship,
    resources: outline.visualIntent?.resourceRefs,
  };
  return { sources, original, spoken, evidenceIds, context };
}

export async function generateSlideVisualProjection(outline: SceneOutline, aiCall: AICallFn,
  options: Parameters<typeof buildSlideDisplayAuthoringContext>[1] = {}): Promise<{
    projection: SlidePresentationProjection; diagnostics: string[];
  } | null> {
  const { sources, original, spoken, evidenceIds, context } = buildSlideDisplayAuthoringContext(outline, options);
  if (!sources.length) return null;
  const raw = await aiCall([
    `## ${SLIDE_VISUAL_PROJECTION_OPERATION}`,
    '你负责仅用于 PPT 的视觉表达。课程讲稿、编排、语音和原教学计划是独立输入，保持原样。将当前页已采纳要点精炼成可观察的短句、标签和图解结构；每个事实、数量、否定、必要条件、比较对象和真实关系必须完整表达。解释展开留在原讲稿中，不要复制教材长段或讲稿。原始资料用于核对含义，不能扩大当前页面范围。',
    ...(spoken ? ['adoptedDisplayContent 是已采纳的页面展示内容。实际讲稿另行提供，只用于理解当前页的含义与范围；原文决定事实和必要条件。只做展示精炼及视觉组织，不扩写教学内容、不生成或改写口播，不把规划摘要当事实来源。'] : [
    'adoptedDisplayContent 是当前页的展示职责与表达草稿，不是独立事实依据。adoptedSourceBindings 用 sourceContentId 与 nodeRefs 连接实际解释；从 teachingAuthoring.explanationNodes 的 bodyRef 读取唯一解释正文，statementRef 与案例各字段引用都通过 teachingAuthoring.texts 解析。pageAuthoring 指定本页首次解释、深化与承接职责。原文和对应节点正文决定展示命题的对象、条件与范围，短句必须在这些依据内编写，不能直接把概括草稿当结论。解释展开留在讲稿，不能把节点长段全文上屏。',
    'teachingAuthoring.statements 区分教材事实、生成推断及 logicalConditions；cases 保留具体对象、任务、前提、行动和结果，correspondences 只把指定短语和实际示范的情境元素对应起来，不能据部分示范认定整条陈述的所有机制都已出现，也不是普遍命题的证明。类比在续用和总结时保持原映射及 limitations。本课讨论范围不是逻辑前提，情境假设不是教材发生的事实。精炼不能把有条件陈述变成普遍限制，把通常路径变成必经步骤，把更适合变成另一方法不成立，或者把“原文未建立某关系”变成“该关系不存在”。这些来源边界留在内部，不作为学生要记忆的否定命题。只表达实际采用的展示职责，不因有额外依据就扩大当前页范围。',
    ]),
    formatLecturePresentationReference({ audience: 'slide' }),
    '先确定学生本页要看懂的核心认识，再设计视觉主次。PPT 展示课堂重点，不是逐句讲稿；多条来源可合成一个有完整含义的重点，全部对应来源 ID 仍需保留。过程推理、故事、过渡和口头举例留在完整讲稿；所选重点的数量、条件、否定和区别不能省略。不要为每个来源机械生成一块正文，不以删掉应教知识或缩小字体换取留白。',
    'composition 仅描述教学关系，不是模板编号，也不限制布局。可选 focus（一个核心认识配辅助要点，可用 focusItemId 指定核心项）；comparison（共同维度对照）；process（真实步骤与就近说明）；image-focus（教材或已有生成图片作为观察主体，文字作解释）；relationship（真实因果或概念关系）；editorial（并列要点的开放分组）。根据本页教学关系选择，不轮换模板凑多样性。沿用已认可讲授课件的浅色重点区与清楚分组，标题深蓝，正文及实际对象小标题深灰；普通 emphasis 用粗体，只有关键区别或条件才少量用暖色，不把所有小标题与半段正文标蓝。',
    '先把教学关系转为可观察的图解，再编排文字。只给段落加色块或分成左右两栏不算图解：已有材料涉及组成、编码、转换、作用或依赖时，用短节点 items 与 links 表达材料明确支持的机制，旁边只放应用和必要边界；不能因为两个事实前后出现，就连成因果。真正对照两种对象时，必须在对照单元填写 row=同一比较维度、column=比较对象，宿主绘制对齐的比较矩阵，不要用重复对象标题加四段正文代替比较。若没有真实关系或数值，保持有主次的文字，不编造箭头、比例或统计图。',
    '用 design 自主编排空间，不能只选择几套固定模板。design={flow: rows或columns, align: start或center, gap:16到40, groups:[{id,itemIds,span:1到12,columns:1或2或3,treatment:plain或panel或accent}], media?:{placement:left或right或top或bottom,fraction:0.35到0.65}}。rows 表示组横向并置，span 是相对宽度；columns 表示组纵向叠放；组内可自由选择列数，align控制组内文字对齐。通过任意分组、组内排列、非对称比例、重点底色与必要留白组合构图，按内容需要编排而不是每页轮换模板。plain 为无底板开放分组，panel 为浅蓝底承托，accent 为浅暖色重点；重点只能来自实际教学内容，不要每组都是同等醒目的卡片。每个 item 必须恰好归入一个组，itemIds 使用 items 中已有 id，分组不能捏造关系、删除内容或改写真实流程。',
    '同一主题的观察图、案例事实、对应概念比较和已有结论优先同页展示，让学生观察画面时能同时看到解释依据。不要把一张图放大到排挤已采纳的必要说明，也不为大面积留白把同一认识拆成连续短页；图文与比较表可以共享正文空间。保留当前页完整展示职责，不从讲稿增加未采纳的内容，不增加新页面、改写口播或改变教学及测验顺序。',
    '禁止把完整说明塞进很窄的竖向色块：正文区按实际字号至少保留约12个汉字的行宽，短标签除外。图片旁若空间不足，不继续分割成多条文字窄栏；合并为一个宽说明区，用上下分组或宽提示带保留主次，原图比例及图注完整。不要为装饰色块压缩其他正文，避免每行几个字的碎裂换行。',
    'design.media 控制实际图片在正文哪一侧及所占比例；不要遮挡教材细节。宿主按实际字体与图片比例测量空间，不接收任意绝对坐标；无法容纳时会调整布局并保留内容。真实流程、分支、比较矩阵与 links 优先保留完整结构，它们不应被纯排版分组取代。',
    '不要把“每段文字前一条小横杠”当设计。概念页选一个焦点、其余说明呈支持关系；比较页以矩阵为主体，已有结论可用 takeawayItemId 指定后置的结论项；图片页以真实图像为主体，标签与简短说明围绕观察对象组织。实际因果或作用关系可用 links 编成原生关系图，不把所有内容都写成长列表。takeawayItemId 只能引用 items 中已有且有来源的结论，不能为了构图新添口号。',
    '展示文案优先写成能独立读懂的一句话，用 emphasis 与重点色块突出关键词或结论。label 是可选的实际概念或对象名称，不是每项必填的小标题；禁止“本页结论”“核心主张”“由此看到”“案例观察”等编辑标签，也不要反复写“短语：一串说明”。若对象已包含在 text 中就省略 label。必要的概念名可作为独立标题，正文保留完整命题；不要给每句话加前缀。',
    '流程以完整步骤和顺序为主体。较长的七步流程适合一条连续的阅读主轴和宽说明区；多行排列时阅读方向保持一致，换行连线只走节点外的留白，不使用之字形、斜跨或穿过文字的连线。环路按真实回路闭合，分支保留各出口，不能把并列关系强串步骤。关系箭头只写真实且简短的关系词，完整解释留在两端命题里，不把长句挤成狭长的箭头标签。',
    '教材图片及已规划的生成图片由宿主保留；教材图用于直接观察，保留原图细节、比例、图注和来源，不重绘或裁掉标签。生成图沿用已有资源身份与教学用途，不以装饰配图替代教材依据。图片页选择 image-focus，为图片留主体空间，说明围绕观察对象组织，不把图片挤成角落缩略图。不要添加不存在的图片或改变媒体请求。',
    '原有 diagram 的全部节点、顺序、分支、反馈和边由宿主保留，不在返回值重写图。diagram-annotation 可精炼为必要的关系说明，不要重复全部流程。与原流程某节点对应的解释可用该节点的完整名称作为 label，不得创造阶段、把渐进变化误放在最后一步或改变进入/退出条件。',
    '每个 items 项包含 id（唯一）、sourceContentIds（原目录的精确 ID 数组）、text（短而有完整含义的纯文本）；可用 label（简短小标题）、emphasis（text 的精确子串数组）、sourceEvidenceIds（实际采用的证据 ID）。流程节点说明用 diagramNodeId 绑定原 diagram.nodes 的精确 id；label 不重复步骤编号，text 不再重复节点名称。不要把步骤名另抄成一套正文。允许一个原要点拆成多个项，或多个重复要点合成一项。必须覆盖全部 adoptedDisplayContent，包括 diagram-annotation。',
    'sourceContentIds 必须至少包含一个 adoptedDisplayContent 中的真实 id。sourceEvidenceIds 只能选 adoptedEvidenceIds 中的证据 id，也就是 originalTeachingSources.originalSources[].evidenceId，不能填 sourceBlockId、段落 id 或教材 id；同一段原文可能属于多个证据，按实际采用的证据身份引用。新增概括或说明仍须明确对应的原要点，不输出无来源的额外展示项。emphasis 是可选样式，只有 text 中逐字存在的连续片段才能使用；概念相关、近义词或词序变化都不能用作 emphasis，拿不准时省略样式。',
    '主动精炼措辞：把长段转成短句、并列术语或必要的图解标注，通常一到两行一层含义。不要逐字复制长句，也不要用重复标题占独立正文区。原目录的 heading 可与对应解释合并在同一项，并在 sourceContentIds 保留双方来源。每项通常只强调一个决定理解的条件或区别，不能将大半段文字全部加粗。',
    '采用“条件 → 变化”“主体 / 内容”等可观察表达。例如“在完成3次测量后再计算平均值”可等义表达为“3次测量 → 计算平均值”，不能变成“测量 → 计算”。性质名称、先后关系与否定边界必须保留，可分别放在 label 与 text 中，不用长句重复标签。并列的必要项目一个也不能丢。',
    '同一事实被多个原目录项重复描述时，上屏只表达一次，并把全部对应来源 ID 一起写入该项的 sourceContentIds。例如撤除节奏同时出现在正文与 diagram-annotation，就在该节奏项引用两个来源；图注其余条件可以另项展示。每项在有原始证据时必须引用实际的 sourceEvidenceIds。',
    '真正的比较项同时用 row（比较维度）、column（比较对象），text 仅放该单元格的解释，同一比较保留完整行列；普通特征用完整短句，只有确需区分实际概念或对象时才选用 label。原文的竖线只是标记，不能残留在 label、row、column 或 text 中模拟关系。不要把数学、代码中的竖线当分隔。',
    'links:[{from,to,label?}] 仅用于原要点明确支持的概念关系，连接 items 的 id。并列项没有连线；阅读顺序不代表因果。原 diagram 已表达的关系不重复创建。优先使用短句和空间关系，不能以只有标题或关键词代替应教解释。',
    '如果已有 diagram，其教学步骤由宿主完整保留；items 对应节点的短说明使用原节点名 label。若本页还有原文明确的条件与变化、概念与影响等核心关系，可用两个短 items 与一条 links 单独表达，不能重复教学流程。用来源映射覆盖各条件，余下边界用一条简短说明；不要再输出一整段重复图注。',
    '输出前逐项检查：每个 items 包括拆开的支持项和结论项都须提供 sourceContentIds；adoptedEvidenceIds 非空时，每项 sourceEvidenceIds 都必须是实际采用的证据 ID，不可省略。对比用 row/column；机制用真实 links；design 只规划这些表达的空间，不代替结构字段。',
    '此操作的唯一输出协议是 JSON {"composition":"focus|comparison|process|image-focus|relationship|editorial","focusItemId":"可选的核心项 id","takeawayItemId":"可选的结论项 id","design":{"flow":"rows","align":"start","gap":24,"groups":[{"id":"自定组名","itemIds":["实际item id"],"span":5,"columns":1,"treatment":"plain"}]},"items":[...],"links":[]}，没有 elements、components、讲稿或几何坐标。其他调用上下文的原生布局协议仅用于后续编译，不适用于本操作。',
    options.languageDirective ?? '学生可见文字使用简体中文。',
  ].join('\n'), JSON.stringify(context));
  const styleDiagnostics: string[] = [];
  const projection = projectionData(raw, styleDiagnostics);
  // The supplied source catalog exposes both evidence and passage identities.
  // Resolve a passage only when this page's adopted catalog gives it one owner.
  const passageEvidenceIds = new Map<string, string | null>();
  for (const source of original.originalSources) {
    for (const { sourceBlockId } of source.passages) {
      if (!sourceBlockId) continue;
      const owner = passageEvidenceIds.get(sourceBlockId);
      passageEvidenceIds.set(sourceBlockId, owner === undefined || owner === source.evidenceId
        ? source.evidenceId : null);
    }
  }
  for (const item of projection.items) {
    if (item.sourceEvidenceIds) item.sourceEvidenceIds = [...new Set(item.sourceEvidenceIds.map((id) =>
      evidenceIds.has(id) ? id : passageEvidenceIds.get(id) ?? id))];
  }
  const mappingDiagnostics = deterministicProjectionIssues(projection, sources, evidenceIds, outline.visualIntent?.diagram?.nodes);
  for (const item of projection.items) if (item.diagramNodeId && !outline.visualIntent?.diagram?.nodes.some((node) => node.id === item.diagramNodeId)) {
    mappingDiagnostics.push(`Unknown diagram node for ${item.id}`);
  }
  // One production model call. Existing source/quantity contracts only report
  // concrete structural failures; they never launch a judge or repair request.
  // A failed mapping retains every original display point for native compilation.
  const retainedDesign = mappingDiagnostics.length ? originalSpatialDesign(projection, sources) : undefined;
  return { projection: mappingDiagnostics.length
    ? { ...unchangedSlideProjection(sources), ...(retainedDesign ? { design: retainedDesign } : {}), verified: true }
    : { ...projection, verified: true }, diagnostics: [...styleDiagnostics, ...mappingDiagnostics] };
}

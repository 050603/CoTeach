import type { TeachingBlueprintPage, TeachingExplanationNode, TeachingPresentationItem } from '@/lib/session/types';

type PresentationSources = {
  nodes: readonly Pick<TeachingExplanationNode, 'id' | 'content' | 'knowledgePointIds'>[];
  allowedNodeIds: ReadonlySet<string>;
  confirmedLabelsByKnowledgePointId: ReadonlyMap<string, readonly string[]>;
};

export type TeachingContentPart = { id: string; text: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isAdoptedTeachingPage(page: TeachingBlueprintPage): boolean {
  const brief = page.teachingBrief;
  const plan = brief?.teachingPlan;
  const timing = page.plannedTiming;
  return Boolean(page.sectionPlanVersion && Array.isArray(page.sourcePageIds) && page.sourcePageIds.length
    && Array.isArray(page.unitIds) && page.unitIds.length && brief?.schemaVersion === 1
    && typeof brief.explanation === 'string' && brief.explanation.trim()
    && typeof plan?.newContent === 'string' && plan.newContent.trim()
    && Array.isArray(plan.visibleContent) && plan.visibleContent.length && timing?.role === 'teaching'
    && [timing.narrationSec, timing.learnerActivitySec, timing.transitionSec]
      .every((duration) => Number.isFinite(duration) && duration >= 0)
    && timing.narrationSec + timing.learnerActivitySec + timing.transitionSec > 0);
}

/** A measured split can leave a visual continuation without a new teaching
 * duty. It may cite the earlier executed sibling from the same source page;
 * this is display provenance, not newly assigned ownership or unit fallback. */
export function resolveAdoptedContinuationPresentationNodeIds(
  page: TeachingBlueprintPage,
  previousPages: readonly TeachingBlueprintPage[],
  nodes: readonly Pick<TeachingExplanationNode, 'id'>[],
): string[] {
  if (page.type !== 'slide' || !isAdoptedTeachingPage(page)
    || (page.introducesNodeIds?.length ?? 0) + (page.deepensNodeIds?.length ?? 0)
      + (page.referencesNodeIds?.length ?? 0) > 0) return [];
  const sourcePages = new Set(page.sourcePageIds);
  const unitIds = new Set(page.unitIds);
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const taughtBefore = new Set<string>();
  const result = new Set<string>();
  for (const prior of previousPages) {
    const introduced = (prior.introducesNodeIds ?? []).filter((id) => knownNodeIds.has(id));
    const deepened = (prior.deepensNodeIds ?? []).filter((id) => knownNodeIds.has(id) && taughtBefore.has(id));
    const priorUnitIds = new Set(prior.unitIds);
    if (isAdoptedTeachingPage(prior) && prior.sectionPlanVersion === page.sectionPlanVersion
      && prior.sourcePageIds?.some((id) => sourcePages.has(id))
      && priorUnitIds.size === unitIds.size && [...priorUnitIds].every((id) => unitIds.has(id))) {
      [...introduced, ...deepened].forEach((id) => result.add(id));
    }
    introduced.forEach((id) => taughtBefore.add(id));
  }
  return [...result];
}

const PRESENTATION_ROLES = new Set<TeachingPresentationItem['role']>([
  'heading', 'key-point', 'comparison', 'process-label', 'case-observation',
]);

function numberIdentity(value: string): string {
  if (/^[+-]?\d/u.test(value)) return String(Number(value));
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3,
    四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (digits[character] !== undefined) current = digits[character]!;
    else if (character === '十' || character === '百' || character === '千') {
      total += (current || 1) * ({ 十: 10, 百: 100, 千: 1000 }[character]);
      current = 0;
    } else return value;
  }
  return String(total + current);
}

function quantities(content: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const match of content.matchAll(/([+-]?\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千]+)\s*(毫米|厘米|千米|公里|米|分钟|小时|秒|千克|毫克|克|毫升|升|摄氏度|度|%|％|个|只|条|种|项|步|组|次|人)/gu)) {
    const unit = match[2]!.replace('％', '%');
    const isCount = /^(?:个|只|条|种|项|步|组|次|人)$/u.test(unit);
    // Ordered labels identify positions, not the cardinality of the framework.
    if (isCount && /第\s*$/u.test(content.slice(0, match.index))) continue;
    // A classifier alone does not identify the fact being counted: one
    // starting point and seven design stages are independent quantities.
    // Keep the actual noun phrase (including scope modifiers); do not borrow
    // a different object's number or collapse core and auxiliary components.
    const following = content.slice(match.index! + match[0].length).trimStart();
    const object = isCount ? (following.match(/^[\p{L}]+/u)?.[0]
      ?.split(/的|和|与|或|以及|并|是|为|在|用于|用来|构成|组成|出发|分别/u)[0]
      || (unit === '步' ? '流程' : unit)) : unit;
    const responsibility = `${isCount ? 'count' : 'measure'}:${object}`;
    const values = result.get(responsibility) ?? new Set<string>();
    values.add(numberIdentity(match[1]!));
    result.set(responsibility, values);
  }
  return result;
}

// These checks catch explicit factual edits while allowing independent slide
// language. They are deliberately limited to measurable quantities and close
// restatements; provenance and complete teaching remain separate contracts.
function presentationFactIssues(display: string, source: string): string[] {
  const issues: string[] = [];
  const originalQuantities = quantities(source);
  for (const [responsibility, values] of quantities(display)) {
    const originals = originalQuantities.get(responsibility);
    if (originals && [...values].some((value) => !originals.has(value))) {
      issues.push(`数量或单位 ${[...values].join('/')} ${responsibility.split(':')[1]} 与对应解释节点不一致`);
    }
  }
  const compact = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '');
  const negative = /不要求|不需要|无须|无需|不能|不得|没有|不是|不|未|无/u;
  const qualifiers = /根本|基本|通常|一般|可能/u;
  const skeleton = (value: string) => compact(value)
    .replace(/不要求|不需要|无须|无需|不能|不得|没有|不是|不|未|无|根本|基本|通常|一般|可能/gu, '');
  const sourceClauses = source.split(/[。；;！？!?，,：:｜|]/u).filter(Boolean);
  for (const clause of display.split(/[。；;！？!?，,：:｜|]/u).filter(Boolean)) {
    const displaySkeleton = skeleton(clause);
    if (displaySkeleton.length < 4) continue;
    // A short core proposition can still invert the fact. Match the entire
    // source clause for short statements so a shared term cannot borrow an
    // unrelated negation from a longer explanation or adjacent clause.
    const candidates = sourceClauses.filter((original) => displaySkeleton.length < 8
      ? skeleton(original) === displaySkeleton
      : skeleton(original).includes(displaySkeleton));
    if (!candidates.length) continue;
    if (candidates.every((original) => negative.test(original) !== negative.test(clause))) {
      issues.push('改变了对应解释中同一命题的否定关系');
    }
    for (const qualifier of ['根本', '基本', '通常', '一般', '可能']) {
      if (qualifiers.test(clause) && clause.includes(qualifier)) continue;
      if (candidates.every((original) => original.includes(qualifier))) {
        issues.push(`删去了对应解释中同一命题的“${qualifier}”限定`);
      }
    }
  }
  return issues;
}

/** v5 writes teaching and presentation in one authoring call. The reference
 * proves actual teaching ownership, never literal equality with its prose. */
export function compileTeachingPresentationItems(
  value: unknown,
  sources: Pick<PresentationSources, 'nodes' | 'allowedNodeIds'>,
  options: { qualityMode?: 'strict' | 'diagnostic' } = {},
): { keyPoints: string[]; presentationItems: TeachingPresentationItem[]; issues: string[] } {
  if (!Array.isArray(value) || !value.length) {
    return { keyPoints: [], presentationItems: [], issues: ['缺少 presentationItems；须独立撰写 PPT 展示文案并关联实际解释节点'] };
  }
  const nodeById = new Map(sources.nodes.map((node) => [node.id, node]));
  const presentationItems: TeachingPresentationItem[] = [];
  const issues: string[] = [];
  for (const [index, raw] of value.entries()) {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const content = text(item.text);
    const nodeIds = Array.isArray(item.nodeIds) ? [...new Set(item.nodeIds.map(text))] : [];
    const role = item.role as TeachingPresentationItem['role'];
    if (!content || !PRESENTATION_ROLES.has(role) || !nodeIds.length
      || nodeIds.some((id) => !id || !nodeById.has(id) || !sources.allowedNodeIds.has(id))) {
      issues.push(`第 ${index + 1} 项 presentationItems 缺少展示文字、有效角色或引用了本页未拥有、未实际承接的解释节点`);
      if (options.qualityMode !== 'diagnostic' || !content) continue;
    }
    const source = nodeIds.flatMap((id) => nodeById.get(id)?.content ?? []).join(' ');
    const facts = presentationFactIssues(content, source);
    if (facts.length) {
      issues.push(...facts.map((issue) => `第 ${index + 1} 项 presentationItems ${issue}`));
      if (options.qualityMode !== 'diagnostic') continue;
    }
    presentationItems.push({ text: content, nodeIds: nodeIds.filter((id) => Boolean(id)),
      role: PRESENTATION_ROLES.has(role) ? role : 'key-point' });
  }
  return { keyPoints: presentationItems.map((item) => item.text), presentationItems, issues };
}

/** Legacy v3/v4 explanations use stable spans, preserved verbatim when read. */
export function compileTeachingContentParts(value: unknown): {
  content: string; parts: TeachingContentPart[]; issues: string[];
} {
  if (!Array.isArray(value) || !value.length) {
    return { content: '', parts: [], issues: ['缺少 contentParts，完整解释须由实际内容片段组成'] };
  }
  const parts: TeachingContentPart[] = [];
  const issues: string[] = [];
  for (const [index, raw] of value.entries()) {
    const part = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const id = text(part.id);
    const content = text(part.text);
    if (!id || !content || parts.some((existing) => existing.id === id)) {
      issues.push(`第 ${index + 1} 个 contentParts 缺少稳定 id、实际 text 或局部 id 重复`);
      continue;
    }
    parts.push({ id, text: content });
  }
  return { content: parts.map((part) => part.text).join(' '), parts, issues };
}

export function resolveTeachingPagePartRefs(
  value: unknown,
  sources: Pick<PresentationSources, 'nodes' | 'allowedNodeIds'> & {
    contentPartsByNodeId: ReadonlyMap<string, readonly TeachingContentPart[]>;
  },
): { keyPoints: string[]; issues: string[] } {
  if (!Array.isArray(value) || !value.length) {
    return { keyPoints: [], issues: ['缺少 keyPointRefs；页面须选择实际解释中的内容片段编号'] };
  }
  const nodeIds = new Set(sources.nodes.map((node) => node.id));
  const keyPoints: string[] = [];
  const issues: string[] = [];
  for (const [index, raw] of value.entries()) {
    const ref = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const nodeId = text(ref.nodeId);
    const parts = sources.contentPartsByNodeId.get(nodeId);
    const requested = Array.isArray(ref.partIds) ? ref.partIds.map(text) : [];
    if (!parts || !nodeIds.has(nodeId) || !sources.allowedNodeIds.has(nodeId) || !requested.length
      || requested.some((id) => !id || !parts.some((part) => part.id === id))) {
      issues.push(`第 ${index + 1} 项 keyPointRefs 引用了本页未拥有、未明确承接的节点或不存在的 contentParts.id`);
      continue;
    }
    // Full explanation order is authoritative when several spans form one
    // point. A display cannot invert a condition and its original conclusion.
    const selected = new Set(requested);
    const point = parts.filter((part) => selected.has(part.id)).map((part) => part.text).join(' ');
    if (!keyPoints.includes(point)) keyPoints.push(point);
  }
  return { keyPoints, issues };
}

const CLOSING_MARK = /[”’"')）\]]/u;

function sentenceEndAt(content: string, index: number): boolean {
  const character = content[index];
  if (character && /[。！？!?]/u.test(character)) return true;
  // A decimal point is part of the quantity, never a sentence boundary.
  return character === '.' && !(/\d/u.test(content[index - 1] ?? '') && /\d/u.test(content[index + 1] ?? ''));
}

function completeLiteralSentences(content: string, quote: string): boolean {
  for (let offset = content.indexOf(quote); offset >= 0; offset = content.indexOf(quote, offset + 1)) {
    let before = offset - 1;
    while (before >= 0 && (/\s/u.test(content[before]!) || CLOSING_MARK.test(content[before]!))) before--;
    if (before >= 0 && !sentenceEndAt(content, before)) continue;
    let last = offset + quote.length - 1;
    while (last >= offset && (/\s/u.test(content[last]!) || CLOSING_MARK.test(content[last]!))) last--;
    let after = offset + quote.length;
    while (after < content.length && /\s/u.test(content[after]!)) after++;
    if (after === content.length || sentenceEndAt(content, last) || sentenceEndAt(content, after)) return true;
  }
  return false;
}

/** Compile display text from the same first-authored explanation, without a
 * second factual paraphrase or another model call. Legacy drafts use their
 * already accepted strings and do not pass through this authoring protocol. */
export function resolveTeachingPageKeyPointRefs(
  value: unknown,
  sources: PresentationSources,
): { keyPoints: string[]; issues: string[] } {
  if (!Array.isArray(value) || !value.length) {
    return { keyPoints: [], issues: ['缺少 keyPointRefs；上屏要点须引用实际解释节点中的完整句或教材规范条目名称'] };
  }
  const nodeById = new Map(sources.nodes.map((node) => [node.id, node]));
  const keyPoints: string[] = [];
  const issues: string[] = [];
  for (const [index, valueRef] of value.entries()) {
    const ref = valueRef && typeof valueRef === 'object' && !Array.isArray(valueRef)
      ? valueRef as Record<string, unknown> : {};
    const nodeId = text(ref.nodeId);
    const quote = text(ref.quote);
    const node = nodeById.get(nodeId);
    if (!quote || !node || !sources.allowedNodeIds.has(nodeId)) {
      issues.push(`第 ${index + 1} 项 keyPointRefs 缺少原句或引用了本页未拥有、未明确承接的解释节点`);
      continue;
    }
    const content = text(node.content);
    const literal = content.includes(quote);
    const confirmedLabel = (node.knowledgePointIds ?? []).some((id) =>
      sources.confirmedLabelsByKnowledgePointId.get(id)?.some((label) => text(label) === quote));
    if (!literal || (!confirmedLabel && !completeLiteralSentences(content, quote))) {
      issues.push(`第 ${index + 1} 项 keyPointRefs 不是对应节点中的完整原句或已确认教材条目名称；应在首次正文中写清精炼、完整的事实句再逐字引用`);
      continue;
    }
    if (!keyPoints.includes(quote)) keyPoints.push(quote);
  }
  return { keyPoints, issues };
}

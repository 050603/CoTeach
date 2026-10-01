/** Shared visible-content contract and measured, pre-authoring page capacity. */
import { createHash } from 'node:crypto';
import { measureDiagramAllocations, type DiagramAllocation, type TextMeasure, type TextMeasureInput } from '@openmaic/generation';
import type { TeachingExplanationNode, TeachingPresentationItem } from '@/lib/session/types';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { measureAuthoredSlideText, isSpatialMeasurementUnavailableError } from './slide-spatial-measurement';
import { compactSourceSequenceText, sourceSequenceLabelKey } from '@/lib/textbook/source-sequence-label';
import { hasReferenceLectureTypography, slideBodyFontSizes, slideTitleFontSizes } from './slide-presentation-typography';

export const SEMANTIC_PAGE_CAPACITY_VERSION = 'semantic-page-capacity-v2' as const;
const BODY = { width: 900, bottom: 512.5 } as const;
const TITLE = { width: 900, top: 50, height: 128 } as const;
const GAP = 12;
const VERTICAL_RESERVE = 10;

function normalizedClaim(value: string): string {
  return value.trim().toLowerCase()
    .replace(/(?:是指|指的是|意为|意味着)/g, '是')
    .replace(/(?:能够|可以|可用于|用来)/g, '可')
    .replace(/(?:以及|和|与)/g, '与')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function criticalParts(value: string): string[] {
  return [...value.matchAll(/(?:仅当|只有|必须|不得|不能|不包括|不|无|除非|至少|至多|如果|若|则|当|前提|条件|例外|并且|同时|需要|需|应|包含|包括|\d+(?:\.\d+)?%?)/g)]
    .map(([part]) => part).sort();
}

function bigrams(value: string): Set<string> {
  const chars = [...value];
  return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, index) => `${chars[index]}${char}`));
}

/** Conservative semantic repetition check: distinct conditions and quantities never collapse. */
export function equivalentVisibleClaim(left: string, right: string): boolean {
  const a = normalizedClaim(left), b = normalizedClaim(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (criticalParts(left).join('|') !== criticalParts(right).join('|')) return false;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))
    && Math.max(a.length, b.length) <= Math.min(a.length, b.length) * 1.2) return true;
  const aa = bigrams(a), bb = bigrams(b);
  const shared = [...aa].filter((part) => bb.has(part)).length;
  return Math.min(a.length, b.length) >= 8 && 2 * shared / (aa.size + bb.size) >= 0.76;
}

export type CanonicalVisibleContentInput = {
  /** Complete definitions, conditions, conclusions and other non-negotiable wording. */
  required?: readonly string[];
  /** Previously adopted on-screen content. */
  inherited?: readonly string[];
  /** Final design or enhancement suggestions. */
  proposed?: readonly string[];
};

/** Preserve full required claims while removing equivalent restatements and bare labels. */
export function canonicalVisibleContent(input: CanonicalVisibleContentInput): string[] {
  const result: Array<{ text: string; required: boolean }> = [];
  const append = (value: string, required: boolean) => {
    const text = value.trim();
    if (!text) return;
    const normalized = normalizedClaim(text);
    const contained = result.find((item) => normalizedClaim(item.text).includes(normalized)
      && normalized.length >= 4);
    if (contained) return;
    const superseded = result.findIndex((item) => !item.required && normalized.includes(normalizedClaim(item.text))
      && normalizedClaim(item.text).length >= 4);
    if (superseded >= 0) { result[superseded] = { text, required }; return; }
    const same = result.findIndex((item) => equivalentVisibleClaim(item.text, text));
    if (same < 0) { result.push({ text, required }); return; }
    const prior = result[same]!;
    if (prior.required) return;
    // A complete later statement replaces a concise label or paraphrase, at
    // the original reading position. A mandatory definition is never replaced.
    if (required || normalizedClaim(text).length > normalizedClaim(prior.text).length) {
      result[same] = { text, required };
    }
  };
  for (const text of input.required ?? []) append(text, true);
  for (const text of input.inherited ?? []) append(text, false);
  for (const text of input.proposed ?? []) append(text, false);
  return result.map((item) => item.text);
}

export type SemanticCapacityGroup = {
  id: string;
  kind: 'text' | 'table' | 'formula' | 'media' | 'diagram';
  visibleText: string;
  narrationExpansion: string[];
  sourcePageId: string;
  /** Actual introduces/deepens responsibility, distinct from display source references. */
  sourceNodeIds: string[];
  /** Already-established sources used by this display, never new ownership. */
  referencedNodeIds?: string[];
  /** Authored display responsibility survives bounded section redistribution. */
  presentationItems?: TeachingPresentationItem[];
  /** Directed teaching prerequisites; earlier pages may satisfy them. */
  prerequisiteNodeIds?: string[];
  knowledgePointIds: string[];
  resourceIds: string[];
  indivisibleWith: string[];
  sourceRegionIds?: string[];
  measuredHeight?: number;
  tableCells?: string[][];
  imageAspectRatio?: number;
  richTextHtml?: string;
  nonRichText?: string;
  sourceClaim?: { id: string; text: string; parts: string[]; partIndex: number; sourcePageId: string };
};

export type SemanticCapacityLayout = {
  kind: 'full-width' | 'two-column' | 'three-column' | 'media-side' | 'media-stacked' | 'semantic-units';
  bodyFontSize: number;
  columnWidths: number[];
  mediaWidth?: number;
  /** Original visuals may share a measured row instead of being stacked. */
  mediaColumnWidths?: number[];
  usedHeight: number;
  availableHeight: number;
  fits: boolean;
  /** Complete measured compositions; the page author must retain their grouping. */
  unitLayouts?: Array<{ unitId: string; groupIds: string[]; layout: SemanticCapacityLayout }>;
};

export type SemanticCapacityUnit = {
  id: string;
  groupIds: string[];
  /** The whole visual/observation or definition/condition is measured together. */
  layouts: SemanticCapacityLayout[];
  selectedLayout?: SemanticCapacityLayout;
  measuredHeight?: number;
};

export type SemanticPageCapacityAssessment = {
  schemaVersion: 1;
  planningVersion: typeof SEMANTIC_PAGE_CAPACITY_VERSION | 'semantic-page-capacity-v1';
  outlineId: string;
  sourcePageId: string;
  decision: 'fits' | 'optimize-layout' | 'page-overflow' | 'section-overload' | 'measurement-unavailable';
  reason: string;
  measurementMode: 'browser-renderer-fonts-v1' | 'provided-measure-v1' | 'unavailable';
  titleHeight?: number;
  groups: SemanticCapacityGroup[];
  units?: SemanticCapacityUnit[];
  layouts: SemanticCapacityLayout[];
  selectedLayout?: SemanticCapacityLayout;
};

export type SemanticPageCapacityOptions = {
  measure?: TextMeasure;
  sourcePageId?: string;
  explanationNodes?: readonly TeachingExplanationNode[];
  /** Immutable dimensions of source images selected for this generation. */
  resourceDimensions?: Readonly<Record<string, { width: number; height: number }>>;
  /** Canonical source steps; a page's reading instructions are not step names. */
  resourceSequences?: Readonly<Record<string, readonly { label: string }[]>>;
};

function stableGroupId(text: string): string {
  return `semantic-${createHash('sha256').update(normalizedClaim(text)).digest('hex').slice(0, 16)}`;
}

function ordinalNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = new Map([...'一二三四五六七八九'].map((digit, index) => [digit, index + 1]));
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    const left = tens ? digits.get(tens) : 1;
    const right = ones ? digits.get(ones) : 0;
    return left !== undefined && right !== undefined ? left * 10 + right : undefined;
  }
  return digits.get(value);
}

/** Only an explicitly numbered overview followed by the same ordered item
 * explanations supplies independently authored boundaries. Ordinary sentences,
 * definitions and their qualifications are never cut to make a page fit. */
function explicitTeachingListParts(text: string): string[] | undefined {
  const markers = [...text.matchAll(/(?:^|[；。\n])\s*(第([一二三四五六七八九十\d]+)(?:条|步|项|阶段)(?:要求|强调|建议|需要|应|要|是))/g)];
  if (markers.length < 2 || markers.length > 32
    || markers.some((match, index) => ordinalNumber(match[2]!) !== index + 1)) return undefined;
  const offsets = markers.map((match) => match.index + match[0].indexOf('第'));
  const overview = text.slice(0, offsets[0]);
  const numbered = [...overview.matchAll(/(?<![\d.])([1-9]\d?)[.、．](?!\d)/g)].map((match) => Number(match[1]));
  if (numbered.length !== markers.length || numbered.some((value, index) => value !== index + 1)) return undefined;
  const boundaries = [0, ...offsets, text.length];
  const parts = boundaries.slice(0, -1).map((start, index) => text.slice(start, boundaries[index + 1]!));
  return parts.every((part) => part.trim()) && parts.join('') === text ? parts : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function visibleRichText(html: string): string {
  return html.replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').trim();
}

function measurementInput(text: string, width: number, fontSize: number, bold = false, tableCell = false): TextMeasureInput {
  return { html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`, text, width,
    fontSize, fontWeight: bold ? 700 : 400, fontFamily: 'Noto Sans SC', padding: 10,
    lineHeight: tableCell ? 1 : 1.5, paragraphSpace: 5, align: 'left', tableCell,
    ...(tableCell ? { paddingCss: '6px 12px' } : {}),
  };
}

function mediaRatio(outline: SceneOutline, resourceId: string, dimensions?: SemanticPageCapacityOptions['resourceDimensions']): number {
  const source = dimensions?.[resourceId];
  if (source && Number.isFinite(source.width) && Number.isFinite(source.height) && source.width > 0 && source.height > 0) {
    return source.width / source.height;
  }
  const request = outline.mediaGenerations?.find((item) => item.elementId === resourceId);
  const ratio = request?.aspectRatio ?? '4:3';
  if (ratio === '16:9') return 16 / 9;
  if (ratio === '1:1') return 1;
  if (ratio === '9:16') return 9 / 16;
  return 4 / 3;
}

function authoredRegionConflict(outline: SceneOutline): boolean {
  const regions = outline.visualPlan?.regions ?? [];
  for (let left = 0; left < regions.length; left += 1) {
    for (let right = left + 1; right < regions.length; right += 1) {
      const a = regions[left]!, b = regions[right]!;
      if (a.parentRegionId === b.id || b.parentRegionId === a.id) continue;
      if (Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width)
        && Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height)) return true;
    }
  }
  return false;
}

function semanticGroups(outline: SceneOutline, sourcePageId: string, nodes: readonly TeachingExplanationNode[],
  resourceSequences?: SemanticPageCapacityOptions['resourceSequences']): SemanticCapacityGroup[] {
  const plan = outline.teachingBrief?.teachingPlan;
  const hasPresentationProjection = Boolean(plan?.presentationItems?.length || plan?.presentationContent?.length);
  const required = plan?.presentationItems?.length
    ? [...new Set(plan.presentationItems.map((item) => item.text.trim()).filter(Boolean))]
    : hasPresentationProjection
    ? canonicalVisibleContent({ proposed: plan!.presentationContent })
    : canonicalVisibleContent({ inherited: plan?.visibleContent, proposed: outline.keyPoints });
  const groups: SemanticCapacityGroup[] = [];
  const byUnit = new Map<string, SemanticCapacityGroup>();
  const regions = outline.visualPlan?.regions ?? [];
  const groupedRegionIds = new Map<string, string>();
  for (const region of regions) {
    const unitId = region.unitId || region.id;
    let group = byUnit.get(unitId);
    if (!group) {
      group = { id: `visual-${stableGroupId(`${sourcePageId}:${unitId}`)}`, kind: 'text', visibleText: '',
        narrationExpansion: [], sourcePageId, sourceNodeIds: [], knowledgePointIds: [], resourceIds: [], indivisibleWith: [], sourceRegionIds: [] };
      byUnit.set(unitId, group);
      groups.push(group);
    }
    groupedRegionIds.set(region.id, group.id);
    group.sourceRegionIds!.push(region.id);
    if (region.kind === 'table') group.kind = 'table';
    else if (region.kind === 'formula' && group.kind === 'text') group.kind = 'formula';
    else if (region.kind === 'image' && group.kind === 'text') group.kind = 'media';
    if (region.kind === 'table' && region.tableCells?.length) {
      group.tableCells = [...(group.tableCells ?? []), ...region.tableCells.map((row) => [...row])];
      if (!region.content.trim()) group.visibleText = [group.visibleText,
        ...region.tableCells.map((row) => row.join('｜'))].filter(Boolean).join('\n');
    }
    if (region.kind === 'image' && region.imageAspectRatio && region.imageAspectRatio > 0) group.imageAspectRatio = region.imageAspectRatio;
    if (region.kind === 'richtext' && region.content.trim()) {
      group.richTextHtml = [group.richTextHtml, region.content.trim()].filter(Boolean).join('<br>');
      group.visibleText = [group.visibleText, visibleRichText(region.content)].filter(Boolean).join('\n');
    } else if (region.content.trim() && region.kind !== 'image') {
      group.nonRichText = [group.nonRichText, region.content.trim()].filter(Boolean).join('\n');
      group.visibleText = [group.visibleText, region.content.trim()].filter(Boolean).join('\n');
    }
    group.knowledgePointIds.push(...region.knowledgePointIds.filter((id) => !group!.knowledgePointIds.includes(id)));
    if (region.mediaElementId && !group.resourceIds.includes(region.mediaElementId)) group.resourceIds.push(region.mediaElementId);
  }
  for (const relation of outline.visualPlan?.relations ?? []) {
    const from = groupedRegionIds.get(relation.from), to = groupedRegionIds.get(relation.to);
    if (!from || !to || from === to) continue;
    const left = groups.find((group) => group.id === from)!, right = groups.find((group) => group.id === to)!;
    if (!left.indivisibleWith.includes(to)) left.indivisibleWith.push(to);
    if (!right.indivisibleWith.includes(from)) right.indivisibleWith.push(from);
  }
  const coveredKeyPointIndexes = new Set(regions.flatMap((region) => region.keyPointIndexes));
  for (const text of required) {
    if (outline.visualIntent?.diagram?.annotation
      && normalizedClaim(text) === normalizedClaim(outline.visualIntent.diagram.annotation)) continue;
    if (outline.keyPoints.some((point, index) => coveredKeyPointIndexes.has(index) && equivalentVisibleClaim(point, text))) continue;
    if (groups.some((group) => normalizedClaim(group.visibleText) === normalizedClaim(text)
      || group.visibleText.split('\n').some((part) => equivalentVisibleClaim(part, text)))) continue;
    const preserved = outline.semanticSourceClaims?.find((claim) => claim.parts.some((part) => part.trim() === text));
    const parts = explicitTeachingListParts(text);
    const claim = preserved ?? (parts ? { id: stableGroupId(`${sourcePageId}:${text}`), sourcePageId, text, parts } : undefined);
    for (const part of parts ?? [text]) {
      const partIndex = claim?.parts.findIndex((item) => item.trim() === part.trim());
      groups.push({ id: stableGroupId(part), kind: 'text', visibleText: part, narrationExpansion: [],
        sourcePageId, sourceNodeIds: [], knowledgePointIds: [...(outline.knowledgePointIds ?? [])], resourceIds: [], indivisibleWith: [],
        ...(claim && partIndex !== undefined && partIndex >= 0 ? { sourceClaim: { ...claim, partIndex } } : {}) });
    }
  }
  {
    const references = outline.visualIntent?.resourceRefs ?? [];
    for (const ref of references.filter((item) => item.required
      && !groups.some((group) => group.resourceIds.includes(item.resourceId)))) {
      const unanchoredImage = groups.find((group) => group.kind === 'media' && !group.resourceIds.length);
      if (unanchoredImage) { unanchoredImage.resourceIds.push(ref.resourceId); continue; }
      groups.push({
      id: `resource-${ref.resourceId}`, kind: 'media', visibleText: '', narrationExpansion: [],
      sourcePageId, sourceNodeIds: [], knowledgePointIds: [...(outline.knowledgePointIds ?? [])],
      resourceIds: [ref.resourceId], indivisibleWith: [],
      });
    }
    if (outline.visualIntent?.diagram && !groups.some((group) => group.kind === 'diagram')) groups.push({
      // The compiler already measures this outside annotation as part of the
      // complete native diagram. It is its essential visible observation,
      // rather than an extra full-width body paragraph beside the diagram.
      id: `diagram-${stableGroupId(JSON.stringify(outline.visualIntent.diagram))}`, kind: 'diagram',
      visibleText: outline.visualIntent.diagram.annotation?.trim() ?? '',
      narrationExpansion: [], sourcePageId, sourceNodeIds: [], knowledgePointIds: [...(outline.knowledgePointIds ?? [])],
      resourceIds: [], indivisibleWith: [],
    });
  }
  if (!groups.length) groups.push({ id: stableGroupId(outline.description || outline.title), kind: 'text',
    visibleText: outline.description || outline.title, narrationExpansion: [], sourcePageId,
    sourceNodeIds: [], knowledgePointIds: [...(outline.knowledgePointIds ?? [])], resourceIds: [], indivisibleWith: [] });
  const ownerNodeIds = new Set([
    ...(outline.teachingBrief?.teachingPlan?.introduces ?? []),
    ...(outline.teachingBrief?.teachingPlan?.deepens ?? []),
  ]);
  // An explicit empty responsibility list means this continuation owns no
  // explanation node. Never turn it into a reference to the entire course.
  const explicitOwnership = plan && (Array.isArray(plan.introduces) || Array.isArray(plan.deepens));
  const ownedNodes = explicitOwnership ? nodes.filter((node) => ownerNodeIds.has(node.id)) : nodes;
  const relationship = plan?.visualRelationship;
  const requiredReferences = outline.visualIntent?.resourceRefs?.filter((ref) => ref.required) ?? [];
  const requiredSourceFigures = requiredReferences.filter((reference) => reference.kind === 'source-image');
  const sourceFigure = requiredSourceFigures.length === 1 ? requiredSourceFigures[0] : undefined;
  const sourceSteps = sourceFigure ? resourceSequences?.[sourceFigure.resourceId] : undefined;
  const sequenceLabels = sourceSteps?.length
    ? sourceSteps.map((step) => sourceSequenceLabelKey(step.label))
    : relationship && ['sequence', 'process'].includes(relationship.kind)
      ? relationship.readingOrder.map(normalizedClaim).filter(Boolean) : [];
  const hasWholeSequence = (text: string): boolean => {
    if (sequenceLabels.length < 2 || new Set(sequenceLabels).size !== sequenceLabels.length) return false;
    const normalized = sourceSteps?.length ? compactSourceSequenceText(text) : normalizedClaim(text);
    let cursor = 0;
    for (const label of sequenceLabels) {
      const index = normalized.indexOf(label, cursor);
      if (index < 0) return false;
      cursor = index + label.length;
    }
    return true;
  };
  // A direct original figure and its complete already-adopted flow statement
  // are one observation. Do not replace that statement with a generic caption
  // or infer a multi-image/source scope from shared knowledge-point IDs.
  const wholeSequenceGroups = groups.filter((group) => (group.kind === 'text' || group.kind === 'diagram')
    && hasWholeSequence(group.visibleText));
  // A source figure beside prose or a comparison is legitimately "mixed".
  // Its real resource identity and complete ordered statement own the anchor;
  // a display preference cannot turn that statement into a second caption.
  const directSourceFigure = Boolean(sourceFigure) && !outline.visualIntent?.diagram && !relationship?.diagram;
  // A second native flow cannot cancel the original figure's canonical source
  // identity. Legacy reading instructions alone cannot identify that source
  // when another diagram is present.
  const sourceFlowAnchor = sourceFigure && (sourceSteps?.length || directSourceFigure) && wholeSequenceGroups.length === 1
    ? wholeSequenceGroups[0] : undefined;
  const wholeSequenceNodes = sourceFlowAnchor ? ownedNodes.filter((node) => hasWholeSequence(node.content)) : [];
  const pinnedNode = wholeSequenceNodes.length === 1 ? wholeSequenceNodes[0] : undefined;
  const pinnedNarration = pinnedNode && sourceFlowAnchor ? new Map([[pinnedNode.content, sourceFlowAnchor]]) : new Map<string, SemanticCapacityGroup>();
  // The compiled page also runs without the global node catalog. Its adopted
  // full flow paragraph must travel with the same overview and original image,
  // rather than a lexically similar individual step on another continuation.
  const adoptedFlowParagraphs = sourceFlowAnchor ? [...new Set([
    ...(plan?.narrationFocus ?? []),
    ...(plan?.visibleContent ?? []),
    ...(outline.teachingBrief?.explanation.split('\n') ?? []),
  ].map((text) => text.trim()).filter((text) => hasWholeSequence(text)
    && !sourceFlowAnchor.visibleText.split('\n').some((part) => equivalentVisibleClaim(part, text))))] : [];
  if (sourceFlowAnchor && adoptedFlowParagraphs.length === 1 && wholeSequenceNodes.length <= 1) {
    pinnedNarration.set(adoptedFlowParagraphs[0]!, sourceFlowAnchor);
  }
  const explicitlyPresentedNodeIds = new Set(plan?.presentationItems?.flatMap((item) => item.nodeIds) ?? []);
  for (const group of groups) {
    const parts = group.visibleText.split('\n').filter(Boolean);
    const items = plan?.presentationItems?.filter((item) => {
      const itemParts = item.text.split('\n').map(normalizedClaim).filter(Boolean);
      return itemParts.length > 0 && parts.some((_, start) => itemParts.every((part, index) =>
        part === normalizedClaim(parts[start + index] ?? '')));
    }) ?? [];
    if (items.length) group.presentationItems = items.map((item) => ({ ...item, nodeIds: [...item.nodeIds] }));
    const displayNodeIds = [...new Set(items.flatMap((item) => item.nodeIds))];
    if (explicitOwnership && displayNodeIds.some((id) => !ownerNodeIds.has(id))) {
      group.referencedNodeIds = displayNodeIds.filter((id) => !ownerNodeIds.has(id));
    }
    const explicitNodeIds = new Set(items.flatMap((item) => item.nodeIds)
      .filter((id) => !explicitOwnership || ownerNodeIds.has(id)));
    const matching = ownedNodes.filter((node) => node === pinnedNode
      ? group === sourceFlowAnchor
      : explicitlyPresentedNodeIds.has(node.id) ? explicitNodeIds.has(node.id)
        : [node.content, ...(explicitTeachingListParts(node.content) ?? [])]
        .some((content) => parts.some((part) => equivalentVisibleClaim(content, part))));
    group.sourceNodeIds = [...new Set([...explicitNodeIds, ...matching.map((node) => node.id)])];
    for (const node of matching) {
      group.knowledgePointIds.push(...(node.knowledgePointIds ?? []).filter((id) => !group.knowledgePointIds.includes(id)));
    }
  }
  if (pinnedNode && sourceFlowAnchor && !sourceFlowAnchor.visibleText.split('\n').includes(pinnedNode.content)) {
    sourceFlowAnchor.narrationExpansion.push(pinnedNode.content);
  }
  const textGroups = groups.filter((group) => group.visibleText.trim());
  const closest = (text: string, candidates: readonly SemanticCapacityGroup[]): SemanticCapacityGroup | undefined => {
    const target = bigrams(normalizedClaim(text));
    return [...candidates].sort((left, right) => {
      const score = (group: SemanticCapacityGroup) => [...bigrams(normalizedClaim(group.visibleText))]
        .filter((part) => target.has(part)).length;
      return score(right) - score(left);
    })[0];
  };
  const unmatchedNodes = ownedNodes.filter((item) => !groups.some((group) => group.sourceNodeIds.includes(item.id)));
  const pendingNodeIds = new Set(unmatchedNodes.map((node) => node.id));
  const orderedUnmatched: typeof unmatchedNodes = [];
  while (pendingNodeIds.size) {
    const ready = unmatchedNodes.find((node) => pendingNodeIds.has(node.id)
      && node.prerequisiteNodeIds.every((id) => !pendingNodeIds.has(id)));
    // A malformed cycle is left to the unchanged blueprint source gate;
    // capacity must not fabricate a teaching order for it.
    if (!ready) { orderedUnmatched.push(...unmatchedNodes.filter((node) => pendingNodeIds.has(node.id))); break; }
    orderedUnmatched.push(ready);
    pendingNodeIds.delete(ready.id);
  }
  for (const node of orderedUnmatched) {
    const byKnowledge = textGroups.filter((group) => (node.knowledgePointIds ?? [])
      .some((id) => group.knowledgePointIds.includes(id)));
    const candidates = byKnowledge.length ? byKnowledge : textGroups;
    const prerequisiteEnd = Math.max(-1, ...groups.flatMap((group, index) =>
      group.sourceNodeIds.some((id) => node.prerequisiteNodeIds.includes(id)) ? [index] : []));
    // Oral-only examples and explanations have no authored on-screen anchor.
    // Respect their actual prerequisites before using lexical similarity:
    // resemblance to an early definition cannot bring a later case forward.
    const afterPrerequisites = candidates.filter((group) => groups.indexOf(group) >= prerequisiteEnd);
    const eligible = afterPrerequisites.length ? afterPrerequisites : candidates;
    const group = closest(node.content, eligible);
    if (!group) continue;
    group.sourceNodeIds.push(node.id);
    for (const content of explicitTeachingListParts(node.content) ?? [node.content]) {
      const destination = explicitTeachingListParts(node.content) ? closest(content, eligible) ?? group : group;
      if (!destination.visibleText.split('\n').some((part) => equivalentVisibleClaim(part, content))) {
        destination.narrationExpansion.push(content);
      }
    }
  }
  const groupByNode = new Map<string, SemanticCapacityGroup>();
  for (const group of groups) for (const nodeId of group.sourceNodeIds) {
    if (!groupByNode.has(nodeId)) groupByNode.set(nodeId, group);
  }
  for (const node of ownedNodes) {
    const anchor = groupByNode.get(node.id);
    // Explicit ordinal source claims may be taught across an introduces page
    // and its deepens continuations. Ordinary prose must travel in full with
    // the actual responsible node, not a lexical match on another page.
    if (!anchor || explicitTeachingListParts(node.content)) continue;
    pinnedNarration.set(node.content, anchor);
    for (const group of groups) if (group !== anchor) {
      group.narrationExpansion = group.narrationExpansion.filter((text) => text !== node.content);
    }
    if (!anchor.visibleText.split('\n').includes(node.content) && !anchor.narrationExpansion.includes(node.content)) {
      anchor.narrationExpansion.push(node.content);
    }
  }
  for (const node of ownedNodes) {
    const group = groupByNode.get(node.id);
    if (!group) continue;
    group.prerequisiteNodeIds = [...new Set([...(group.prerequisiteNodeIds ?? []), ...node.prerequisiteNodeIds])];
    for (const prerequisiteId of node.prerequisiteNodeIds) {
      // A source list developed over several groups is established only
      // after its last actual part, not merely its first introduces ID.
      const prerequisite = groups.findLast((candidate) => candidate.sourceNodeIds.includes(prerequisiteId));
      // A prerequisite is a teaching-order obligation, not a same-slide
      // visual relationship. Only a backward assignment must remain on one
      // page so that redistribution cannot introduce its dependent first.
      if (!prerequisite || groups.indexOf(prerequisite) <= groups.indexOf(group)) continue;
      if (!group.indivisibleWith.includes(prerequisite.id)) group.indivisibleWith.push(prerequisite.id);
      if (!prerequisite.indivisibleWith.includes(group.id)) prerequisite.indivisibleWith.push(group.id);
    }
  }
  for (const focus of [...(plan?.narrationFocus ?? []),
    ...(hasPresentationProjection ? plan?.visibleContent ?? [] : [])]
    .flatMap((text) => explicitTeachingListParts(text) ?? [text])) {
    const group = pinnedNarration.get(focus) ?? closest(focus, textGroups);
    if (group && !group.narrationExpansion.includes(focus)) group.narrationExpansion.push(focus);
  }
  for (const expansion of outline.teachingBrief?.explanation.split('\n').flatMap((text) => explicitTeachingListParts(text) ?? [text])
    .map((text) => text.trim()).filter(Boolean) ?? []) {
    const group = pinnedNarration.get(expansion) ?? closest(expansion, textGroups);
    if (group && !group.narrationExpansion.includes(expansion)
      && !group.visibleText.split('\n').some((part) => equivalentVisibleClaim(part, expansion))) {
      group.narrationExpansion.push(expansion);
    }
  }
  // Non-sequence textbook originals belong to the first actual concept
  // teaching responsibility, matching source binding. A generic observation
  // caption is not a substitute for that complete explanation. Sequence
  // figures still require the unique complete ordered anchor above.
  const firstConcept = ownedNodes.find((node) => ['concept', 'term'].includes(node.kind)
    && (plan?.introduces ?? []).includes(node.id));
  const sourceConceptAnchor = (!relationship || !['sequence', 'process'].includes(relationship.kind)) && firstConcept
    && directSourceFigure ? groupByNode.get(firstConcept.id) : undefined;
  const sourceImageAnchor = sourceFlowAnchor ?? sourceConceptAnchor;
  // A required picture or diagram is useful only with the statement students
  // must observe in it. Keep that statement on the same continuation page.
  for (const visual of groups.filter((group) => group.kind === 'media' || group.kind === 'diagram')) {
    if (!textGroups.length || visual.visibleText.trim() && !hasReferenceLectureTypography(outline)) continue;
    const authoredTextGroups = textGroups.filter((group) => group !== visual && group.presentationItems?.length);
    if (hasReferenceLectureTypography(outline) && visual.kind === 'diagram' && authoredTextGroups.length) {
      // The annotation is measured inside the complete diagram. Keep an
      // already-authored, source-backed display item beside it, rather than
      // letting a visual-only continuation lose its actual node references.
      const labels = outline.visualIntent?.diagram?.nodes.map((node) => normalizedClaim(node.label)).filter(Boolean) ?? [];
      const scopedNodeIds = new Set(plan?.presentationItems?.flatMap((item) => item.nodeIds) ?? []);
      const diagramSourceIds = new Set(nodes.filter((node) => scopedNodeIds.has(node.id)
        && labels.length && labels.every((label) => normalizedClaim(node.content).includes(label))).map((node) => node.id));
      const sourced = authoredTextGroups.filter((group) => group.presentationItems!.some((item) =>
        item.nodeIds.some((id) => diagramSourceIds.has(id))));
      const nonHeading = (sourced.length ? sourced : authoredTextGroups).filter((group) =>
        group.presentationItems!.some((item) => item.role !== 'heading'));
      const observation = closest(visual.visibleText || outline.visualIntent?.observationGoal || outline.title,
        nonHeading.length ? nonHeading : sourced.length ? sourced : authoredTextGroups);
      if (observation) {
        visual.indivisibleWith.push(observation.id);
        if (!observation.indivisibleWith.includes(visual.id)) observation.indivisibleWith.push(visual.id);
        continue;
      }
    }
    const reference = outline.visualIntent?.resourceRefs?.find((item) => visual.resourceIds.includes(item.resourceId));
    // Selection reasons explain an author's media choice, not an observable
    // fact. Only the separately authored observation can become a caption.
    const resourceCue = reference?.observationGoal;
    // Historical source references include an operational provenance message.
    // Use the actual teaching observation supplied by the page in that case.
    const cue = visual.kind === 'diagram' ? outline.visualIntent?.observationGoal
      : resourceCue && !/^知识点首次完整讲解必须使用的教材原图/.test(resourceCue)
        ? resourceCue : outline.visualIntent?.observationGoal;
    let observations = sourceImageAnchor && sourceFigure && visual.resourceIds.includes(sourceFigure.resourceId)
      ? [sourceImageAnchor]
      : [];
    if (!observations.length && hasReferenceLectureTypography(outline)) {
      // These observations were independently written and source-checked for
      // this exact page. The old long selection cue is not a second display
      // responsibility just because its wording differs from that catalog.
      observations = authoredTextGroups.filter((group) => group.presentationItems!.some((item) => item.role === 'case-observation'));
    }
    if (!observations.length && cue?.trim()) {
      // A page observation may concatenate several already adopted claims.
      // Keep those exact claims and their order instead of measuring them again
      // as an extra caption. Distinct conditions or added words still need one.
      const target = normalizedClaim(cue);
      for (let start = 0; start < textGroups.length && !observations.length; start += 1) {
        let combined = '';
        for (let end = start; end < textGroups.length; end += 1) {
          combined += normalizedClaim(textGroups[end]!.visibleText);
          if (combined === target) { observations = textGroups.slice(start, end + 1); break; }
          if (!target.startsWith(combined)) break;
        }
      }
    }
    if (!observations.length && cue) observations = textGroups.filter((group) => group.visibleText.split('\n')
      .some((part) => equivalentVisibleClaim(part, cue)));
    if (!observations.length && cue?.trim()) {
      const observation: SemanticCapacityGroup = { id: stableGroupId(cue), kind: 'text', visibleText: cue.trim(), narrationExpansion: [],
        sourcePageId, sourceNodeIds: [], knowledgePointIds: [...visual.knowledgePointIds], resourceIds: [], indivisibleWith: [] };
      groups.push(observation);
      textGroups.push(observation);
      observations = [observation];
    }
    if (!observations.length) {
      const observation = closest(outline.description, textGroups);
      if (observation) observations = [observation];
    }
    for (const observation of observations) {
      if (!visual.indivisibleWith.includes(observation.id)) visual.indivisibleWith.push(observation.id);
      if (!observation.indivisibleWith.includes(visual.id)) observation.indivisibleWith.push(visual.id);
    }
  }
  // Outline-only media has no authored reading position. Place it immediately
  // beside its observation, without changing the order of any teaching claim.
  // Otherwise an end-of-page image links an entire intervening lesson by span.
  if (!regions.length) {
    const adjacent = new Map<string, SemanticCapacityGroup[]>();
    const movable = new Set<string>();
    for (const visual of groups.filter((group) => (!group.visibleText.trim() || hasReferenceLectureTypography(outline))
      && (group.kind === 'media' || group.kind === 'diagram'))) {
      const linked = groups.filter((group) => visual.indivisibleWith.includes(group.id) && group.kind !== 'media' && group.kind !== 'diagram');
      if (!linked.length) continue;
      const anchor = linked.at(-1)!.id;
      adjacent.set(anchor, [...(adjacent.get(anchor) ?? []), visual]);
      movable.add(visual.id);
    }
    return groups.filter((group) => !movable.has(group.id))
      .flatMap((group) => [group, ...(adjacent.get(group.id) ?? [])]);
  }
  return groups;
}

async function measureTextHeight(text: string, width: number, font: number, measure: TextMeasure, bold = false): Promise<number> {
  return (await measure(measurementInput(text, width, font, bold))).height;
}

async function measureGroupHeight(group: SemanticCapacityGroup, width: number, font: number, measure: TextMeasure): Promise<number> {
  const heading = Boolean(group.presentationItems?.length && group.presentationItems.every((item) => item.role === 'heading'));
  const parts: number[] = [];
  if (group.richTextHtml) {
    const spec = measurementInput(visibleRichText(group.richTextHtml), width, font);
    parts.push((await measure({ ...spec, html: group.richTextHtml, preserveRichText: true })).height);
  }
  if (group.nonRichText) parts.push(await measureTextHeight(group.nonRichText, width, font, measure, heading));
  if (!group.tableCells?.length) {
    if (!parts.length) return measureTextHeight(group.visibleText, width, font, measure, heading);
    return parts.reduce((sum, height) => sum + height, 0) + GAP * (parts.length - 1);
  }
  const tableFont = Math.min(20, font);
  let tableHeight = 0;
  for (const row of group.tableCells) {
    const cellWidth = width / Math.max(1, row.length);
    const cells = await Promise.all(row.map((cell) => measure(measurementInput(cell, cellWidth, tableFont, false, true))));
    tableHeight += Math.max(0, ...cells.map((cell) => cell.height));
  }
  parts.push(tableHeight);
  return parts.reduce((sum, height) => sum + height, 0) + GAP * (parts.length - 1);
}

function indivisibleTextBlocks(groups: readonly SemanticCapacityGroup[]): SemanticCapacityGroup[][] {
  const byId = new Map(groups.map((group, index) => [group.id, index] as const));
  const parent = groups.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]!));
  groups.forEach((group, index) => {
    for (const linked of group.indivisibleWith) {
      const other = byId.get(linked);
      if (other !== undefined) parent[root(other)] = root(index);
    }
  });
  const memberships = new Map<number, SemanticCapacityGroup[]>();
  groups.forEach((group, index) => {
    const key = root(index);
    memberships.set(key, [...(memberships.get(key) ?? []), group]);
  });
  const blocks = [...memberships.values()];
  blocks.sort((left, right) => groups.indexOf(left[0]!) - groups.indexOf(right[0]!));
  return blocks;
}

function isHeading(group: SemanticCapacityGroup): boolean {
  return Boolean(group.presentationItems?.length && group.presentationItems.every((item) => item.role === 'heading'));
}

/** Same editable paragraphs, padding and spacing as the native text compiler.
 * A catalog item is a semantic claim, not an obligation to add another padded
 * box. Tables, formulas, authored rich text and heading emphasis stay separate. */
async function groupedColumnHeight(groups: readonly SemanticCapacityGroup[], width: number, font: number, measure: TextMeasure): Promise<number> {
  const heights: number[] = [];
  for (let start = 0; start < groups.length;) {
    const first = groups[start]!;
    const canGroup = (group: SemanticCapacityGroup) => group.kind === 'text'
      && !group.richTextHtml && !group.tableCells?.length && !isHeading(group);
    if (!canGroup(first)) {
      heights.push(await measureGroupHeight(first, width, font, measure));
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < groups.length && canGroup(groups[end]!)) end += 1;
    const paragraphs = groups.slice(start, end).map((group) => group.visibleText);
    const input = measurementInput(paragraphs.join('\n\n'), width, font);
    const paragraphStyle = `font-size:${font}px;font-weight:400;text-align:left`;
    heights.push((await measure({ ...input, html: paragraphs.map((text) =>
      `<p style="${paragraphStyle}">${escapeHtml(text).replace(/\r\n?|\n/g, '<br>')}</p>`).join('') })).height);
    start = end;
  }
  return heights.reduce((sum, height) => sum + height, 0) + GAP * Math.max(0, heights.length - 1);
}

async function packedTextHeight(blocks: readonly SemanticCapacityGroup[][], widths: readonly number[], font: number, measure: TextMeasure,
  groupParagraphs = false): Promise<number> {
  if (!blocks.length) return 0;
  if (groupParagraphs) {
    if (!widths.length) return Infinity;
    if (widths.length === 1) return groupedColumnHeight(blocks.flat(), widths[0]!, font, measure);
    // Authored headings span the composition, as they do in native feasibility
    // candidates. Content below each heading may use contiguous columns.
    const headingIndex = blocks.findIndex((block) => block.length === 1 && isHeading(block[0]!));
    if (headingIndex >= 0) {
      const before = blocks.slice(0, headingIndex), after = blocks.slice(headingIndex + 1);
      const bands = [
        ...(before.length ? [await packedTextHeight(before, widths, font, measure, true)] : []),
        await measureGroupHeight(blocks[headingIndex]![0]!, BODY.width, font, measure),
        ...(after.length ? [await packedTextHeight(after, widths, font, measure, true)] : []),
      ];
      return bands.reduce((sum, height) => sum + height, 0) + GAP * (bands.length - 1);
    }
    const memo = new Map<string, Promise<number>>();
    const solve = (start: number, column: number): Promise<number> => {
      if (column === widths.length) return Promise.resolve(start === blocks.length ? 0 : Infinity);
      const key = `${start}:${column}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = Promise.all(Array.from({ length: blocks.length - start + 1 }, async (_, offset) => {
          const end = start + offset;
          const used = await groupedColumnHeight(blocks.slice(start, end).flat(), widths[column]!, font, measure);
          return Math.max(used, await solve(end, column + 1));
        })).then((heights) => Math.min(...heights));
        memo.set(key, pending);
      }
      return pending;
    };
    return solve(0, 0);
  }
  const blockHeight = async (block: SemanticCapacityGroup[], width: number) => {
    const heights = await Promise.all(block.map((group) => measureGroupHeight(group, width, font, measure)));
    return heights.reduce((sum, height) => sum + height, 0) + GAP * (heights.length - 1);
  };
  if (widths.length === 1) {
    const heights = await Promise.all(blocks.map((block) => blockHeight(block, widths[0]!)));
    return heights.reduce((sum, height) => sum + height, 0) + GAP * (heights.length - 1);
  }
  // Preserve reading order: columns receive contiguous teaching groups.
  const heights = await Promise.all(blocks.map((block) => Promise.all(widths.map((width) => blockHeight(block, width)))));
  const memo = new Map<string, number>();
  const solve = (start: number, column: number): number => {
    if (column === widths.length) return start === blocks.length ? 0 : Number.POSITIVE_INFINITY;
    const key = `${start}:${column}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let used = 0, best = Number.POSITIVE_INFINITY;
    for (let end = start; end <= blocks.length; end += 1) {
      if (end > start) used += heights[end - 1]![column]! + (end > start + 1 ? GAP : 0);
      best = Math.min(best, Math.max(used, solve(end, column + 1)));
    }
    memo.set(key, best);
    return best;
  };
  return solve(0, 0);
}

function mediaFootprint(outline: SceneOutline, groups: readonly SemanticCapacityGroup[], width: number, diagramAllocations: readonly DiagramAllocation[], dimensions?: SemanticPageCapacityOptions['resourceDimensions'], columnWidths?: readonly number[]): number {
  let used = 0;
  for (const [index, group] of groups.entries()) {
    const groupWidth = columnWidths?.[index] ?? width;
    let height: number;
    if (group.kind === 'diagram' && outline.visualIntent?.diagram) {
      const feasible = diagramAllocations.filter((item) => item.width <= groupWidth + 0.001);
      height = feasible.length ? Math.min(...feasible.map((item) => item.height)) : Infinity;
    } else {
      const ratios = group.resourceIds.map((id) => mediaRatio(outline, id, dimensions));
      height = groupWidth / (group.imageAspectRatio ?? (ratios.length ? Math.min(...ratios) : 4 / 3));
    }
    used = columnWidths ? Math.max(used, height) : used + height + GAP;
  }
  return Math.max(0, columnWidths ? used : used - GAP);
}

/** Preserve claim order as well as explicit same-page dependencies. */
function indivisibleGroupSpans(groups: readonly SemanticCapacityGroup[]): SemanticCapacityGroup[][] {
  const byId = new Map(groups.map((group, index) => [group.id, index]));
  const spans = groups.map((group, index) => {
    const linked = group.indivisibleWith.flatMap((id) => byId.get(id) ?? []);
    return { start: Math.min(index, ...linked), end: Math.max(index, ...linked) };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const prior = merged.at(-1);
    if (prior && span.start <= prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  return merged.map(({ start, end }) => groups.slice(start, end + 1));
}

function selectedSemanticLayout(
  outline: SceneOutline, groups: readonly SemanticCapacityGroup[], layouts: readonly SemanticCapacityLayout[],
): SemanticCapacityLayout | undefined {
  const feasible = layouts.filter((layout) => layout.fits);
  if (!hasReferenceLectureTypography(outline)) return feasible[0];
  const relationship = outline.teachingBrief?.teachingPlan?.visualRelationship;
  const visible = groups.filter((group) => group.visibleText.trim() && group.kind !== 'diagram');
  const hasVisuals = groups.some((group) => group.kind === 'media' || group.kind === 'diagram');
  const hasTable = groups.some((group) => group.kind === 'table');
  const items = groups.flatMap((group) => group.presentationItems ?? []);
  const comparisons = items.filter((item) => item.role === 'comparison');
  const steps = items.filter((item) => item.role === 'process-label');
  const isComparison = relationship?.kind === 'comparison' || comparisons.length > 1;
  const isProcess = relationship && ['sequence', 'process'].includes(relationship.kind);
  let preference: SemanticCapacityLayout['kind'][];
  if (hasVisuals) preference = visible.length
    ? ['media-side', 'semantic-units', 'media-stacked'] : ['media-side', 'semantic-units'];
  else if (hasTable) preference = ['full-width', 'semantic-units', 'two-column', 'three-column'];
  else if (isComparison) preference = comparisons.length === 3
    ? ['three-column', 'two-column', 'full-width', 'semantic-units']
    : ['two-column', 'three-column', 'full-width', 'semantic-units'];
  else if (isProcess) preference = steps.length === 2 || steps.length === 3
    ? [steps.length === 2 ? 'two-column' : 'three-column', 'full-width', 'semantic-units']
    : ['full-width', 'semantic-units', 'two-column', 'three-column'];
  else preference = visible.length > 1
    ? ['two-column', 'full-width', 'three-column', 'semantic-units']
    : ['full-width', 'semantic-units', 'two-column', 'three-column'];
  const [bodyFont] = slideBodyFontSizes(outline);
  const rank = (layout: SemanticCapacityLayout) => {
    const index = preference.indexOf(layout.kind);
    return index < 0 ? preference.length : index;
  };
  // Prefer a relationship-appropriate construction. Ordinary and compact
  // fonts are pre-authoring choices within that construction, not repairs.
  return feasible.sort((left, right) => rank(left) - rank(right)
    || Math.abs(left.bodyFontSize - bodyFont) - Math.abs(right.bodyFontSize - bodyFont)
    || (hasVisuals ? Math.abs((left.mediaWidth ?? 440) - 440) - Math.abs((right.mediaWidth ?? 440) - 440) : 0))[0];
}

async function measureSemanticUnits(
  outline: SceneOutline, groups: readonly SemanticCapacityGroup[], availableHeight: number,
  diagramAllocations: readonly DiagramAllocation[], measure: TextMeasure, dimensions?: SemanticPageCapacityOptions['resourceDimensions'],
): Promise<SemanticCapacityUnit[]> {
  return Promise.all(indivisibleGroupSpans(groups).map(async (members) => {
    const id = stableGroupId(`${outline.id}:${members.map((group) => group.id).join(':')}`);
    const text = members.filter((group) => group.kind !== 'diagram'
      && (group.visibleText.trim() || group.tableCells?.length));
    const visuals = members.filter((group) => group.kind === 'media' || group.kind === 'diagram');
    const layouts: SemanticCapacityLayout[] = [];
    const add = async (kind: SemanticCapacityLayout['kind'], widths: number[], font: number, visualWidth?: number, mediaColumnWidths?: number[]) => {
      const textHeight = await packedTextHeight(indivisibleTextBlocks(text), widths, font, measure, hasReferenceLectureTypography(outline));
      const visualHeight = visuals.length ? mediaFootprint(outline, visuals, visualWidth ?? BODY.width, diagramAllocations, dimensions, mediaColumnWidths) : 0;
      const usedHeight = kind === 'media-stacked' && textHeight && visualHeight
        ? textHeight + visualHeight + GAP : Math.max(textHeight, visualHeight);
      if (!Number.isFinite(usedHeight)) return;
      layouts.push({ kind, columnWidths: widths, bodyFontSize: font, usedHeight, availableHeight,
        ...(visualWidth ? { mediaWidth: visualWidth } : {}), ...(mediaColumnWidths ? { mediaColumnWidths } : {}),
        fits: usedHeight <= availableHeight });
    };
    for (const font of slideBodyFontSizes(outline)) {
      if (!visuals.length) {
        await add('full-width', [BODY.width], font);
        // Related conditions and comparison sides may share columns, but the
        // whole semantic unit still stays on the same page.
        if (text.length > 1) {
          for (const widths of [[444, 444], [292, 292, 292]]) {
            const heights = await Promise.all(text.map((group) => Promise.all(widths.map((width) => measureGroupHeight(group, width, font, measure)))));
            const maxHeight = Math.max(...heights.map((row) => Math.min(...row)));
            if (maxHeight > availableHeight) continue;
            // Reuse ordered packing without making same-page links imply the
            // additional, stronger constraint of occupying the same column.
            const usedHeight = await packedTextHeight(text.map((group) => [group]), widths, font, measure, hasReferenceLectureTypography(outline));
            layouts.push({ kind: widths.length === 2 ? 'two-column' : 'three-column', columnWidths: widths,
              bodyFontSize: font, usedHeight, availableHeight, fits: usedHeight <= availableHeight });
          }
        }
      } else if (!text.length) {
        // Native diagram annotation is already included in these allocations.
        for (const visualWidth of [BODY.width, 700, 460, 328, 240, 180]) await add('media-side', [], font, visualWidth);
      } else {
        for (const visualWidth of [440, 328, 240, 180, 600, 700]) {
          const textWidth = BODY.width - visualWidth - GAP;
          await add('media-side', [textWidth], font, visualWidth);
          if (hasReferenceLectureTypography(outline) && text.length > 2 && textWidth >= 600) {
            await add('media-side', [(textWidth - GAP) / 2, (textWidth - GAP) / 2], font, visualWidth);
          }
        }
        if (visuals.length > 1) {
          for (const visualWidth of [700, 600, 460]) {
            const column = (visualWidth - GAP * (visuals.length - 1)) / visuals.length;
            if (column < 180) continue;
            await add('media-side', [BODY.width - visualWidth - GAP], font, visualWidth, visuals.map(() => column));
          }
        }
        for (const visualWidth of [BODY.width, 700, 460, 360, 280]) {
          await add('media-stacked', [BODY.width], font, visualWidth);
          if (hasReferenceLectureTypography(outline) && text.length > 1) {
            await add('media-stacked', [444, 444], font, visualWidth);
            await add('media-stacked', [292, 292, 292], font, visualWidth);
          }
        }
      }
      if (!hasReferenceLectureTypography(outline) && layouts.some((layout) => layout.fits)) break;
    }
    const selectedLayout = selectedSemanticLayout(outline, members, layouts);
    const measuredHeight = selectedLayout?.usedHeight ?? Math.min(...layouts.map((layout) => layout.usedHeight));
    return { id, groupIds: members.map((group) => group.id), layouts,
      ...(Number.isFinite(measuredHeight) ? { measuredHeight } : {}),
      ...(selectedLayout ? { selectedLayout } : {}) };
  }));
}

/** Measure several native arrangements before declaring that content needs another page. */
export async function evaluateSemanticPageCapacity(
  outline: SceneOutline,
  options: SemanticPageCapacityOptions = {},
): Promise<SemanticPageCapacityAssessment> {
  const sourcePageId = options.sourcePageId ?? outline.spatialParentId ?? outline.id;
  const groups = semanticGroups(outline, sourcePageId, options.explanationNodes ?? [], options.resourceSequences);
  const base = { schemaVersion: 1 as const, planningVersion: SEMANTIC_PAGE_CAPACITY_VERSION,
    outlineId: outline.id, sourcePageId, groups };
  const underlyingMeasure = options.measure ?? measureAuthoredSlideText;
  const measurementCache = new Map<string, Promise<Awaited<ReturnType<TextMeasure>>>>();
  const measure: TextMeasure = (input) => {
    const key = JSON.stringify(input);
    let pending = measurementCache.get(key);
    if (!pending) {
      pending = Promise.resolve(underlyingMeasure(input));
      measurementCache.set(key, pending);
    }
    return pending;
  };
  try {
    const [bodyFont] = slideBodyFontSizes(outline);
    const [titleFont, minimumTitleFont] = slideTitleFontSizes(outline);
    let titleHeight = await measureTextHeight(outline.title, TITLE.width, titleFont, measure, true);
    if (titleHeight > TITLE.height && minimumTitleFont !== titleFont) {
      titleHeight = await measureTextHeight(outline.title, TITLE.width, minimumTitleFont, measure, true);
    }
    const availableHeight = BODY.bottom - Math.max(130, TITLE.top + titleHeight + GAP) - VERTICAL_RESERVE;
    const textGroups = groups.filter((group) => (group.visibleText.trim() || group.tableCells?.length) && group.kind !== 'diagram');
    const mediaGroups = groups.filter((group) => group.kind === 'media' || group.kind === 'diagram');
    let diagramAllocations: DiagramAllocation[] = [];
    if (mediaGroups.some((group) => group.kind === 'diagram') && outline.visualIntent?.diagram) {
      try {
        diagramAllocations = await measureDiagramAllocations(outline.visualIntent.diagram, measure, {
          top: BODY.bottom - availableHeight, maxWidth: BODY.width, maxHeight: availableHeight,
        });
      } catch (error) {
        if (!(error instanceof Error) || !/planned diagram has no feasible|Invalid diagram component|Text layout:/i.test(error.message)) throw error;
      }
    }
    const textBlocks = indivisibleTextBlocks(textGroups);
    const layouts: SemanticCapacityLayout[] = [];
    const add = async (kind: SemanticCapacityLayout['kind'], widths: number[], font: number, mediaWidth?: number) => {
      const textHeight = await packedTextHeight(textBlocks, widths, font, measure, hasReferenceLectureTypography(outline));
      const visualHeight = mediaGroups.length ? mediaFootprint(outline, mediaGroups, mediaWidth ?? BODY.width, diagramAllocations, options.resourceDimensions) : 0;
      const usedHeight = kind === 'media-stacked' && mediaGroups.length
        ? textHeight + visualHeight + GAP : Math.max(textHeight, visualHeight);
      if (!Number.isFinite(usedHeight)) return;
      layouts.push({ kind, bodyFontSize: font, columnWidths: widths, usedHeight,
        ...(mediaWidth ? { mediaWidth } : {}),
        availableHeight, fits: usedHeight <= availableHeight && titleHeight <= TITLE.height });
    };
    for (const font of slideBodyFontSizes(outline)) {
      if (mediaGroups.length) {
        for (const mediaWidth of hasReferenceLectureTypography(outline) ? [440, 328, 240, 180, 600, 700] : [328, 240, 180]) {
          const textWidth = BODY.width - mediaWidth - GAP;
          await add('media-side', [textWidth], font, mediaWidth);
          if (hasReferenceLectureTypography(outline) && textGroups.length > 2 && textWidth >= 600) {
            await add('media-side', [(textWidth - GAP) / 2, (textWidth - GAP) / 2], font, mediaWidth);
          }
          if (!hasReferenceLectureTypography(outline) && layouts.at(-1)?.fits) break;
        }
        if (hasReferenceLectureTypography(outline) || !layouts.at(-1)?.fits) {
          for (const mediaWidth of [460, 360, 280, BODY.width]) {
            await add('media-stacked', [BODY.width], font, mediaWidth);
            if (hasReferenceLectureTypography(outline) && textGroups.length > 1) {
              await add('media-stacked', [444, 444], font, mediaWidth);
              await add('media-stacked', [292, 292, 292], font, mediaWidth);
            }
            if (!hasReferenceLectureTypography(outline) && layouts.at(-1)?.fits) break;
          }
        }
      } else {
        await add('full-width', [BODY.width], font);
        if (hasReferenceLectureTypography(outline) || !layouts.at(-1)?.fits) await add('two-column', [444, 444], font);
        if (hasReferenceLectureTypography(outline) || !layouts.at(-1)?.fits) await add('three-column', [292, 292, 292], font);
      }
      if (!hasReferenceLectureTypography(outline) && layouts.at(-1)?.fits) break;
    }
    const units = await measureSemanticUnits(outline, groups, availableHeight, diagramAllocations, measure, options.resourceDimensions);
    const unitHeight = units.reduce((sum, unit) => sum + (unit.measuredHeight ?? Infinity), 0) + GAP * Math.max(0, units.length - 1);
    if (Number.isFinite(unitHeight)) layouts.push({ kind: 'semantic-units', columnWidths: [BODY.width],
      bodyFontSize: Math.min(bodyFont, ...units.map((unit) => unit.selectedLayout?.bodyFontSize ?? bodyFont)),
      usedHeight: unitHeight, availableHeight, fits: unitHeight <= availableHeight && titleHeight <= TITLE.height,
      unitLayouts: units.flatMap((unit) => unit.selectedLayout ? [{ unitId: unit.id, groupIds: unit.groupIds, layout: unit.selectedLayout }] : []),
    });
    const best = selectedSemanticLayout(outline, groups, layouts);
    // A local title problem must not hide an independently overloaded body.
    const bodyFitsNormalTitleSpace = layouts.some((layout) =>
      layout.usedHeight <= BODY.bottom - 130 - VERTICAL_RESERVE);
    for (const group of textGroups) group.measuredHeight = await measureGroupHeight(group, BODY.width, bodyFont, measure);
    for (const group of mediaGroups) {
      const height = mediaFootprint(outline, [group], BODY.width, diagramAllocations, options.resourceDimensions);
      if (Number.isFinite(height)) group.measuredHeight = height;
    }
    const measurementMode = options.measure ? 'provided-measure-v1' as const : 'browser-renderer-fonts-v1' as const;
    const explicitConflicts = outline.spatialBudget?.conflicts.length || 0;
    const hasBadRegions = outline.spatialBudget?.regions.some((region) => !region.fits) ?? false;
    const currentLayoutFits = !explicitConflicts && !hasBadRegions && !authoredRegionConflict(outline);
    const decision = best
      ? (hasReferenceLectureTypography(outline) || best.kind === 'full-width' || best.kind === 'media-side' && best.mediaWidth === 328)
        && (hasReferenceLectureTypography(outline) || best.bodyFontSize === bodyFont) && currentLayoutFits ? 'fits' : 'optimize-layout'
      : titleHeight > TITLE.height && bodyFitsNormalTitleSpace ? 'optimize-layout' : 'page-overflow';
    return { ...base, decision, reason: best
      ? decision === 'fits' ? '完整屏显内容按现有字体可在一页容纳'
        : '调整栏宽、图文位置或页面局部冲突后可在一页容纳'
      : titleHeight > TITLE.height && bodyFitsNormalTitleSpace ? '标题在既定字号下无法容纳'
        : '完整屏显内容及必需视觉资源在测量的单页候选中均无法容纳',
    measurementMode, titleHeight, layouts, units, ...(best ? { selectedLayout: best } : {}) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const reason = isSpatialMeasurementUnavailableError(error) ? error.message
      : `页面容量测量未完成：${error instanceof Error ? error.message : String(error)}`;
    return { ...base, decision: 'measurement-unavailable', reason,
      measurementMode: 'unavailable', layouts: [] };
  }
}

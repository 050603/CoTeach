import { compileTextComponents, type AuthoringContentItem, type TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import type { SemanticPageCapacityAssessment } from './semantic-page-capacity';

type Rect = { left: number; top: number; width: number; height: number };
export type NativeTextPlacement = Rect & { ref: string; fontSize: number; bold: boolean; color: string; role: 'title' | 'body' };
export type NativeTextPlacementCandidate = {
  id: string; placements: NativeTextPlacement[];
  connectors: Array<{ fromRef: string; toRef: string; start: [number, number]; end: [number, number] }>;
};
export type NativeTextPlacementPlan = {
  supported: boolean; candidates: NativeTextPlacementCandidate[]; reason?: string;
  /** Fixed before authoring: largest offered body font, then stable single-column preference. */
  defaultCandidateId?: string;
  title: string; points: readonly AuthoringContentItem[];
  relationCaption?: { ref: string; text: string };
};
const SAFE = { left: 50, top: 50, right: 950, bottom: 512.5 };
function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width - 0.5 && a.left + a.width > b.left + 0.5
    && a.top < b.top + b.height - 0.5 && a.top + a.height > b.top + 0.5;
}
function failure(message: string): Error {
  return Object.assign(new Error(`Native text placement: ${message}`), { code: 'native-text-placement', isRetryable: false });
}
function declaredPairs(outline: SceneOutline, points: readonly AuthoringContentItem[]): Array<[string, string]> {
  const relation = outline.teachingBrief?.teachingPlan?.visualRelationship;
  // Reading order alone never establishes cause, hierarchy, branch or adjacency.
  // Only an explicit simple teaching sequence/process may connect adjacent terms.
  if (!relation || !['sequence', 'process'].includes(relation.kind) || relation.diagram) return [];
  const refs = relation.readingOrder.map((term) => {
    const exact = points.filter((point) => point.id === term || point.text === term
      || point.text.split(/[：:]/u)[0]?.trim() === term.trim());
    return exact.length === 1 ? exact[0]!.id : undefined;
  });
  if (refs.length < 2 || refs.some((ref) => !ref) || new Set(refs).size !== refs.length) return [];
  return refs.slice(1).map((ref, index) => [refs[index]!, ref!]);
}

/** A text relationship is already visible only when its complete literal chain
 * names uniquely owned concepts and agrees with the page's explicit description.
 * Reading order alone cannot establish or repair a relationship. */
export function nativeTextRelationCaption(outline: SceneOutline, points: readonly AuthoringContentItem[]): { ref: string; text: string } | undefined {
  const relation = outline.teachingBrief?.teachingPlan?.visualRelationship;
  if (relation?.kind !== 'statement' || relation.preferredForm !== 'text'
    || outline.visualIntent?.representation !== 'text' || relation.diagram || outline.visualIntent.diagram) return;
  const description = `${relation.description} ${outline.visualIntent.observationGoal}`.replace(/\s/gu, '');
  // A simple textual chain cannot substitute for a branch, feedback, cycle or
  // other independently required visual topology, even if it names some nodes.
  if (/分支|反馈|循环|回路|金字塔|层级图|关系图|结构图|fork|branch|feedback|cycle|hierarchy diagram/iu.test(description)) return;
  for (const point of points) {
    const chain = point.text.split(/[：:]/u).at(-1)!.split(/[，,。；;]/u)[0]!.trim();
    const labels = chain.split(/\s*(?:→|->)\s*/u);
    if (labels.length < 2 || labels.some((label) => !label || /[\s←↔]/u.test(label)) || new Set(labels).size !== labels.length) continue;
    const targets = labels.map((label) => points.filter((candidate) => candidate.id !== point.id
      && candidate.text.includes('：') && candidate.text.split('：')[0]!.trim().endsWith(label)));
    if (targets.some((matches) => matches.length !== 1) || new Set(targets.map((matches) => matches[0]!.id)).size !== labels.length) continue;
    // Require the description itself to spell out the same whole chain. Do not
    // guess that an imprecise readingOrder term such as 理论学习 means 理论.
    const completeChain = (chain: string, continuation: string) => {
      const index = description.indexOf(chain);
      return index >= 0 && !description.slice(index + chain.length).startsWith(continuation)
        && !description.slice(0, index).endsWith(continuation);
    };
    if (!completeChain(`从${labels.join('到')}`, '到')
      && !completeChain(labels.join('→'), '→') && !completeChain(labels.join('->'), '->')) continue;
    const knownOrder = relation.readingOrder.map((term) => labels.indexOf(term.trim())).filter((index) => index >= 0);
    if (knownOrder.some((index, order) => order > 0 && index <= knownOrder[order - 1]!)) continue;
    return { ref: point.id, text: point.text };
  }
}

function explicitlyNeedsConnectors(outline: SceneOutline): boolean {
  const relation = outline.teachingBrief?.teachingPlan?.visualRelationship;
  return /箭头|连线|连接线|分支|反馈|循环|回路|金字塔|层级图|关系图|结构图|arrow|connector|fork|branch|feedback|cycle/iu.test([relation?.description, outline.visualIntent?.observationGoal].join(' '));
}

export function formatNativeTextRelationCaption(caption: { ref: string; text: string } | undefined): string {
  if (!caption) return '';
  return `## Page-specific text relationship realization\nThe confirmed representation is text. The complete adopted relationship caption ${JSON.stringify(caption.text)} is supplied by placementRef:${JSON.stringify(caption.ref)}. Its literal arrow chain already expresses the page's described concept relationship, while the other adopted placements preserve every separate complete definition. Render that entire caption unchanged. For this page, references to arrows/relationships in visualIntent, the shared teaching design, website style and generic connector examples are fulfilled by this visible caption; they do not request a second node-and-arrow diagram or extra native connecting lines. Do not draw duplicate free-coordinate arrows or reinterpret readingOrder as new edges. This is the page-specific realization of the confirmed text representation, not permission to omit any claim, branch, cycle, source figure or separately required diagram.`;
}

/** First-response candidates use the existing native text compiler and real
 * playback measurements. Complex visuals retain their existing exact contracts.
 * Reserved measured rectangles are an extension point, never guessed media sizes. */
export async function buildNativeTextPlacementPlan(outline: SceneOutline, points: readonly AuthoringContentItem[], options: {
  measure: TextMeasure;
  capacity?: SemanticPageCapacityAssessment;
  reservedRectangles?: readonly Rect[];
}): Promise<NativeTextPlacementPlan> {
  const relationCaption = nativeTextRelationCaption(outline, points);
  const base = { title: outline.title, points, ...(relationCaption ? { relationCaption } : {}) };
  const relationship = outline.teachingBrief?.teachingPlan?.visualRelationship;
  if (!points.length || outline.visualIntent?.diagram || relationship?.diagram
    || outline.visualIntent?.resourceRefs?.length || outline.suggestedImageIds?.length || outline.mediaGenerations?.length
    || options.capacity?.groups.some((group) => group.kind !== 'text')
    || (outline.visualIntent && outline.visualIntent.representation !== 'text')
    || (relationship && !['statement', 'sequence', 'process'].includes(relationship.kind))
    || ['table', 'chart', 'diagram', 'illustration', 'mixed'].includes(relationship?.preferredForm ?? '')) {
    return { ...base, supported: false, candidates: [], reason: 'Complex or media-bound pages retain their existing measured visual contract' };
  }
  const pairs = declaredPairs(outline, points);
  const connectorsRequired = explicitlyNeedsConnectors(outline) && !relationCaption;
  if (connectorsRequired && !pairs.length) return { ...base, supported: false, candidates: [],
    reason: 'The required visual connection has no complete adopted text realization or explicit resolvable connector contract' };
  const measurementCache = new Map<string, Promise<number | undefined>>();
  const height = (text: string, width: number, fontSize: number, role: 'body' | 'title') => {
    const key = JSON.stringify([text, width, fontSize, role]);
    let pending = measurementCache.get(key);
    if (!pending) {
      pending = compileTextComponents([{ kind: 'textBox', id: 'measure', left: 50, top: 50, width,
        text, role, fontSize, bold: role === 'title' }], options.measure).then((elements) => {
          const element = elements[0];
          if (!element || element.type !== 'text') throw failure('text measurement did not produce editable text');
          return Math.ceil(element.height);
        }).catch((error) => {
          if (error instanceof Error && /content needs .*maximum allocation|cannot fit .*orphan line/u.test(error.message)) return undefined;
          throw error;
        });
      measurementCache.set(key, pending);
    }
    return pending;
  };
  const titleHeight = await height(outline.title, 900, 32, 'title');
  if (!titleHeight || titleHeight > 128) return { ...base, supported: true, candidates: [], reason: 'The complete title has no measured safe allocation' };
  const title: NativeTextPlacement = { ref: 'page-title', left: 50, top: 50, width: 900, height: titleHeight, fontSize: 32, bold: true, color: '#1E3A8A', role: 'title' };
  const top = Math.max(130, title.top + title.height + 16);
  const sequenceRefs = pairs.length ? [pairs[0]![0], ...pairs.map((pair) => pair[1])] : [];
  const orderedPoints = sequenceRefs.length
    ? [...sequenceRefs.map((ref) => points.find((point) => point.id === ref)!), ...points.filter((point) => !sequenceRefs.includes(point.id))]
    : points;
  const candidates: NativeTextPlacementCandidate[] = [];
  for (const fontSize of [24, 22]) for (const columns of [1, 2]) for (const withConnectors of (connectorsRequired ? [true] : pairs.length ? [false, true] : [false])) {
    const gap = withConnectors ? 48 : 24;
    if (columns === 2 && points.length < 2) continue;
    const width = columns === 1 ? 900 : (900 - gap) / 2;
    const heights = await Promise.all(orderedPoints.map((point) => height(point.text, width, fontSize, 'body')));
    if (heights.some((value) => value === undefined)) continue;
    const placements: NativeTextPlacement[] = [title];
    let rowTop = top;
    for (let index = 0; index < points.length; index += columns) {
      const row = orderedPoints.slice(index, index + columns);
      for (let column = 0; column < row.length; column += 1) placements.push({ ref: row[column]!.id,
        left: 50 + column * (width + gap), top: rowTop, width, height: heights[index + column]!, fontSize, bold: false, color: '#334155', role: 'body' });
      rowTop += Math.max(...heights.slice(index, index + columns) as number[]) + gap;
    }
    if (placements.some((box) => box.top + box.height > SAFE.bottom || box.left + box.width > SAFE.right
      || (options.reservedRectangles ?? []).some((reserved) => intersects(box, reserved)))) continue;
    const connectors: NativeTextPlacementCandidate['connectors'] = [];
    for (const [fromRef, toRef] of (withConnectors ? pairs : [])) {
      const from = placements.find((box) => box.ref === fromRef)!, to = placements.find((box) => box.ref === toRef)!;
      let start: [number, number] | undefined, end: [number, number] | undefined;
      if (from.left === to.left && to.top - (from.top + from.height) >= 48) {
        start = [from.left + from.width / 2, from.top + from.height + 12]; end = [to.left + to.width / 2, to.top - 12];
      } else if (from.top === to.top && to.left - (from.left + from.width) >= 48) {
        const y = Math.max(from.top, to.top) + Math.min(from.height, to.height) / 2;
        start = [from.left + from.width + 12, y]; end = [to.left - 12, y];
      }
      if (!start || !end) continue;
      const corridor = { left: Math.min(start[0], end[0]) - 10, top: Math.min(start[1], end[1]) - 10,
        width: Math.abs(end[0] - start[0]) + 20, height: Math.abs(end[1] - start[1]) + 20 };
      if (placements.some((box) => intersects(corridor, box))
        || (options.reservedRectangles ?? []).some((box) => intersects(corridor, box))) continue;
      connectors.push({ fromRef, toRef, start, end });
    }
    // A connector layout must preserve the whole declared sequence. Never
    // advertise a two-column partial chain that silently loses the row transition.
    if (withConnectors && connectors.length !== pairs.length) continue;
    candidates.push({ id: `native-text-v1-${fontSize}-${columns}col-gap${gap}`, placements, connectors });
  }
  return { ...base, supported: true, candidates, ...(candidates[0] ? { defaultCandidateId: candidates[0].id } : {}), ...(!candidates.length ? { reason: 'No candidate fits the complete measured title and adopted points at readable body sizes' } : {}) };
}

export function formatNativeTextPlacementPlan(plan: NativeTextPlacementPlan): string {
  if (!plan.supported || !plan.candidates.length) return '';
  const defaultCandidate = plan.candidates.find((candidate) => candidate.id === plan.defaultCandidateId);
  if (!defaultCandidate) return '';
  const example = { elements: [],
    components: defaultCandidate.placements.map((placement) => ({ kind: 'textBox', placementRef: placement.ref })),
    ...(defaultCandidate.connectors.length ? { placementConnectors: defaultCandidate.connectors.map(({ fromRef, toRef }) => ({ fromRef, toRef })) } : {}) };
  return `## Measured native text placement choices
Before this request, the host selected default layout ${JSON.stringify(defaultCandidate.id)} from the feasible candidates, preferring the largest offered readable body font and then the stable single-column arrangement. Use bare placementRef components for this default; you do not need to repeat layoutCandidateId. Only when actively choosing a different advertised candidate, supply its explicit layoutCandidateId. The compiler uses exactly that one preselected layout; it never tries other candidates after validation fails. The native compiler owns the title/body rectangles. This contract replaces the free-coordinate title/body example above. Text-only candidates preserve the actual sequence by reading order; arrows are not required. Connector candidates additionally express that same complete sequence using measured clear corridors. Keep native shapes, fills, borders, accent bars and decorative composition in elements. For that choice, every title/body component must be kind:textBox with placementRef:"page-title" or an exact adopted point id. Include each placement exactly once. The compiler inserts the title/point text, coordinates, full measured height and font size; omit authored left/top/width/height/fontSize, text/paragraphs and contentRef/paragraphRefs on these components. The host defaults are the course reference title color #1E3A8A and body color #334155, applied before native compilation when color is omitted. You may explicitly select a valid reference-palette color and align; the compiler owns the exact measured font weight (bold title, regular body). Use native backgrounds and accents for emphasis without reducing or replacing text. The compiler still checks actual native foreground collisions.
When a candidate is selected, do not duplicate teaching text in native text, shape text, tables or extra components; all teaching text uses placementRef. For a candidate with connectors, include every advertised pair exactly once in placementConnectors:[{fromRef:"...",toRef:"...",color:"#64748b"}]. Use ONLY connector pairs advertised by that candidate, which come from the actual teaching relationship and have measured clear corridors. Do not draw free-coordinate arrows between these text blocks. A missing connector pair is not permission to invent a relation or route across text. The model still owns the visual composition and meaningful grouping; this is editable native output, not a rendered image or a forced whole-page flow template.
Complete selected-placement envelope (add native decoration and colors as appropriate): ${JSON.stringify(example)}
Candidates: ${JSON.stringify(plan.candidates)}`;
}

function hasPlacementReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPlacementReference);
  return Object.hasOwn(value, 'placementRef') || Object.values(value).some(hasPlacementReference);
}

/** Expand the preselected default for bare placementRef responses, or one
 * explicitly selected candidate. Never search alternatives after failure. Legacy coordinates
 * remain untouched and still face the original renderer/coverage checks. */
export function expandNativeTextPlacements(response: string, plan: NativeTextPlacementPlan): string {
  let page: Record<string, unknown>;
  try { page = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1')); } catch { return response; }
  if (!page || typeof page !== 'object' || Array.isArray(page)) return response;
  if (page.layoutCandidateId === undefined && !hasPlacementReference(page)) {
    if (page.placementConnectors !== undefined) throw failure('connectors require the complete placement reference protocol');
    return response;
  }
  // The default was fixed from the complete measured input before aiCall. A
  // missing choice ID is not a reason to guess from native shapes or try layouts.
  const candidateId = page.layoutCandidateId === undefined ? plan.defaultCandidateId : page.layoutCandidateId;
  const candidate = plan.candidates.find((item) => item.id === candidateId);
  if (!plan.supported || !candidate) throw failure('unknown or unavailable candidate');
  if (!Array.isArray(page.components) || !Array.isArray(page.elements) || page.layout !== undefined) throw failure('selected native placement requires elements and components arrays');
  const native = page.elements as Array<Record<string, unknown>>;
  if (native.some((element) => !element || ['text', 'table', 'chart', 'latex'].includes(String(element.type))
    || element.type === 'shape' && element.text || element.type === 'line' && Array.isArray(element.points) && element.points.includes('arrow'))) {
    throw failure('native teaching text or unanchored arrows cannot bypass the selected placement contract');
  }
  const seen = new Set<string>();
  const components = page.components.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid text component');
    const component = value as Record<string, unknown>;
    const placement = candidate.placements.find((item) => item.ref === component.placementRef);
    if (component.kind !== 'textBox' || !placement || seen.has(placement.ref)) throw failure('unknown, duplicate or unplaced text component');
    if (['left', 'top', 'x', 'y', 'width', 'height', 'maxHeight', 'fontSize', 'bold', 'fontFamily', 'lineHeight', 'paragraphSpace', 'padding', 'text', 'paragraphs', 'contentRef', 'paragraphRefs'].some((key) => Object.hasOwn(component, key))) {
      throw failure('selected placements own geometry, body typography and complete adopted text');
    }
    seen.add(placement.ref);
    const { placementRef: _reference, ...style } = component;
    const { ref, ...geometry } = placement;
    return { ...style, ...geometry, color: component.color ?? geometry.color,
      ...(ref === 'page-title' ? { text: plan.title } : { contentRef: ref }) };
  });
  if (candidate.placements.some((placement) => !seen.has(placement.ref))) throw failure('every title and adopted point needs its own placement');
  if (page.placementConnectors !== undefined && !Array.isArray(page.placementConnectors)) throw failure('invalid connector list');
  const used = new Set<string>();
  const connectors = ((page.placementConnectors ?? []) as unknown[]).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid connector');
    const requested = value as Record<string, unknown>;
    const edge = candidate.connectors.find((item) => item.fromRef === requested.fromRef && item.toRef === requested.toRef);
    const key = `${requested.fromRef}:${requested.toRef}`;
    if (!edge || used.has(key) || Object.keys(requested).some((field) => !['fromRef', 'toRef', 'color'].includes(field))) throw failure('connector does not match the adopted relationship and clear corridor');
    used.add(key);
    const color = requested.color ?? '#64748b';
    if (typeof color !== 'string' || !/^#[\da-f]{3,8}$/iu.test(color)) throw failure('invalid connector color');
    return { id: `placement-connector-${index}`, type: 'line', left: edge.start[0], top: edge.start[1], width: 3,
      start: [0, 0], end: [edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]], points: ['', 'arrow'], style: 'solid', color };
  });
  if (connectors.length !== candidate.connectors.length) throw failure('selected placement must preserve every declared connector');
  const { layoutCandidateId: _candidate, placementConnectors: _connectors, ...envelope } = page;
  return JSON.stringify({ ...envelope, components, elements: [...native, ...connectors] });
}

import { compileTextComponents, type AuthoringContentItem, type TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import type { SemanticPageCapacityAssessment } from './semantic-page-capacity';
import { hasReferenceLectureTypography, slideBodyFontSizes, slideTitleFontSizes } from './slide-presentation-typography';

type Rect = { left: number; top: number; width: number; height: number };
export type NativeTextPlacement = Rect & { ref: string; fontSize: number; bold: boolean; color: string; role: 'title' | 'body' };
export type NativeTextPlacementCandidate = {
  id: string; placements: NativeTextPlacement[];
  connectors: Array<{ fromRef: string; toRef: string; start: [number, number]; end: [number, number] }>;
  auxiliaryTextAreas?: Rect[];
};
export type NativeTextPlacementPlan = {
  supported: boolean; candidates: NativeTextPlacementCandidate[]; reason?: string;
  /** Chosen before authoring from the actual teaching relationship. */
  defaultCandidateId?: string;
  title: string; points: readonly AuthoringContentItem[];
  relationCaption?: { ref: string; text: string };
  comparisonRows?: boolean;
  /** Current lecture pages may group catalog items through contentRef/paragraphRefs.
   * Candidates prove measured feasibility, without imposing one box per item. */
  flexibleComposition?: boolean;
  presentationRoles?: Array<{ ref: string; role: string; nodeIds: string[] }>;
  measuredComposition?: SemanticPageCapacityAssessment['selectedLayout'];
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
  return `## Page-specific text relationship realization\nThe confirmed representation is text. The complete adopted relationship caption ${JSON.stringify(caption.text)} is supplied by placementRef:${JSON.stringify(caption.ref)}. Its literal arrow chain already expresses the page's described concept relationship, while the other adopted placements preserve every separate adopted display claim. Full teaching definitions do not expand this catalog. Render that entire caption unchanged. For this page, references to arrows/relationships in visualIntent, the shared teaching design, website style and generic connector examples are fulfilled by this visible caption; they do not request a second node-and-arrow diagram or extra native connecting lines. Do not draw duplicate free-coordinate arrows or reinterpret readingOrder as new edges. This is the page-specific realization of the confirmed text representation, not permission to omit any claim, branch, cycle, source figure or separately required diagram.`;
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
  const relationship = outline.teachingBrief?.teachingPlan?.visualRelationship;
  const flexibleComposition = hasReferenceLectureTypography(outline);
  const presentationRoles = outline.teachingBrief?.teachingPlan?.presentationItems?.flatMap((item) => {
    const point = points.find((point) => point.text.trim() === item.text.trim());
    return point ? [{ ref: point.id, role: item.role, nodeIds: [...item.nodeIds] }] : [];
  });
  // A comparison of complete adopted statements can use the same measured
  // text slots in aligned rows. A table preference does not invent cell data;
  // genuine diagrams, tables, media and non-text capacity groups stay separate.
  const comparisonRows = relationship?.kind === 'comparison'
    && ['text', 'table'].includes(relationship.preferredForm ?? '')
    && (!outline.visualIntent || ['text', 'table'].includes(outline.visualIntent.representation));
  const base = { title: outline.title, points, ...(relationCaption ? { relationCaption } : {}),
    ...(comparisonRows ? { comparisonRows: true } : {}), ...(flexibleComposition ? { flexibleComposition: true } : {}),
    ...(presentationRoles?.length ? { presentationRoles } : {}),
    ...(flexibleComposition && options.capacity?.selectedLayout ? { measuredComposition: options.capacity.selectedLayout } : {}) };
  if (!points.length || outline.visualIntent?.diagram || relationship?.diagram
    || outline.visualIntent?.resourceRefs?.length || outline.suggestedImageIds?.length || outline.mediaGenerations?.length
    || options.capacity?.groups.some((group) => group.kind !== 'text')
    || (outline.visualIntent && outline.visualIntent.representation !== 'text' && !comparisonRows)
    || (relationship && !['statement', 'sequence', 'process'].includes(relationship.kind) && !comparisonRows)
    || (!comparisonRows && ['table', 'chart', 'diagram', 'illustration', 'mixed'].includes(relationship?.preferredForm ?? ''))) {
    return { ...base, supported: false, candidates: [], reason: 'Complex or media-bound pages retain their existing measured visual contract' };
  }
  const pairs = declaredPairs(outline, points);
  const connectorsRequired = explicitlyNeedsConnectors(outline) && !relationCaption;
  if (connectorsRequired && !pairs.length) return { ...base, supported: false, candidates: [],
    reason: 'The required visual connection has no complete adopted text realization or explicit resolvable connector contract' };
  const measurementCache = new Map<string, Promise<number | undefined>>();
  const height = (text: string, width: number, fontSize: number, role: 'body' | 'title', emphasized = false) => {
    const key = JSON.stringify([text, width, fontSize, role, emphasized]);
    let pending = measurementCache.get(key);
    if (!pending) {
      pending = compileTextComponents([{ kind: 'textBox', id: 'measure', left: 50, top: 50, width,
        text, role, fontSize, bold: role === 'title' || emphasized }], options.measure).then((elements) => {
          const element = elements[0];
          if (!element || element.type !== 'text') throw failure('text measurement did not produce editable text');
          return Math.ceil(element.height);
        }).catch((error) => {
          if (error instanceof Error && /content needs .*maximum allocation|cannot fit .*orphan line/u.test(error.message)) return undefined;
          if (error instanceof Error && error.name === 'AbortError') throw error;
          return undefined;
        });
      measurementCache.set(key, pending);
    }
    return pending;
  };
  const [defaultTitleFont, compactTitleFont] = slideTitleFontSizes(outline);
  let titleFont = defaultTitleFont;
  let titleHeight = await height(outline.title, 900, titleFont, 'title');
  if ((!titleHeight || titleHeight > 128) && compactTitleFont !== titleFont) {
    titleFont = compactTitleFont;
    titleHeight = await height(outline.title, 900, titleFont, 'title');
  }
  if (!titleHeight || titleHeight > 128) return { ...base, supported: true, candidates: [], reason: 'The complete title has no measured safe allocation' };
  const title: NativeTextPlacement = { ref: 'page-title', left: 50, top: 50, width: 900, height: titleHeight, fontSize: titleFont, bold: true, color: '#1E3A8A', role: 'title' };
  const top = Math.max(130, title.top + title.height + 16);
  const headingRefs = new Set(flexibleComposition ? presentationRoles?.filter((item) => item.role === 'heading').map((item) => item.ref) : []);
  const sequenceRefs = pairs.length ? [pairs[0]![0], ...pairs.map((pair) => pair[1])] : [];
  const orderedPoints = sequenceRefs.length && !headingRefs.size
    ? [...sequenceRefs.map((ref) => points.find((point) => point.id === ref)!), ...points.filter((point) => !sequenceRefs.includes(point.id))]
    : points;
  const candidates: NativeTextPlacementCandidate[] = [];
  const bodyCount = points.length - headingRefs.size;
  const comparisonColumns = bodyCount === 3 ? [3, 2, 1] : [2, 1];
  const columnsPreference = flexibleComposition
    ? bodyCount < 2 ? [1] : comparisonRows ? comparisonColumns
      : sequenceRefs.length ? bodyCount <= 3 ? [bodyCount, 1] : [1, 2]
        : [2, 1]
    : comparisonRows ? [1] : [1, 2];
  for (const columns of [...new Set(columnsPreference)]) for (const fontSize of slideBodyFontSizes(outline)) for (const withConnectors of (connectorsRequired ? [true] : pairs.length ? [false, true] : [false])) {
    const gap = withConnectors ? 48 : 24;
    if (Math.max(1, bodyCount) < columns) continue;
    const width = (900 - gap * (columns - 1)) / columns;
    const heights = await Promise.all(orderedPoints.map((point) => {
      const isHeading = headingRefs.has(point.id);
      return height(point.text, isHeading ? 900 : width, fontSize, 'body', isHeading);
    }));
    if (heights.some((value) => value === undefined)) continue;
    const placements: NativeTextPlacement[] = [title];
    let rowTop = top;
    for (let index = 0; index < points.length;) {
      const isHeading = headingRefs.has(orderedPoints[index]!.id);
      let row = orderedPoints.slice(index, index + (isHeading ? 1 : columns));
      const nextHeading = row.findIndex((point) => headingRefs.has(point.id));
      if (nextHeading > 0) row = row.slice(0, nextHeading);
      for (let column = 0; column < row.length; column += 1) placements.push({ ref: row[column]!.id,
        left: 50 + column * (width + gap), top: rowTop, width: isHeading ? 900 : width,
        height: heights[index + column]!, fontSize, bold: isHeading, color: isHeading ? '#1E3A8A' : '#334155', role: 'body' });
      rowTop += Math.max(...heights.slice(index, index + row.length) as number[]) + gap;
      index += row.length;
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
    const footerTop = Math.max(...placements.map((placement) => placement.top + placement.height)) + 12;
    const footer = { left: SAFE.left, top: footerTop, width: SAFE.right - SAFE.left, height: SAFE.bottom - footerTop };
    const auxiliaryTextAreas = footer.height >= 32
      && !(options.reservedRectangles ?? []).some((reserved) => intersects(footer, reserved)) ? [footer] : [];
    candidates.push({ id: `native-text-${flexibleComposition ? 'v2' : 'v1'}-${fontSize}-${columns}col-gap${gap}`, placements, connectors, auxiliaryTextAreas });
  }
  // Saved placement IDs retain their original font-first order. New page
  // choices rank a meaningful comparison/group/sequence before font size.
  if (!flexibleComposition) candidates.sort((a, b) => b.placements[1]!.fontSize - a.placements[1]!.fontSize);
  return { ...base, supported: true, candidates, ...(candidates[0] ? { defaultCandidateId: candidates[0].id } : {}), ...(!candidates.length ? { reason: 'No candidate fits the complete measured title and adopted points at readable body sizes' } : {}) };
}

export function formatNativeTextPlacementPlan(plan: NativeTextPlacementPlan): string {
  if (plan.flexibleComposition && (!plan.supported || !plan.candidates.length) && plan.points.length) {
    return `## Measured lecture composition choices
Choose the native composition from the current teaching relationship and adopted presentation roles. Group related catalog points in contentRef/paragraphRefs text boxes with shared padding and paragraph spacing; catalog items are not compulsory separate padded boxes. Keep headings and emphasis, aligned comparison dimensions, complete real process edges, and authored case observations beside their supplied visual. Preserve every complete catalog point and the complete diagram annotation. Do not add the oral expansion to fill whitespace. Use the pre-authoring measured composition below when supplied; its typography and geometry describe an actually feasible composition, while the compiler still checks your authored arrangement against real playback fonts, coverage, overflow and collisions. No placementRef candidate is advertised for this page.
Adopted presentation roles: ${JSON.stringify(plan.presentationRoles ?? [])}
Measured semantic composition: ${JSON.stringify(plan.measuredComposition ?? null)}`;
  }
  if (!plan.supported || !plan.candidates.length) return '';
  const defaultCandidate = plan.candidates.find((candidate) => candidate.id === plan.defaultCandidateId);
  if (!defaultCandidate) return '';
  if (plan.flexibleComposition) return `## Measured lecture composition choices
Before this request, the host measured semantic composition ${JSON.stringify(defaultCandidate.id)} against the complete adopted presentation catalog, using the established lecture fonts. These rectangles are feasibility examples, rather than compulsory one-item/one-box placements. Choose the composition from the actual teaching relationship: aligned sides or a table for comparison, ordered labels and only declared edges for a process, heading and grouped claims for a concept, and the supplied observation beside its original visual for a case. Use native editable contentRef/paragraphRefs components to group catalog points and emphasize their roles; every adopted point must remain complete and visible. Keep headings, conclusions, comparison dimensions, process labels and case observations at their authored level. Preserve the source facts and any required visual topology. The compiler measures your selected native geometry and typography against the playback fonts; all coverage, safe-area, overflow and collision checks still apply. Do not add the full oral explanation to fill whitespace. A selected placementRef candidate remains available as an explicit layout choice, with its unchanged measured geometry, but free-coordinate catalog groups need neither placementRef nor layoutCandidateId.
Adopted presentation roles: ${JSON.stringify(plan.presentationRoles ?? [])}
Measured semantic composition: ${JSON.stringify(plan.measuredComposition ?? null)}
Measured feasible candidates: ${JSON.stringify(plan.candidates)}`;
  const example = { elements: [],
    components: defaultCandidate.placements.map((placement) => ({ kind: 'textBox', placementRef: placement.ref })),
    ...(defaultCandidate.connectors.length ? { placementConnectors: defaultCandidate.connectors.map(({ fromRef, toRef }) => ({ fromRef, toRef })) } : {}) };
  const comparisonGuidance = plan.comparisonRows
    ? '\nThis page compares the adopted statements in aligned, equal-width rows at one body font. Preserve that comparison structure and the complete content of every row; use the native row backgrounds, borders and accents to make the shared comparison axis clear. Do not invent new column headings, cells, relationships or shorter claims. These measured slots realize the text-only comparison/table preference; they do not replace separately supplied table data, diagrams or visuals.'
    : '';
  return `## Measured native text placement choices
Before this request, the host selected default layout ${JSON.stringify(defaultCandidate.id)} from the saved page's original font and placement contract. Use bare placementRef components for this default; you do not need to repeat layoutCandidateId. Only when actively choosing a different advertised candidate, supply its explicit layoutCandidateId. The compiler uses exactly that one preselected layout; it never tries other candidates after validation fails. The native compiler owns the title/body rectangles. This contract replaces the free-coordinate title/body example above. Text-only candidates preserve the actual sequence by reading order; arrows are not required. Connector candidates additionally express that same complete sequence using measured clear corridors. Keep native shapes, fills, borders, accent bars and decorative composition in elements. For that choice, every title/body component must be kind:textBox with placementRef:"page-title" or an exact adopted point id. Include each placement exactly once. The compiler inserts the title/point text, coordinates, full measured height and font size; omit authored left/top/width/height/fontSize, text/paragraphs and contentRef/paragraphRefs on these components. The host defaults are the course reference title color #1E3A8A and body color #334155, applied before native compilation when color is omitted. You may explicitly select a valid reference-palette color and align; the compiler owns the exact measured font weight (bold title, regular body). Use native backgrounds and accents for emphasis without reducing or replacing text. The compiler still checks actual native foreground collisions.
The adopted catalog points and page title use their placementRef slots. You may also author supporting native subtitles, captions, and scenario explanations in elements, including native text or shape text; preserve each complete statement. These additions use the actual original teaching context and do not replace or shorten an adopted point. The selected candidate's auxiliaryTextAreas describe the remaining full-width space after the measured title and body, with a clear gap; use this space for supporting text and its background. Keep the complete browser-measured text box inside the slide safe area and separate from every reserved title/body rectangle, visual and connector corridor. Native text still passes the same font measurement, geometry and renderer checks as the rest of the page. Avoid duplicating an adopted point as additional native prose. For a candidate with connectors, include every advertised pair exactly once in placementConnectors:[{fromRef:"...",toRef:"...",color:"#64748b"}]. Use ONLY connector pairs advertised by that candidate, which come from the actual teaching relationship and have measured clear corridors. Do not draw free-coordinate arrows between these text blocks. A missing connector pair is not permission to invent a relation or route across text. The model still owns the visual composition and meaningful grouping; this is editable native output, not a rendered image or a forced whole-page flow template.
Complete selected-placement envelope (add native decoration and colors as appropriate): ${JSON.stringify(example)}
Candidates: ${JSON.stringify(plan.candidates)}${comparisonGuidance}`;
}

function hasPlacementReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPlacementReference);
  return Object.hasOwn(value, 'placementRef') || Object.values(value).some(hasPlacementReference);
}

/** Expand the preselected default for bare placementRef responses, or one
 * explicitly selected candidate. Never search alternatives after failure. Legacy coordinates
 * remain untouched and still face the original renderer/coverage checks. */
export function expandNativeTextPlacements(response: string, plan: NativeTextPlacementPlan, onDiagnostic?: (detail: string) => void): string {
  try { return expandStrictNativeTextPlacements(response, plan); }
  catch (error) {
    if (!onDiagnostic) throw error;
    onDiagnostic(error instanceof Error ? error.message : String(error));
    let page: Record<string, unknown>;
    try { page = JSON.parse(response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1')); }
    catch { return response; }
    if (!page || typeof page !== 'object' || !Array.isArray(page.components)) return response;
    const candidate = plan.candidates.find((item) => item.id === page.layoutCandidateId)
      ?? plan.candidates.find((item) => item.id === plan.defaultCandidateId);
    if (!candidate) return response;
    const components = page.components.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const component = value as Record<string, unknown>;
      const placement = candidate.placements.find((item) => item.ref === component.placementRef);
      if (!placement || component.kind !== 'textBox') return value;
      const { ref, ...geometry } = placement;
      const { placementRef: _ref, ...style } = component;
      return { ...style, ...geometry, color: component.color ?? geometry.color,
        ...(ref === 'page-title' ? { text: plan.title } : { contentRef: ref }) };
    });
    const native = Array.isArray(page.elements) ? page.elements : [];
    const connectors = (Array.isArray(page.placementConnectors) ? page.placementConnectors : []).flatMap((request, index) => {
      if (!request || typeof request !== 'object') return [];
      const edge = candidate.connectors.find((item) => item.fromRef === request.fromRef && item.toRef === request.toRef);
      if (!edge) return [];
      return [{ id: `placement-connector-${index}`, type: 'line', left: edge.start[0], top: edge.start[1], width: 3,
        start: [0, 0], end: [edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]], points: ['', 'arrow'],
        style: 'solid', color: typeof request.color === 'string' ? request.color : '#64748b' }];
    });
    const { layoutCandidateId: _candidate, placementConnectors: _connectors, ...envelope } = page;
    return JSON.stringify({ ...envelope, components, elements: [...native, ...connectors] });
  }
}

function expandStrictNativeTextPlacements(response: string, plan: NativeTextPlacementPlan): string {
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
  if (native.some((element) => !element || typeof element !== 'object' || Array.isArray(element))) {
    throw failure('native elements must be objects');
  }
  if (native.some((element) => (element.type === 'text' || element.type === 'shape' && element.text)
    && (!['left', 'top', 'width', 'height'].every((key) => typeof element[key] === 'number' && Number.isFinite(element[key]))
      || Number(element.width) <= 0 || Number(element.height) <= 0))) {
    throw failure('supporting native text needs its complete measured allocation');
  }
  if (native.some((element) => element.type === 'line' && Array.isArray(element.points) && element.points.includes('arrow'))) {
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

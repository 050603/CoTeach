import type { ElkNode } from 'elkjs/lib/elk-api';
import type { SceneOutline } from '../types/generation';
import { fallbackSlideVisualPlan, type SlideVisualPlan } from './slide-visual-plan';
import type { SlideRegionBudget, SlideSpatialBudget, SlideTeachingRegion, SpatialRect } from './slide-spatial-types';
import { measureSlideRegion, renderSpatialSketchSvg, SPATIAL_FONT, SPATIAL_LINE_HEIGHT, SPATIAL_PADDING, type SpatialMeasureFn } from './slide-spatial-measurement';

const BODY: SpatialRect = { x: 60, y: 145, width: 880, height: 335 };
const GAP = 18;
const RESERVED = 0.1;
const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

export function intersectSpatialRects(a: SpatialRect, b: SpatialRect): SpatialRect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Subtract each occupied rectangle into non-overlapping free rectangles. */
export function remainingSlideSpace(regions: SpatialRect[]): SpatialRect[] {
  let free = [{ ...BODY }];
  for (const region of regions) free = free.flatMap((rect) => {
    const cut = intersectSpatialRects(rect, region);
    if (!cut) return [rect];
    return [
      { x: rect.x, y: rect.y, width: rect.width, height: cut.y - rect.y },
      { x: rect.x, y: cut.y + cut.height, width: rect.width, height: rect.y + rect.height - cut.y - cut.height },
      { x: rect.x, y: cut.y, width: cut.x - rect.x, height: cut.height },
      { x: cut.x + cut.width, y: cut.y, width: rect.x + rect.width - cut.x - cut.width, height: cut.height },
    ].filter((item) => item.width > 0 && item.height > 0);
  });
  return free;
}

function planningRegions(outline: SceneOutline, plan: SlideVisualPlan): SlideTeachingRegion[] {
  const keyPoints = outline.keyPoints.length ? outline.keyPoints : [plan.coreMessage];
  // Only explicit storyboard regions can declare an indivisible comparison or
  // worked example. A semantic fallback may infer one of those compositions
  // from a title, but grouping every synthesized key point would make a dense
  // confirmed page impossible to split and turn a storyboard outage into a
  // terminal course-generation failure.
  const atomic = Boolean(plan.regions?.length) && ['comparison', 'worked-example'].includes(plan.composition);
  let regions: SlideTeachingRegion[] = plan.regions?.length ? plan.regions.map((r) => ({ ...r, keyPointIndexes: [...r.keyPointIndexes], knowledgePointIds: [...r.knowledgePointIds] })) : [];
  const covered = new Set(regions.flatMap((r) => r.keyPointIndexes));
  const texts = keyPoints.map((content, index) => ({ content, index })).filter(({ index }) => !covered.has(index));
  for (const { content, index } of texts) {
    let id = `point-${index + 1}`;
    while (regions.some((r) => r.id === id)) id += '-required';
    regions.push({ id, kind: 'text', content, unitId: atomic ? 'core-unit' : id,
      keyPointIndexes: outline.keyPoints.length ? [index] : [], knowledgePointIds: [], readingOrder: regions.length,
      ...BODY, fontSize: 24, minWidth: 180, minHeight: 70 });
  }
  // Exact required evidence must survive normalization; don't rely on model summaries for coverage.
  for (const region of regions) {
    for (const index of region.keyPointIndexes) {
      const point = outline.keyPoints[index];
      if (point && !region.content.includes(point) && region.kind === 'text') region.content += `\n${point}`;
    }
  }
  const mapped = new Set(regions.flatMap((r) => r.knowledgePointIds));
  if (regions[0]) regions[0].knowledgePointIds.push(...(outline.knowledgePointIds ?? []).filter((id) => !mapped.has(id)));
  regions = regions.sort((a, b) => a.readingOrder - b.readingOrder);
  if (!plan.regions?.length || texts.length) {
    const columns = regions.length > 1 ? 2 : 1;
    const rows = Math.ceil(regions.length / columns);
    regions.forEach((r, i) => Object.assign(r, { x: BODY.x + (i % columns) * (BODY.width + GAP) / columns,
      y: BODY.y + Math.floor(i / columns) * (BODY.height + GAP) / rows,
      width: (BODY.width - GAP * (columns - 1)) / columns, height: (BODY.height - GAP * (rows - 1)) / rows }));
  }
  // A relation denotes one teachable unit when separating its endpoints would break meaning.
  const groups = new Map(regions.map((r) => [r.id, r.unitId]));
  if (atomic) regions.forEach((r) => groups.set(r.id, 'core-unit'));
  for (const relation of [...(plan.relations ?? []), ...regions.filter((r) => r.parentRegionId).map((r) => ({ from: r.parentRegionId!, to: r.id }))]) {
    if (!groups.has(relation.from) || !groups.has(relation.to)) throw new Error(`视觉关系引用无效: ${relation.from} → ${relation.to}`);
    const from = groups.get(relation.from), to = groups.get(relation.to);
    for (const [id, unit] of groups) if (unit === to) groups.set(id, from!);
  }
  return regions.map((r) => ({ ...r, unitId: groups.get(r.id)! }));
}

async function relationCandidates(regions: SlideTeachingRegion[], plan: SlideVisualPlan, measure: SpatialMeasureFn): Promise<{ regions: SlideTeachingRegion[]; connectors: SlideSpatialBudget['connectors'] }> {
  const relations = (plan.relations ?? []).filter((r) => regions.some((node) => node.id === r.from) && regions.some((node) => node.id === r.to));
  if (!relations.length || !['process', 'relationship', 'hierarchy'].includes(plan.composition)) return { regions, connectors: [] };
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const nodes = [];
  for (const region of regions) {
    const width = Math.max(region.minWidth ?? 160, Math.min(340, BODY.width / Math.min(3, regions.length) - 48));
    const fontSize = Math.min(28, Math.max(22, region.fontSize ?? 24));
    const measured = region.kind === 'image' ? { height: width / (region.imageAspectRatio || 1.5) } : await measure(region, width, fontSize);
    nodes.push({ id: region.id, width, height: Math.max(region.minHeight ?? 85, 20 + (measured.height - 20) / (1 - RESERVED)) });
  }
  const graph: ElkNode = await elk.layout<ElkNode>({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': plan.composition === 'hierarchy' ? 'DOWN' : 'RIGHT',
    'elk.spacing.nodeNode': '32', 'elk.layered.spacing.nodeNodeBetweenLayers': '48', 'elk.edgeRouting': 'ORTHOGONAL' },
    children: nodes,
    edges: relations.map((r, i) => ({ id: `edge-${i}`, sources: [r.from], targets: [r.to] })),
  });
  const scale = Math.min(1, BODY.width / (graph.width || BODY.width), BODY.height / (graph.height || BODY.height));
  const offsetX = BODY.x + (BODY.width - (graph.width ?? BODY.width) * scale) / 2;
  const offsetY = BODY.y + (BODY.height - (graph.height ?? BODY.height) * scale) / 2;
  const point = (p: { x: number; y: number }) => ({ x: offsetX + p.x * scale, y: offsetY + p.y * scale });
  return {
    regions: regions.map((r) => { const node = graph.children!.find((n) => n.id === r.id)!;
      return { ...r, ...point({ x: node.x ?? 0, y: node.y ?? 0 }), width: (node.width ?? r.width) * scale, height: (node.height ?? r.height) * scale }; }),
    connectors: (graph.edges ?? []).flatMap((edge, i) => (edge.sections ?? []).map((section) => ({ from: relations[i].from, to: relations[i].to,
      label: relations[i].label, points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point) }))),
  };
}

async function budgetRegion(region: SlideTeachingRegion, measure: SpatialMeasureFn): Promise<SlideRegionBudget> {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 20 || region.height <= 20) throw new Error(`视觉区域尺寸无效: ${region.id}`);
  const fontSize = Math.min(28, Math.max(22, region.fontSize ?? 24));
  const measured = region.kind === 'image' ? { width: Math.max(region.minWidth ?? 120, region.width), height: Math.max(region.minHeight ?? 120, region.width / (region.imageAspectRatio && region.imageAspectRatio > 0 ? region.imageAspectRatio : 1.5)), representativeCharWidth: fontSize }
    : await measure(region, region.width, fontSize);
  const maxLines = Math.max(0, Math.floor((region.height - 2 * SPATIAL_PADDING) * (1 - RESERVED) / (fontSize * SPATIAL_LINE_HEIGHT)));
  const inside = region.x >= BODY.x && region.y >= BODY.y && region.x + region.width <= BODY.x + BODY.width + 0.01 && region.y + region.height <= BODY.y + BODY.height + 0.01;
  return { ...region, fontSize, fontFamily: SPATIAL_FONT, padding: SPATIAL_PADDING, lineHeight: SPATIAL_LINE_HEIGHT,
    maxLines, textCapacity: Math.floor((region.width - 2 * SPATIAL_PADDING) / Math.max(1, measured.representativeCharWidth)) * maxLines,
    measuredHeight: measured.height, measuredWidth: measured.width,
    fits: inside && region.width >= (region.minWidth ?? 0) && region.height >= (region.minHeight ?? 0) && measured.width <= region.width + 0.5 && measured.height <= (region.kind === 'image' ? region.height : 20 + (region.height - 20) * (1 - RESERVED)) + 0.5,
    ...(region.kind === 'table' ? { tableCapacity: { columns: Math.max(1, ...(region.tableCells ?? []).map((row) => row.length)), rows: Math.floor((region.height - 20) * (1 - RESERVED) / (fontSize + 13)) } } : {}),
  };
}

async function createBudget(title: string, regions: SlideTeachingRegion[], connectors: SlideSpatialBudget['connectors'], measure: SpatialMeasureFn): Promise<SlideSpatialBudget> {
  const titleBounds = { x: 60, y: 8, width: 880, height: 128 };
  const titleMeasure = await measure({ id: 'page-title', kind: 'text', content: title, unitId: 'title', keyPointIndexes: [], knowledgePointIds: [], readingOrder: -1, ...titleBounds }, titleBounds.width, 32);
  if (titleMeasure.width > titleBounds.width + 0.5 || titleMeasure.height > 20 + (titleBounds.height - 20) * (1 - RESERVED)) throw new Error(`页面标题无法在 32px 下容纳: ${title}`);
  const measured: SlideRegionBudget[] = [];
  for (const region of regions) measured.push(await budgetRegion(region, measure));
  const conflicts: SlideSpatialBudget['conflicts'] = [];
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    if (regions[i].parentRegionId === regions[j].id || regions[j].parentRegionId === regions[i].id) continue;
    const intersection = intersectSpatialRects(regions[i], regions[j]);
    if (intersection) conflicts.push({ first: regions[i].id, second: regions[j].id, intersection });
  }
  const occupied = regions.map(({ x, y, width, height }) => ({ x, y, width, height }));
  return { schemaVersion: 1, canvas: { width: 1000, height: 562.5 }, safeBody: { ...BODY }, title: { text: title, bounds: titleBounds, fontSize: 32, lineHeight: 1.5, measuredHeight: titleMeasure.height, maxLines: 2 }, reserveRatio: 0.1,
    regions: measured, occupied, remaining: remainingSlideSpace(occupied), conflicts, connectors,
    measurement: measure.measurementMode ?? 'browser-renderer-fonts-v1' };
}

function spatialMediaRequests(outline: SceneOutline, regions: SlideTeachingRegion[]): SceneOutline['mediaGenerations'] {
  return outline.mediaGenerations?.map((request) => {
    const region = regions.find((r) => r.kind === 'image' && r.mediaElementId === request.elementId);
    if (!region || request.type !== 'image') return request;
    const ratio = region.width / region.height;
    const choices = [{ label: '1:1', ratio: 1 }, { label: '4:3', ratio: 4 / 3 }, { label: '16:9', ratio: 16 / 9 }, { label: '9:16', ratio: 9 / 16 }] as const;
    const selected = choices.reduce((best, option) => Math.abs(Math.log(option.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio)) ? option : best);
    return { ...request, aspectRatio: selected.label,
      prompt: `${request.prompt}\nPage image purpose: ${region.content}. Intended display region: ${Math.round(region.width)} × ${Math.round(region.height)}. Keep the teaching subject and essential relationships within the central 80% so cropping has 10% margin on each side. Precise text, values, and formulas are separate editable slide elements; do not bake those labels into this image.` };
  });
}

function durationPart(total: number | undefined, index: number, count: number): number | undefined {
  if (total === undefined) return undefined;
  // Integer seconds survive the outline/checkpoint normalizer; fractional inputs retain millisecond precision.
  const part = Number.isInteger(total) ? Math.floor(total / count) : Math.floor(total * 1000 / count) / 1000;
  return index === count - 1 ? total - part * (count - 1) : part;
}

function relaxOversizedRegion(region: SlideTeachingRegion, outline: SceneOutline): SlideTeachingRegion[] {
  const indexedPoints = [...new Set(region.keyPointIndexes)]
    .filter((index) => typeof outline.keyPoints[index] === 'string' && outline.keyPoints[index].length > 0);
  const exactParts = indexedPoints.map((index) => ({ content: outline.keyPoints[index], keyPointIndexes: [index] }));
  const candidates = exactParts.length && (exactParts.length > 1 || exactParts[0].content !== region.content)
    ? exactParts
    : region.kind === 'text'
      ? region.content.split(/\n+|(?<=[。！？；.!?;])\s*/u).filter(Boolean).flatMap((part) => {
        const characters = [...part];
        return Array.from({ length: Math.ceil(characters.length / 180) }, (_, index) => ({
          content: characters.slice(index * 180, (index + 1) * 180).join(''),
          keyPointIndexes: region.keyPointIndexes,
        }));
      })
      : [];
  if (candidates.length <= 1 && candidates[0]?.content === region.content) return [];
  return candidates.map((part, index) => ({
    ...region,
    id: `${region.id}--overflow-${index + 1}`,
    unitId: `${region.unitId}--overflow-${index + 1}`,
    content: part.content,
    keyPointIndexes: part.keyPointIndexes,
    knowledgePointIds: index === 0 ? region.knowledgePointIds : [],
    mediaElementId: index === 0 ? region.mediaElementId : undefined,
  }));
}

/** Deterministic pre-authoring split: never reflows already generated DSL or completed checkpoints. */
export async function prepareCourseSlideSpatialPlans(outlines: readonly SceneOutline[], options: { measure?: SpatialMeasureFn; relationLayout?: boolean } = {}): Promise<SceneOutline[]> {
  const result: SceneOutline[] = [];
  const measure = options.measure ?? measureSlideRegion;
  const reservedIds = new Set(outlines.map((outline) => outline.id));
  for (const outline of outlines) {
    if (outline.type !== 'slide' || outline.spatialBudget) { result.push({ ...outline }); continue; }
    const visualPlan = outline.visualPlan ?? fallbackSlideVisualPlan(outline);
    const originalRegions = planningRegions(outline, visualPlan);
    const candidate = options.relationLayout === false ? { regions: originalRegions, connectors: [] } : await relationCandidates(originalRegions, visualPlan, measure);
    let first = await createBudget(outline.title, candidate.regions, candidate.connectors, measure);
    if (!first.regions.every((r) => r.fits) && candidate.connectors.length) {
      // ELK cannot shrink typography with graph coordinates: prefer a measured storyboard
      // when its original regions fit. This is deterministic planning, never a model retry.
      const originalConnectors = (visualPlan.relations ?? []).map((relation) => {
        const a = originalRegions.find((r) => r.id === relation.from)!, b = originalRegions.find((r) => r.id === relation.to)!;
        return { from: relation.from, to: relation.to, label: relation.label,
          points: [{ x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }] };
      });
      const originalBudget = await createBudget(outline.title, originalRegions, originalConnectors, measure);
      if (originalBudget.regions.every((r) => r.fits)) { first = originalBudget; candidate.regions = originalRegions; }
    }
    if (first.regions.every((region) => region.fits)) {
      result.push({ ...outline, mediaGenerations: spatialMediaRequests(outline, candidate.regions), visualPlan: { ...visualPlan, schemaVersion: 2, regions: candidate.regions }, spatialBudget: first });
      continue;
    }
    const units = new Map<string, SlideTeachingRegion[]>();
    for (const region of originalRegions) units.set(region.unitId, [...(units.get(region.unitId) ?? []), region]);
    const pendingUnits = [...units.values()];
    const pages: SlideTeachingRegion[][] = [[]];
    let usedHeight = 0;
    while (pendingUnits.length) {
      const unit = pendingUnits.shift()!;
      const sized: SlideTeachingRegion[] = [];
      let unitHeight = 0;
      for (const region of unit) {
        const fontSize = Math.min(28, Math.max(22, region.fontSize ?? 24));
        // Media retain useful framing; don't expand them to the full page width during packing.
        const aspectRatio = region.imageAspectRatio && region.imageAspectRatio > 0 ? region.imageAspectRatio : 1.5;
        const requestedWidth = Math.min(BODY.width, Math.max(Math.min(region.minWidth ?? 200, BODY.width), Math.min(region.width, 440)));
        const width = region.kind === 'image' ? Math.min(requestedWidth, BODY.height * aspectRatio) : BODY.width;
        const measured = region.kind === 'image' ? { width, height: width / aspectRatio } : await measure(region, width, fontSize);
        const minimumHeight = Math.min(region.minHeight ?? (region.kind === 'image' ? 120 : 60), BODY.height);
        const height = Math.max(minimumHeight, Math.ceil(region.kind === 'image' ? measured.height : 20 + (measured.height - 20) / (1 - RESERVED)));
        if (measured.width > width + 0.5) throw new Error(`教学区域宽度无法容纳: ${outline.id}/${region.id}`);
        sized.push({ ...region, x: BODY.x + (BODY.width - width) / 2, y: BODY.y, width, height,
          minWidth: Math.min(region.minWidth ?? 0, width), minHeight: minimumHeight });
        unitHeight += height + (sized.length > 1 ? GAP : 0);
      }
      if (unitHeight > BODY.height) {
        const relaxed = unit.length > 1
          ? unit.map((region, index) => ({ ...region, unitId: `${region.unitId}--overflow-${index + 1}` }))
          : relaxOversizedRegion(unit[0], outline);
        if (relaxed.length) {
          pendingUnits.unshift(...relaxed.map((region) => [region]));
          continue;
        }
        throw new Error(`教学内容无法在单页安全容纳: ${outline.id}/${unit[0].id}`);
      }
      if (usedHeight && usedHeight + GAP + unitHeight > BODY.height) { pages.push([]); usedHeight = 0; }
      for (const region of sized) {
        if (usedHeight) usedHeight += GAP;
        pages[pages.length - 1].push({ ...region, y: BODY.y + usedHeight });
        usedHeight += region.height;
      }
    }
    for (const [index, regions] of pages.entries()) {
      const split = pages.length > 1;
      let id = split ? `${outline.id}--spatial-${index + 1}` : outline.id;
      while (split && reservedIds.has(id)) id += '-page';
      reservedIds.add(id);
      const indexes = [...new Set(regions.flatMap((r) => r.keyPointIndexes))].sort((a, b) => a - b);
      const keyPoints = indexes.map((i) => outline.keyPoints[i]);
      const localRegions = regions.map((r) => ({ ...r, keyPointIndexes: r.keyPointIndexes.map((i) => indexes.indexOf(i)) }));
      const knowledgePointIds = [...new Set(regions.flatMap((r) => r.knowledgePointIds))];
      const relations = visualPlan.relations?.filter((r) => regions.some((n) => n.id === r.from) && regions.some((n) => n.id === r.to));
      const connectors = (relations ?? []).map((r) => { const a = regions.find((n) => n.id === r.from)!, b = regions.find((n) => n.id === r.to)!;
        return { from: r.from, to: r.to, label: r.label, points: [{ x: a.x + a.width / 2, y: a.y + a.height }, { x: b.x + b.width / 2, y: b.y }] }; });
      const spatialBudget = await createBudget(outline.title, localRegions, connectors, measure);
      if (!spatialBudget.regions.every((r) => r.fits)) throw new Error(`前置空间预算无法满足: ${id}`);
      const mediaGenerations = spatialMediaRequests(outline, regions)?.filter((request) => {
        const owner = pages.findIndex((items) => items.some((r) => r.mediaElementId === request.elementId));
        return index === (owner >= 0 ? owner : 0);
      });
      result.push({ ...outline, id, ...(split ? { title: `${outline.title}（${index + 1}/${pages.length}）`, spatialParentId: outline.spatialParentId ?? outline.id, spatialSourceContext: outline.spatialSourceContext ?? { description: outline.description, teachingObjective: outline.teachingObjective, coreMessage: visualPlan.coreMessage },
        segmentGroupId: outline.segmentGroupId ?? outline.id, segmentIndex: index + 1, segmentCount: pages.length, segmentRole: keyPoints.join('；') } : {}),
        ...(split ? { description: `本页只呈现以下教学单元：${regions.map((r) => r.content).join('；')}`, teachingObjective: keyPoints.join('；') || outline.teachingObjective,
          // Media are generated once per confirmed parent; children with matching image intent own the resource.
          mediaGenerations, suggestedImageIds: index === 0 ? outline.suggestedImageIds : undefined } : {}),
        keyPoints, knowledgePointIds, targetDurationSec: durationPart(outline.targetDurationSec, index, pages.length),
        estimatedDuration: durationPart(outline.estimatedDuration, index, pages.length),
        // Timing must be recomputed from each child's share before narration generation.
        timingPlan: split ? undefined : outline.timingPlan,
        visualPlan: { ...visualPlan, schemaVersion: 2, coreMessage: split ? (keyPoints.join('；') || regions.map((r) => r.content).join('；')) : visualPlan.coreMessage, regions: localRegions, relations, visualEvidence: regions.map((r) => r.content) }, spatialBudget });
    }
  }
  return result.map((outline, order) => ({ ...outline, order }));
}

export function buildSlideSpatialSketchSvg(outline: SceneOutline): string | undefined {
  const budget = outline.spatialBudget;
  if (!budget) return undefined;
  const lines = budget.connectors.map((line) => `<polyline points="${line.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#64748b" stroke-width="2"/><text x="${line.points[0].x + 4}" y="${line.points[0].y - 5}" font-size="14">${escapeXml(line.label)}</text>`).join('');
  const titleLines = [budget.title.text.slice(0, 26), budget.title.text.slice(26)];
  const title = titleLines.filter(Boolean).map((line, i) => `<text x="70" y="${55 + i * 48}" font-size="32">${escapeXml(line)}</text>`).join('');
  const boxes = budget.regions.map((r) => `<g><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${r.kind === 'image' ? '#e0f2fe' : '#f1f5f9'}" fill-opacity="0.65" stroke="#64748b" stroke-dasharray="6 3"/><text x="${r.x + 10}" y="${r.y + 24}" font-size="18">${escapeXml(`${r.id} · ${r.kind}`)}</text><text x="${r.x + 10}" y="${r.y + 55}" font-size="${r.fontSize}">${escapeXml(r.content.replace(/<[^>]*>/g, '').slice(0, Math.max(3, Math.floor((r.width - 20) / r.fontSize))))}</text><text x="${r.x + 10}" y="${r.y + r.height - 12}" font-size="14">${Math.round(r.width)}×${Math.round(r.height)} · ${r.fontSize}px · ${r.maxLines} lines</text></g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="563" viewBox="0 0 1000 563"><rect width="1000" height="563" fill="white"/><g font-family="Noto Sans SC" fill="#0f172a">${title}<rect x="60" y="145" width="880" height="335" fill="none" stroke="#cbd5e1"/>${boxes}${lines}</g></svg>`;
}

export async function getSlideSpatialSketch(outline: SceneOutline): Promise<string | undefined> {
  const svg = buildSlideSpatialSketchSvg(outline);
  return svg ? renderSpatialSketchSvg(svg) : undefined;
}

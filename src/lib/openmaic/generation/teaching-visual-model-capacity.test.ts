import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TeachingVisualScene, PPTElement } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import fixtures from './__fixtures__/teaching-visual-model-capacity.json';
import originalRedraw from './__fixtures__/teaching-visual-redraw-original.json';
import { compileTeachingVisualScene, type TeachingVisualImage } from './teaching-visual-compiler';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from './slide-spatial-measurement';
import { slideVisualSourceContent } from './slide-visual-projection';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { auditSlideDensity } from './slide-layout-audit';
import { parseTeachingVisualScene } from './teaching-visual-scene';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';

afterAll(closeSpatialMeasurementBrowser);
const cases = fixtures as unknown as Array<{ id: string; outline: SceneOutline; scene: TeachingVisualScene; images: TeachingVisualImage[] }>;
function text(elements: PPTElement[]) {
  return elements.flatMap((element) => element.type === 'text' ? [element.content]
    : element.type === 'shape' ? [element.text?.content ?? '']
      : element.type === 'table' ? element.data.flat().map((cell) => cell.text) : [])
    .map((value) => value.replace(/<[^>]*>/gu, '').replace(/&(amp|lt|gt|quot);/gu,
      (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity as 'amp']).replace(/\s+/gu, ''));
}

describe('saved second-pass model geometry regressions', () => {
  it.each(cases)('retains the actual source scene at readable sizes: $id', async ({ id, outline, scene, images }) => {
    const original = JSON.stringify(scene);
    const sourceCatalog = slideVisualSourceContent(outline);
    const result = await compileTeachingVisualScene(outline, scene, { measure: measureAuthoredSlideText, images, sourceCatalog });
    expect(result).not.toBeNull();
    const pages = [result!, ...(result!.continuationPages ?? [])];
    expect(pages.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(scene)).toBe(original);
    const displayed = text(pages.flatMap((page) => page.elements));
    for (const component of scene.pages.flatMap((page) => page.components)) {
      for (const node of component.nodes) for (const wording of [node.label, node.text].filter(Boolean)) {
        expect(displayed.some((actual) => actual.includes(wording!.replace(/\s+/gu, ''))), `${id}: ${wording}`).toBe(true);
      }
    }
    for (const page of pages) {
      expect(page.teachingVisual?.scene).toEqual(result!.teachingVisual?.scene);
      for (const element of page.elements) {
        if (element.type !== 'line') expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
        const sizes = JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu);
        for (const size of sizes) expect(Number(size[1])).toBeGreaterThanOrEqual(18);
      }
    }
    expect(() => parseTeachingVisualScene(JSON.stringify(result!.teachingVisual!.scene))).not.toThrow();
    if (id === 'data-02-seeds-1') {
      const elements = pages.flatMap((page) => page.elements);
      const source = elements.find((element) => element.id === 'n-rates')!;
      const target = elements.find((element) => element.id === 'n-conclusion')!;
      const start = elements.find((element) => element.id === 'comp-germination-data:edge-0:leg-1');
      const arrow = elements.find((element) => element.id === 'comp-germination-data:edge-0');
      expect(start?.type).toBe('line');
      expect(arrow?.type).toBe('line');
      if (start?.type === 'line' && arrow?.type === 'line' && 'height' in source && 'height' in target) {
        expect([start.left + start.start[0], start.top + start.start[1]])
          .toEqual([source.left + source.width, source.top + source.height / 2]);
        expect([arrow.left + arrow.end[0], arrow.top + arrow.end[1]])
          .toEqual([target.left + target.width, target.top + target.height / 2]);
        expect(arrow.points).toEqual(['', 'arrow']);
      }
      expect(text(elements.filter((element) => element.id === 'comp-germination-data:edge-0:label'))).toEqual(['结果支持']);
    }
    if (id === 'original-page-19-1') {
      const expanded = expandCompiledSlidePages(outline, result!);
      expect(expanded).toHaveLength(3);
      expect(expanded.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(97);
      const hosts = expanded.filter((page) => page.outline.visualIntent?.diagram);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.content.elements.filter((element) => element.type === 'shape' && element.id.startsWith('p2-c1-node-'))).toHaveLength(5);
      expect(hosts[0]!.content.elements.filter((element) => element.type === 'line' && element.id.startsWith('p2-c1-edge-'))).toHaveLength(4);
      for (const page of expanded) expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
      expect(result!.qualityDiagnostics).toContainEqual(expect.stringContaining('one local replan'));
    }
  }, 15_000);

  it('rejects a table-cell relationship rather than treating the whole table as both endpoints', async () => {
    const fixture = structuredClone(cases.find((candidate) => candidate.id === 'comparison-02-cell-1')!);
    const component = fixture.scene.pages[0]!.components[0]!;
    component.edges = [{ from: component.nodes[0]!.id, to: component.nodes[1]!.id, label: '比较分裂次数', kind: 'comparison' }];
    expect(await compileTeachingVisualScene(fixture.outline, fixture.scene, { measure: measureAuthoredSlideText,
      sourceCatalog: slideVisualSourceContent(fixture.outline) })).toBeNull();
  });

  it('adopts the measured three-page redraw through the full baseline while retaining the original 97 seconds', async () => {
    const fixture = cases.find((candidate) => candidate.id === 'original-page-19-1')!;
    const outline = originalRedraw.outline as unknown as SceneOutline;
    const baseline = originalRedraw.baseline as unknown as NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>;
    const savedDraft = JSON.stringify(baseline.visualBaseline);
    const call = vi.fn(async () => JSON.stringify(fixture.scene));
    const result = await generateOpenMaicBaselineContent(outline, call, {
      ...baseline, visualProjection: true, teachingVisual: true, componentAuthoring: true,
      slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result && 'elements' in result).toBe(true);
    if (!result || !('elements' in result)) throw new Error('Expected a complete native slide redraw');
    expect(result.teachingVisual).toBeDefined();
    expect(result.qualityDiagnostics).toEqual([expect.stringContaining('one local replan')]);
    const pages = expandCompiledSlidePages(outline, result);
    expect(pages).toHaveLength(3);
    expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(97);
    expect(pages.filter((page) => page.outline.visualIntent?.diagram)).toHaveLength(1);
    for (const page of pages) expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
    const displayed = text(pages.flatMap((page) => page.content.elements));
    for (const node of fixture.scene.pages.flatMap((page) => page.components.flatMap((component) => component.nodes))) {
      for (const wording of [node.label, node.text].filter(Boolean)) {
        expect(displayed.some((actual) => actual.includes(wording!.replace(/\s+/gu, ''))), wording).toBe(true);
      }
    }
    expect(JSON.stringify(baseline.visualBaseline)).toBe(savedDraft);
    // A teacher-owned slide still blocks structural replanning; its previous
    // canvas can be retained by the caller without moving or losing edits.
    const protectedDraft = structuredClone(result);
    protectedDraft.teachingVisual!.modifiedSlide = true;
    expect(await compileTeachingVisualScene(outline, fixture.scene, { measure: measureAuthoredSlideText,
      sourceCatalog: slideVisualSourceContent(outline), previous: protectedDraft })).toBeNull();
  }, 20_000);
});

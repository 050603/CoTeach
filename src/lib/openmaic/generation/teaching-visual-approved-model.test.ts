import { afterAll, expect, it, vi } from 'vitest';
import type { PPTTextElement, TeachingVisualScene } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import response from './__fixtures__/teaching-visual-approved-model-response.json';
import reordered from './__fixtures__/teaching-visual-approved-reordered-response.json';
import original from './__fixtures__/teaching-visual-redraw-original.json';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity } from './slide-layout-audit';

afterAll(closeSpatialMeasurementBrowser);
const normalize = (value: string) => value.replace(/<[^>]+>/gu, '').replace(/\s+/gu, '');

it('automatically reflows the real two-page production response into a five-icon axis and owned support, conserving every authored fact', async () => {
  const outline = original.outline as unknown as SceneOutline;
  const baseline = original.baseline as unknown as NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>;
  const scene = response.scene as unknown as TeachingVisualScene;
  const untouched = structuredClone({ outline, scene, baseline });
  const call = vi.fn(async () => JSON.stringify(scene));
  const generated = await generateOpenMaicBaselineContent(outline, call, { ...baseline, teachingVisual: true,
    visualProjection: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText });
  expect(call).toHaveBeenCalledTimes(1);
  if (!generated || !('elements' in generated)) throw new Error('Expected native slides from the actual saved model response');
  expect(generated.teachingVisual).toBeDefined();
  const pages = expandCompiledSlidePages(outline, generated);
  expect(pages).toHaveLength(2);
  expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(97);
  const hosts = pages.filter((page) => page.outline.visualIntent?.diagram);
  expect(hosts).toHaveLength(1);
  const host = hosts[0]!.content;
  const arrows = host.elements.filter((element) => element.type === 'line');
  expect(arrows).toHaveLength(4);
  for (const arrow of arrows) if (arrow.type === 'line') {
    expect(arrow.start[1]).toBe(arrow.end[1]);
    expect(arrow.points).toEqual(['', 'arrow']);
  }
  expect(host.elements.filter((element) => element.id.endsWith(':icon'))).toHaveLength(5);
  const preparation = host.elements.find((element) => element.id === 'anno-c1')!;
  const evaluation = host.elements.find((element) => element.id === 'anno-c5a')!;
  expect(preparation.left).toBeLessThan(evaluation.left);
  const visible = pages.flatMap((page) => page.content.elements).filter((element) => !('opacity' in element) || element.opacity !== 0)
    .flatMap((element) => element.type === 'text' ? [normalize(element.content)]
      : element.type === 'shape' && element.text ? [normalize(element.text.content)] : []);
  for (const node of scene.pages.flatMap((page) => page.components.flatMap((component) => component.nodes))) {
    for (const value of [node.label, node.text].filter((text): text is string => Boolean(text))) {
      expect(visible.some((text) => text.includes(normalize(value))), node.id).toBe(true);
    }
  }
  expect(visible.join('')).toContain('谁来评');
  expect(visible.join('')).toContain('评什么');
  for (const page of pages) {
    expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
    expect(page.content.elements.some((element) => element.type === 'image')).toBe(false);
    for (const element of page.content.elements) if (element.type !== 'line') {
      expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
      for (const [, size] of JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu)) expect(Number(size)).toBeGreaterThanOrEqual(18);
    }
  }
  // Matching source words alone never substitutes for an actual editable object.
  expect(pages[0]!.content.elements.some((element) => element.id === 'state-hold:learner')).toBe(true);
  expect(pages[0]!.content.elements.some((element) => element.id === 'state-out:learner')).toBe(true);
  expect(pages[0]!.content.elements.some((element) => element.id === 'state-out:support')).toBe(false);
  expect({ outline, scene, baseline }).toEqual(untouched);
}, 20_000);

it('restores the second actual response order and names every support owner before regrouping the notes', async () => {
  const outline = original.outline as unknown as SceneOutline;
  const baseline = original.baseline as unknown as NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>;
  const call = vi.fn(async () => reordered.response);
  const generated = await generateOpenMaicBaselineContent(outline, call, { ...baseline, teachingVisual: true,
    visualProjection: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText });
  expect(call).toHaveBeenCalledTimes(1);
  if (!generated || !('elements' in generated)) throw new Error('Expected native slides');
  expect(generated.teachingVisual).toBeDefined();
  expect(generated.qualityDiagnostics?.join(' ')).toContain('disjoint adopted source intervals');
  const pages = expandCompiledSlidePages(outline, generated);
  expect(pages).toHaveLength(2);
  expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(97);
  expect(pages[0]!.outline.visualIntent?.diagram).toBeUndefined();
  const host = pages[1]!.content;
  const note = host.elements.find((element) => element.id === 'p1-c1-detail');
  if (note?.type !== 'text') throw new Error('Expected the real first support text');
  const visible = normalize(note.content);
  expect(visible.startsWith('搭脚手架：')).toBe(true);
  expect(visible).toContain('制定符合最近发展区的概念框架');
  expect(visible).toContain('独立探索：');
  expect(visible.indexOf('搭脚手架')).toBeLessThan(visible.indexOf('独立探索'));
  const captions = host.elements.filter((element): element is PPTTextElement => element.type === 'text' && element.id.endsWith(':label'));
  expect(note.top - Math.max(...captions.map((element) => element.top + element.height))).toBeLessThan(60);
  const panels = host.elements.filter((element) => element.type === 'shape' && element.id.endsWith(':panel'));
  expect(panels).toHaveLength(2);
  if (panels[0]?.type !== 'shape' || panels[1]?.type !== 'shape') throw new Error('Expected the two native support panels');
  expect(panels[0].top).toBe(panels[1].top);
  expect(panels[0].height).toBe(panels[1].height);
  expect(panels[0].width).toBe(panels[1].width);
  for (const panel of panels) if (panel.type === 'shape') {
    expect(panel.viewBox).toEqual([panel.width, panel.height]);
    expect(panel.top + panel.height).toBeLessThanOrEqual(532.5);
  }
  expect(host.elements.filter((element) => element.type === 'line')).toHaveLength(4);
  for (const page of pages) expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
}, 20_000);

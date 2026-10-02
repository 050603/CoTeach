import { afterAll, expect, it, vi } from 'vitest';
import type { TeachingVisualScene } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import fixture from './__fixtures__/teaching-visual-approved-long-response.json';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { auditSlideDensity } from './slide-layout-audit';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(closeSpatialMeasurementBrowser);

it('gives a real long-label model graph the full canvas and carries every existing condition to one continuation', async () => {
  const outline = fixture.outline as unknown as SceneOutline;
  const scene = fixture.scene as unknown as TeachingVisualScene;
  const untouched = structuredClone({ outline, scene: fixture.scene });
  const call = vi.fn(async () => fixture.response);
  const generated = await generateOpenMaicBaselineContent(outline, call, { teachingVisual: true,
    visualProjection: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText });
  expect(call).toHaveBeenCalledTimes(1);
  if (!generated || !('elements' in generated)) throw new Error('Expected actual native model output');
  expect(generated.teachingVisual).toBeDefined();
  const pages = expandCompiledSlidePages(outline, generated);
  expect(pages).toHaveLength(2);
  expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(60);
  const hosts = pages.filter((page) => page.outline.visualIntent?.diagram);
  expect(hosts).toHaveLength(1);
  expect(hosts[0]!.content.elements.filter((element) => element.type === 'line')).toHaveLength(3);
  const visible = pages.flatMap((page) => page.content.elements).filter((element) => !('opacity' in element) || element.opacity !== 0)
    .flatMap((element) => element.type === 'text' ? [element.content]
      : element.type === 'shape' && element.text ? [element.text.content] : [])
    .map((text) => text.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ''));
  for (const node of scene.pages.flatMap((page) => page.components.flatMap((component) => component.nodes))) {
    if (node.text) expect(visible.some((text) => text.includes(node.text!.replace(/\s+/gu, ''))), node.id).toBe(true);
  }
  for (const page of pages) {
    expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
    for (const element of page.content.elements) if (element.type !== 'line') {
      expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
      for (const [, size] of JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu)) expect(Number(size)).toBeGreaterThanOrEqual(18);
    }
  }
  expect({ outline, scene: fixture.scene }).toEqual(untouched);
}, 20_000);

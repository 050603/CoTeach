import { afterAll, expect, it } from 'vitest';
import type { TeachingVisualScene } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import fixture from './__fixtures__/teaching-visual-approved-image-response.json';
import { compileTeachingVisualScene } from './teaching-visual-compiler';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { slideVisualSourceContent } from './slide-visual-projection';
import { auditSlideDensity } from './slide-layout-audit';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(closeSpatialMeasurementBrowser);
const plain = (html: string) => html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, '');

it('reflows the actual crowded source-picture page once, preserving the original picture, complete observations and source responsibilities', async () => {
  const outline = fixture.outline as unknown as SceneOutline;
  const scene = fixture.scene as unknown as TeachingVisualScene;
  const before = structuredClone({ outline, scene, images: fixture.images });
  const options = { images: fixture.images, measure: measureAuthoredSlideText, sourceCatalog: slideVisualSourceContent(outline) };
  expect(await compileTeachingVisualScene(outline, scene, { ...options, allowSplit: false })).toBeNull();
  const content = await compileTeachingVisualScene(outline, scene, options);
  if (!content) throw new Error('Expected the unchanged source-picture response to fit after one local replan');
  expect(content.qualityDiagnostics?.join(' ')).toContain('one local replan');
  expect(content.qualityDiagnostics?.join(' ')).toContain('without speculative pixel connectors');
  const pages = expandCompiledSlidePages(outline, content);
  expect(pages).toHaveLength(3);
  expect(pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(outline.targetDurationSec);
  const images = pages.flatMap((page) => page.content.elements).filter((element) => element.type === 'image');
  expect(images).toHaveLength(1);
  expect(images[0]?.id).toBe(fixture.images[0]!.id);
  expect(images[0]?.src).toBe(fixture.images[0]!.src);
  expect(images[0]!.width / images[0]!.height).toBeCloseTo(fixture.images[0]!.width / fixture.images[0]!.height);
  expect(pages[0]!.content.elements.some((element) => element.type === 'line')).toBe(false);
  const visible = pages.flatMap((page) => page.content.elements).flatMap((element) => element.type === 'text' ? [plain(element.content)]
    : element.type === 'shape' && element.text ? [plain(element.text.content)] : []);
  for (const node of scene.pages.flatMap((page) => page.components.flatMap((component) => component.nodes))) {
    for (const value of [node.label, node.text].filter((value): value is string => Boolean(value))) {
      expect(visible.some((text) => text.includes(plain(value))), node.id).toBe(true);
    }
  }
  for (const page of pages) {
    expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
    for (const element of page.content.elements) if (element.type !== 'line') {
      expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
      for (const [, size] of JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu)) expect(Number(size)).toBeGreaterThanOrEqual(18);
    }
  }
  expect({ outline, scene, images: fixture.images }).toEqual(before);
}, 20_000);

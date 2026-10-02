import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { PPTElement, Slide } from '@openmaic/dsl';
import { TEACHING_VISUAL_ICONS } from '../generation/teaching-visual-scene';
import { roundedVisualPanel, visualCircle, visualIcon, visualLearner } from '../generation/teaching-visual-primitives';
import { TEACHING_VISUAL_THEME as T } from '../generation/teaching-visual-theme';
import { toPoints } from './svg-path-parser';

vi.mock('@openmaic/lib/store', () => ({ useStageStore: () => ({}) }));
vi.mock('@openmaic/lib/store/canvas', () => ({ useCanvasStore: {} }));
vi.mock('@openmaic/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false, useMediaGenerationStore: { getState: () => ({ tasks: {} }) },
}));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }));
import { buildPptxBlob } from './use-export-pptx';

describe('native editable hierarchy glyph export', () => {
  it('keeps every finite glyph, multiple subpaths, paint and separate factual captions editable', async () => {
    const glyphs = TEACHING_VISUAL_ICONS.map((icon, index) => visualIcon(`glyph-${icon}`, icon, 40 + 65 * index, 120));
    const primitives = [roundedVisualPanel('takeaway', { left: 40, top: 300, width: 700, height: 100 }, T.warmPale),
      visualCircle('plate', 40, 200, 72, T.pale), ...visualLearner('learner', 880, 280)];
    const shapes = [...glyphs, ...primitives];
    const elements: PPTElement[] = [...shapes, {
      id: 'plate:label', type: 'text', left: 16, top: 280, width: 120, height: 36, rotate: 0,
      content: '<p style="font-size:20px">独立探索 / Explore</p>', defaultColor: T.text, defaultFontName: T.font,
    }];
    expect(shapes.every((shape) => !shape.special)).toBe(true);
    const slide: Slide = { id: 'finite-native-glyphs', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { fontName: T.font, fontColor: T.text, themeColors: [], backgroundColor: T.background }, elements };
    const blob = await buildPptxBlob([slide], [], 0.5625, 1000, 100, 100 / 72);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const xml = await archive.file('ppt/slides/slide1.xml')!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    const geometry = [...doc.getElementsByTagName('a:custGeom')];
    expect(geometry).toHaveLength(shapes.length);
    for (const [index, shape] of shapes.entries()) {
      const points = toPoints(shape.path);
      expect(points.length, `${shape.id} has renderable commands`).toBeGreaterThan(1);
      expect(geometry[index]!.getElementsByTagName('a:moveTo').length, shape.id).toBe(points.filter((point) => point.type === 'M').length);
      expect(geometry[index]!.getElementsByTagName('a:lnTo').length, shape.id).toBe(points.filter((point) => point.type === 'L').length);
      expect(geometry[index]!.getElementsByTagName('a:cubicBezTo').length, shape.id).toBe(points.filter((point) => point.type === 'C').length);
      expect(geometry[index]!.getElementsByTagName('a:quadBezTo').length, shape.id).toBe(points.filter((point) => point.type === 'Q').length);
      expect(geometry[index]!.getElementsByTagName('a:close').length, shape.id).toBe(points.filter((point) => point.type === 'Z').length);
    }
    for (const glyph of geometry.slice(0, glyphs.length)) {
      const line = glyph.parentElement!.getElementsByTagName('a:ln')[0]!;
      expect(Number(line.getAttribute('w'))).toBeGreaterThan(0);
      expect(line.getElementsByTagName('a:srgbClr')[0]!.getAttribute('val')).toBe(T.blue.slice(1));
    }
    expect([...doc.getElementsByTagName('a:t')].map((node) => node.textContent).join('')).toContain('独立探索 / Explore');
    expect(doc.getElementsByTagName('p:pic')).toHaveLength(0);
    expect(Object.keys(archive.files).filter((name) => name.startsWith('ppt/media/') && !archive.files[name]!.dir)).toEqual([]);
  });
});

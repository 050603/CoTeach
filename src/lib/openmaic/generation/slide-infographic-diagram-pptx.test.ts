import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import { compileOriginalSlideDraft } from './slide-infographic-layout';

vi.mock('@openmaic/lib/store', () => ({ useStageStore: () => ({}) }));
vi.mock('@openmaic/lib/store/canvas', () => ({ useCanvasStore: {} }));
vi.mock('@openmaic/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false, useMediaGenerationStore: { getState: () => ({ tasks: {} }) },
}));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }));
import { buildPptxBlob } from '../export/use-export-pptx';

const measure: TextMeasure = ({ text, width, fontSize, lineHeight, padding }) => ({
  naturalWidth: text.length * fontSize, height: Math.max(1, Math.ceil(text.length * fontSize / Math.max(fontSize, width - padding * 2)))
    * fontSize * lineHeight + padding * 2, lines: [text],
});
const textOf = (element: Element) => [...element.getElementsByTagName('a:t')].map((node) => node.textContent).join('');

describe('original teaching fallback native font export', () => {
  it('exports node20, condition18 and complete source copy as native editable PPTX text', async () => {
    const outline: SceneOutline = { id: 'page', type: 'slide', title: '撤除支持的条件', order: 0, description: '', keyPoints: [],
      visualIntent: { representation: 'native-diagram', observationGoal: '观察条件', diagram: { topology: 'branch', nodes: [
        { id: 'condition', label: '独立完成吗' }, { id: 'withdraw', label: '逐个撤除' }, { id: 'retain', label: '继续支持' },
      ], edges: [{ from: 'condition', to: 'withdraw', label: '能独立完成' }, { from: 'condition', to: 'retain', label: '仍需支持' }] } } };
    const source = '逐个撤除，不能等到最后一次性撤销。';
    const content = await compileOriginalSlideDraft(outline, [{ id: 'complete-original', text: source }], {
      measure, bodyFontSize: 20, diagramTypography: { nodeFontSize: 20, edgeFontSize: 18 },
    });
    const slide: Slide = { id: 'integer-native-fonts', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { fontName: 'Noto Sans SC', fontColor: '#334155', themeColors: [], backgroundColor: '#FFFFFF' }, elements: content.elements };
    const ratioPx2Pt = 100 / 72;
    const blob = await buildPptxBlob([slide], [], 0.5625, 1000, 100, ratioPx2Pt);
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
    const paragraphs = [...doc.getElementsByTagName('a:p')];
    for (const [text, canvasFont] of [
      ['独立完成吗', 20], ['逐个撤除', 20], ['继续支持', 20], ['能独立完成', 18], ['仍需支持', 18], [source, 20],
    ] as const) {
      const paragraph = paragraphs.find((element) => textOf(element) === text);
      expect(paragraph, `native paragraph ${text}`).toBeDefined();
      const props = [...paragraph!.getElementsByTagName('a:rPr')];
      expect(props.length).toBeGreaterThan(0);
      expect(props.every((prop) => Number(prop.getAttribute('sz')) === Math.round(canvasFont / ratioPx2Pt * 100)), text).toBe(true);
    }
    expect(doc.getElementsByTagName('a:custGeom').length).toBeGreaterThanOrEqual(5);
    expect(doc.getElementsByTagName('p:pic')).toHaveLength(0);
    expect(Object.keys(archive.files).filter((name) => name.startsWith('ppt/media/') && !archive.files[name]!.dir)).toEqual([]);
  });
});

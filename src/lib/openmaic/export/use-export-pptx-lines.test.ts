import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { PPTLineElement, Slide } from '@openmaic/dsl';

vi.mock('@openmaic/lib/store', () => ({ useStageStore: () => ({}) }));
vi.mock('@openmaic/lib/store/canvas', () => ({ useCanvasStore: {} }));
vi.mock('@openmaic/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false, useMediaGenerationStore: { getState: () => ({ tasks: {} }) },
}));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }));
import { buildPptxBlob } from './use-export-pptx';

type Point = [number, number];
const emuPerCanvasUnit = 9144;
const line = (id: string, values: Partial<PPTLineElement>): PPTLineElement => ({
  id, type: 'line', left: 0, top: 0, width: 2.4, start: [0, 0], end: [64, 0],
  points: ['', 'arrow'], style: 'solid', color: '#365D95', ...values,
});
async function nativeLines(elements: PPTLineElement[]) {
  const slide: Slide = { id: 'native-line-export', viewportSize: 1000, viewportRatio: 0.5625,
    theme: { fontName: 'Noto Sans SC', fontColor: '#24364B', backgroundColor: '#FFFFFF', themeColors: [] }, elements };
  const blob = await buildPptxBlob([slide], [], 0.5625, 1000, 100, 100 / 72);
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob);
  });
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const shapes = [...doc.getElementsByTagName('p:sp')];
  expect(shapes).toHaveLength(elements.length);
  expect(doc.getElementsByTagName('p:pic')).toHaveLength(0);
  expect(Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/') && !zip.files[name]!.dir)).toEqual([]);
  return shapes;
}
function geometry(shape: Element) {
  const transform = shape.getElementsByTagName('a:xfrm')[0]!;
  const offset = transform.getElementsByTagName('a:off')[0]!;
  const extent = transform.getElementsByTagName('a:ext')[0]!;
  const path = shape.getElementsByTagName('a:path')[0]!;
  const origin: Point = [Number(offset.getAttribute('x')) / emuPerCanvasUnit, Number(offset.getAttribute('y')) / emuPerCanvasUnit];
  const size: Point = [Number(extent.getAttribute('cx')) / emuPerCanvasUnit, Number(extent.getAttribute('cy')) / emuPerCanvasUnit];
  expect(Number(path.getAttribute('w'))).toBe(Number(extent.getAttribute('cx')));
  expect(Number(path.getAttribute('h'))).toBe(Number(extent.getAttribute('cy')));
  const position = (point: Element): Point => [origin[0] + Number(point.getAttribute('x')) / emuPerCanvasUnit,
    origin[1] + Number(point.getAttribute('y')) / emuPerCanvasUnit];
  for (const point of path.getElementsByTagName('a:pt')) {
    const [x, y] = [Number(point.getAttribute('x')), Number(point.getAttribute('y'))];
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(Number(path.getAttribute('w')) + 1);
    expect(y).toBeLessThanOrEqual(Number(path.getAttribute('h')) + 1);
  }
  return { origin, size, path, position };
}
function expectPoint(actual: Point, expected: Point) {
  expect(actual[0]).toBeCloseTo(expected[0], 3); expect(actual[1]).toBeCloseTo(expected[1], 3);
}
const global = (element: PPTLineElement, point: Point): Point => [element.left + point[0], element.top + point[1]];

describe('editable native curved connector export', () => {
  it('keeps all four real feedback/exit edges with finite viewports, exact endpoints and cubic controls', async () => {
    // Coordinates from the actual Office failure; fix -> inspect is feedback,
    // fix -> finish is the exit. There is no finish -> reproduce relation.
    const elements = [
      line('reproduce-inspect', { left: 412, top: 178 }),
      line('inspect-fix', { left: 660, top: 244, end: [0, 68] }),
      line('fix-inspect', { left: 844, top: 178, start: [0, 175], end: [0, 0],
        cubic: [[109, 175], [109, 0]], style: 'dashed' }),
      line('fix-finish', { left: 228, top: 394, start: [432, 0], end: [0, 0],
        cubic: [[432, 67], [0, 67]] }),
    ];
    const before = structuredClone(elements), shapes = await nativeLines(elements);
    for (const [index, element] of elements.entries()) {
      const shape = shapes[index]!, { size, path, position } = geometry(shape);
      expectPoint(position(path.getElementsByTagName('a:moveTo')[0]!.getElementsByTagName('a:pt')[0]!), global(element, element.start));
      const curve = path.getElementsByTagName('a:cubicBezTo')[0];
      const end = curve ? curve.getElementsByTagName('a:pt')[2]! : path.getElementsByTagName('a:lnTo')[0]!.getElementsByTagName('a:pt')[0]!;
      expectPoint(position(end), global(element, element.end));
      if (element.cubic) {
        expect(size[0]).toBeGreaterThan(0); expect(size[1]).toBeGreaterThan(0);
        expect(path.getElementsByTagName('a:lnTo')).toHaveLength(0);
        const points = curve!.getElementsByTagName('a:pt');
        expectPoint(position(points[0]!), global(element, element.cubic[0]));
        expectPoint(position(points[1]!), global(element, element.cubic[1]));
      } else expect(curve).toBeUndefined();
      expect(shape.getElementsByTagName('a:tailEnd')[0]!.getAttribute('type')).toBe('arrow');
      expect(shape.getElementsByTagName('a:prstDash')[0]!.getAttribute('val')).toBe(element.style === 'dashed' ? 'dash' : 'solid');
    }
    expect(elements).toEqual(before);
    expect(shapes.filter((shape) => shape.getElementsByTagName('a:cubicBezTo').length)).toHaveLength(2);
    expectPoint(geometry(shapes[2]!).size, [109, 175]);
    expectPoint(geometry(shapes[3]!).size, [432, 67]);
  });

  it('translates a negative cubic control hull together with its native viewport, leaving global positions unchanged', async () => {
    const element = line('negative-cubic', { left: 100, top: 200, end: [20, 0], cubic: [[-40, -30], [40, 60]] });
    const [shape] = await nativeLines([element]);
    const { origin, size, path, position } = geometry(shape!);
    expectPoint(origin, [60, 170]); expectPoint(size, [80, 90]);
    expectPoint(position(path.getElementsByTagName('a:moveTo')[0]!.getElementsByTagName('a:pt')[0]!), [100, 200]);
    const points = path.getElementsByTagName('a:cubicBezTo')[0]!.getElementsByTagName('a:pt');
    expectPoint(position(points[0]!), [60, 170]); expectPoint(position(points[1]!), [140, 260]);
    expectPoint(position(points[2]!), [120, 200]);
  });

  it('keeps quadratic controls native and normalizes their real overhang instead of deleting the bend', async () => {
    const element = line('negative-quadratic', { left: 140, top: 220, start: [20, 0], end: [0, 0], curve: [-30, 40] });
    const [shape] = await nativeLines([element]);
    const { origin, size, path, position } = geometry(shape!);
    expectPoint(origin, [110, 220]); expectPoint(size, [50, 40]);
    const points = path.getElementsByTagName('a:quadBezTo')[0]!.getElementsByTagName('a:pt');
    expectPoint(position(points[0]!), [110, 260]); expectPoint(position(points[1]!), [140, 220]);
    expect(path.getElementsByTagName('a:cubicBezTo')).toHaveLength(0);
  });

  it('preserves ordinary straight forward, backward and vertical endpoints and arrow styles', async () => {
    const elements = [line('forward', { left: 200, top: 100 }),
      line('backward', { left: 200, top: 150, start: [64, 0], end: [0, 0], points: ['arrow', 'arrow'] }),
      line('vertical', { left: 300, top: 100, end: [0, 68] })];
    const shapes = await nativeLines(elements);
    for (const [index, element] of elements.entries()) {
      const { origin, path, position } = geometry(shapes[index]!);
      expectPoint(origin, [element.left, element.top]);
      expectPoint(position(path.getElementsByTagName('a:moveTo')[0]!.getElementsByTagName('a:pt')[0]!), global(element, element.start));
      expectPoint(position(path.getElementsByTagName('a:lnTo')[0]!.getElementsByTagName('a:pt')[0]!), global(element, element.end));
      expect(path.getElementsByTagName('a:cubicBezTo')).toHaveLength(0);
      expect(shapes[index]!.getElementsByTagName('a:headEnd')[0]!.getAttribute('type')).toBe(element.points[0] ? 'arrow' : 'none');
    }
  });

  it('retains a broken connector whose real bend falls outside the endpoint rectangle', async () => {
    const element = line('broken-overhang', { left: 300, top: 200, end: [60, 0], broken: [-40, 80] });
    const [shape] = await nativeLines([element]);
    const { origin, size, path, position } = geometry(shape!);
    expectPoint(origin, [260, 200]); expectPoint(size, [100, 80]);
    const segments = path.getElementsByTagName('a:lnTo');
    expect(segments).toHaveLength(2);
    expectPoint(position(segments[0]!.getElementsByTagName('a:pt')[0]!), [260, 280]);
    expectPoint(position(segments[1]!.getElementsByTagName('a:pt')[0]!), [360, 200]);
  });
});

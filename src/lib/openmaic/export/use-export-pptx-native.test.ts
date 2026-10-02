import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { PPTElement, PPTTableElement, Slide } from '@openmaic/dsl';

vi.mock('@openmaic/lib/store', () => ({ useStageStore: () => ({}) }));
vi.mock('@openmaic/lib/store/canvas', () => ({ useCanvasStore: {} }));
vi.mock('@openmaic/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false, useMediaGenerationStore: { getState: () => ({ tasks: {} }) },
}));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }));

import { buildPptxBlob } from './use-export-pptx';

const ratioPx2Pt = 100 / 72;
const table = (texts: string[]): PPTTableElement => ({
  id: 'comparison', type: 'table', left: 50, top: 100, width: 900, height: 180, rotate: 0,
  colWidths: texts.map(() => 1 / texts.length), cellMinHeight: 60, outline: { color: '#D7DFE7', width: 1, style: 'solid' },
  data: [texts.map((text, index) => ({ id: `cell-${index}`, colspan: 1, rowspan: 1, text,
    padding: '10px 20px', vAlign: 'top', style: { fontsize: '20px', fontname: 'Noto Sans SC', backcolor: '#EEF3F8', bold: false } }))],
});

async function nativeSlide(elements: PPTElement[]) {
  const slide: Slide = { id: 'native-export', viewportSize: 1000, viewportRatio: 0.5625,
    theme: { fontName: 'Noto Sans SC', fontColor: '#253448', backgroundColor: '#fff', themeColors: [] }, elements };
  const blob = await buildPptxBlob([slide], [], 0.5625, 1000, 100, ratioPx2Pt);
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return { doc, xml, zip };
}

const textOf = (node: Element) => [...node.getElementsByTagName('a:t')].map((text) => text.textContent).join('');

describe('editable native table export', () => {
  it('exports Chinese, English and exact symbols as text rather than literal cell markup', async () => {
    const { doc, xml, zip } = await nativeSlide([table([
      '<p style="font-size:20px;color:#365B9D;font-weight:700">支架 <strong>逐个撤除</strong></p>',
      '<p>Duplicates allowed &amp; preserved</p>',
      '<p>&quot;A&amp;B&quot; &lt;3&gt; &#215; &#x03BC; &#39; &nbsp; &amp;lt;tag&amp;gt;</p>',
    ])]);
    expect([...doc.getElementsByTagName('a:tc')].map(textOf)).toEqual([
      '支架 逐个撤除', 'Duplicates allowed & preserved', '"A&B" <3> × μ \' \u00a0 &lt;tag&gt;',
    ]);
    expect(xml).not.toContain('&lt;p style');
    expect(xml).not.toContain('&lt;strong&gt;');
    expect(doc.getElementsByTagName('a:tbl')).toHaveLength(1);
    expect(Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/') && !zip.files[name]!.dir)).toEqual([]);
  });

  it('keeps run formatting, fractional fonts, cell fill, spacing and alignment editable', async () => {
    const element = table(['<p style="font-size:20.5px;color:#365B9D;text-align:center;font-weight:400">普通 <strong>强调</strong><em> italic</em><u> underline</u></p>']);
    element.data[0]![0]!.borders = { bottom: { color: '#365B9D', width: 2, style: 'solid' } };
    const { doc } = await nativeSlide([element]);
    const cell = doc.getElementsByTagName('a:tc')[0]!;
    const runs = [...cell.getElementsByTagName('a:r')];
    const emphasized = runs.find((run) => textOf(run) === '强调')!;
    const props = emphasized.getElementsByTagName('a:rPr')[0]!;
    expect(props.getAttribute('b')).toBe('1');
    expect(Number(props.getAttribute('sz'))).toBe(Math.round(20.5 / ratioPx2Pt * 100));
    expect(props.getElementsByTagName('a:srgbClr')[0]!.getAttribute('val')).toBe('365B9D');
    expect(props.getElementsByTagName('a:latin')[0]!.getAttribute('typeface')).toBe('Noto Sans SC');
    expect(runs.find((run) => textOf(run).includes('italic'))!.getElementsByTagName('a:rPr')[0]!.getAttribute('i')).toBe('1');
    expect(runs.find((run) => textOf(run).includes('underline'))!.getElementsByTagName('a:rPr')[0]!.getAttribute('u')).toBe('sng');
    expect(cell.getElementsByTagName('a:pPr')[0]!.getAttribute('algn')).toBe('ctr');
    const cellProps = cell.getElementsByTagName('a:tcPr')[0]!;
    expect(cellProps.getAttribute('marL')).toBe(String(20 * 9144));
    expect(cellProps.getAttribute('marT')).toBe(String(10 * 9144));
    expect(cellProps.getAttribute('anchor')).toBe('t');
    expect([...cellProps.getElementsByTagName('a:srgbClr')].some((color) => color.getAttribute('val') === 'EEF3F8')).toBe(true);
    expect(cellProps.getElementsByTagName('a:lnB')[0]!.getAttribute('w')).toBe(String(2 / ratioPx2Pt * 12700));
  });

  it('retains paragraphs, br elements, plain newlines and an empty header cell', async () => {
    const { doc } = await nativeSlide([table([
      '<p>第一行</p><p>Second line<br>第三行</p>',
      '中文\nEnglish &amp; value',
      '<p style="font-size:20px;font-weight:700"></p>',
    ])]);
    const cells = [...doc.getElementsByTagName('a:tc')];
    expect([...cells[0]!.getElementsByTagName('a:p')].map(textOf).filter(Boolean)).toEqual(['第一行', 'Second line', '第三行']);
    expect([...cells[1]!.getElementsByTagName('a:p')].map(textOf).filter(Boolean)).toEqual(['中文', 'English & value']);
    expect(textOf(cells[2]!)).toBe('');
  });
});

describe('editable native custom shape export', () => {
  it('retains rectangular backgrounds and the learner torso as custom geometry, with no images', async () => {
    const { doc, zip } = await nativeSlide([
      { id: 'background', type: 'shape', left: 50, top: 100, width: 300, height: 80, rotate: 0,
        path: 'M0 0H100V60H0Z', viewBox: [100, 60], fill: '#E6F4F1', fixedRatio: false },
      { id: 'learner', type: 'shape', left: 450, top: 100, width: 56, height: 90, rotate: 0,
        path: 'M5 13Q0 15 0 20V28H5V45H11V30H17V45H23V28H28V20Q28 15 23 13Z', viewBox: [28, 45], fill: '#287F79', fixedRatio: false },
    ]);
    const geometry = [...doc.getElementsByTagName('a:custGeom')];
    expect(geometry).toHaveLength(2);
    expect(geometry[0]!.getElementsByTagName('a:lnTo')).toHaveLength(3);
    expect(geometry[0]!.getElementsByTagName('a:close')).toHaveLength(1);
    expect(geometry[1]!.getElementsByTagName('a:lnTo')).toHaveLength(11);
    expect(geometry[1]!.getElementsByTagName('a:quadBezTo')).toHaveLength(2);
    expect(geometry[1]!.getElementsByTagName('a:close')).toHaveLength(1);
    expect([...doc.getElementsByTagName('a:srgbClr')].map((color) => color.getAttribute('val'))).toEqual(expect.arrayContaining(['E6F4F1', '287F79']));
    expect(doc.getElementsByTagName('p:pic')).toHaveLength(0);
    expect(Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/') && !zip.files[name]!.dir)).toEqual([]);
  });
});

describe('editable native chart export', () => {
  it('keeps real series names, exact decimal values and native labels at the adopted font size', async () => {
    const { zip, doc } = await nativeSlide([{
      id: 'measurements', type: 'chart', chartType: 'bar', left: 50, top: 100, width: 500, height: 300, rotate: 0,
      data: { labels: ['周一', 'Tuesday'], legends: ['示例耗电量'], series: [[12.5, 10.25]] },
      options: { fontSize: 18 }, themeColors: ['#365B9D', '#287A70', '#B8752B'], textColor: '#253448', lineColor: '#D7DFE7',
    }]);
    expect(doc.getElementsByTagName('c:chart')).toHaveLength(1);
    const xml = await zip.file('ppt/charts/chart1.xml')!.async('string');
    const chart = new DOMParser().parseFromString(xml, 'application/xml');
    const series = chart.getElementsByTagName('c:ser')[0]!;
    expect([...series.getElementsByTagName('c:v')].map((value) => value.textContent)).toEqual(expect.arrayContaining(['示例耗电量', '周一', 'Tuesday', '12.5', '10.25']));
    expect(chart.getElementsByTagName('c:showVal')[0]!.getAttribute('val')).toBe('1');
    const labelFormat = [...chart.getElementsByTagName('c:numFmt')].find((format) => format.parentElement?.localName === 'dLbls');
    expect(labelFormat!.getAttribute('formatCode')).toBe('General');
    const labels = chart.getElementsByTagName('c:dLbls')[0]!;
    expect(labels.getElementsByTagName('a:defRPr')[0]!.getAttribute('sz')).toBe(String(Math.round(18 / ratioPx2Pt * 100)));
    expect(labels.getElementsByTagName('a:latin')[0]!.getAttribute('typeface')).toBe('Noto Sans SC');
    expect(doc.getElementsByTagName('p:pic')).toHaveLength(0);
  });
});

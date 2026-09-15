/** Bounded export acceptance: real browser exporter, frozen generated DSL, no importer changes. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const JSZip = require('jszip');
const root = process.cwd();
const source = path.join(root, '.openpbl-runtime/first-pass-benchmark-final');
const output = path.join(source, 'export-compatibility');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['01-budget-1', '01-budget-2', '02-budget-2'];
await mkdir(output, { recursive: true });
const entry = `import { buildPptxBlob } from ${JSON.stringify(path.join(root, 'src/lib/openmaic/export/use-export-pptx.ts'))};
window.exportFrozenSlide = async (content,id) => { const slide={id,viewportSize:1000,viewportRatio:0.5625,...content}; const scene={id,stageId:'export-test',type:'slide',title:id,order:0,actions:[],content:{type:'slide',canvas:slide}}; const blob=await buildPptxBlob([slide],[scene],0.5625,1000,100,100/72); return Array.from(new Uint8Array(await blob.arrayBuffer())); };`;
await writeFile(path.join(output, 'entry.ts'), entry);
await build({ entryPoints: [path.join(output, 'entry.ts')], outfile: path.join(output, 'export.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'disable-external-generation', setup(build) {
  build.onResolve({ filter: /^@openmaic\/lib\/(?:store(?:\/canvas|\/media-generation)?|hooks\/use-i18n)$/ }, () => ({ path: 'unused-app-stores', namespace: 'app-stores' }));
  build.onLoad({ filter: /.*/, namespace: 'app-stores' }, () => ({ contents: 'export const useStageStore=()=>({});export const useCanvasStore={use:{viewportSize:()=>1000,viewportRatio:()=>0.5625}};export const useMediaGenerationStore={getState:()=>({tasks:{}})};export const isMediaPlaceholder=()=>false;export const useI18n=()=>({t:(s)=>s});' }));
  build.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'settings', namespace: 'isolated' }));
  build.onLoad({ filter: /settings/, namespace: 'isolated' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"};export const useSettingsStore=Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' }));
  build.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'media', namespace: 'isolated' }));
  build.onLoad({ filter: /media/, namespace: 'isolated' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("No media generation in export test")}export async function generateMediaForOutlines(){throw new Error("No media generation in export test")}' }));
} }] });
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', request.url === '/export.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/export.js' ? await readFile(path.join(output, 'export.js')) : '<!doctype html><meta charset="utf-8"><script src="/export.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const reports = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.exportFrozenSlide === 'function');
  for (const id of ids) {
    const result = JSON.parse(await readFile(path.join(source, 'results', `${id}.json`), 'utf8'));
    const content = result.final;
    if (!content?.elements?.length) throw new Error(`No final DSL: ${id}`);
    const data = Buffer.from(await page.evaluate(({ content, id }) => window.exportFrozenSlide(content, id), { content, id }));
    await writeFile(path.join(output, `${id}.pptx`), data);
    const zip = await JSZip.loadAsync(data, { checkCRC32: true });
    const names = Object.keys(zip.files);
    const xmlFiles = await Promise.all(names.filter((name) => name.endsWith('.xml') || name.endsWith('.rels')).map(async (name) => ({ name, xml: await zip.file(name).async('string') })));
    const inspected = await page.evaluate(({ xmlFiles, elements }) => {
      const parsed = xmlFiles.map(({ name, xml }) => ({ name, doc: new DOMParser().parseFromString(xml, 'application/xml') }));
      const malformed = parsed.filter(({ doc }) => doc.querySelector('parsererror')).map(({ name }) => name);
      const slide = parsed.find(({ name }) => name === 'ppt/slides/slide1.xml').doc;
      const presentation = parsed.find(({ name }) => name === 'ppt/presentation.xml').doc;
      const size = presentation.getElementsByTagName('p:sldSz')[0];
      const tree = slide.getElementsByTagName('p:spTree')[0];
      const exportedObjects = [...tree.children].flatMap((el) => el.localName === 'AlternateContent' ? [...(el.getElementsByTagName('mc:Choice')[0]?.children ?? [])] : [el]);
      const boxes = exportedObjects.filter((el) => ['sp', 'pic', 'graphicFrame'].includes(el.localName)).map((el) => {
        const xfrm = el.getElementsByTagName('a:xfrm')[0] ?? el.getElementsByTagName('p:xfrm')[0];
        const off = xfrm?.getElementsByTagName('a:off')[0], ext = xfrm?.getElementsByTagName('a:ext')[0];
        return { kind: el.localName, text: [...el.getElementsByTagName('a:t')].map((n) => n.textContent).join(''), ...(off && ext ? { left: Number(off.getAttribute('x')) / 9144, top: Number(off.getAttribute('y')) / 9144, width: Number(ext.getAttribute('cx')) / 9144, height: Number(ext.getAttribute('cy')) / 9144 } : {}) };
      });
      const coordinates = elements.filter((e) => 'height' in e && e.type !== 'line').map((element) => {
        const match = boxes.find((box) => ['left', 'top', 'width', 'height'].every((key) => Math.abs(box[key] - element[key]) < 0.02));
        return { id: element.id, type: element.type, matched: Boolean(match), original: { left: element.left, top: element.top, width: element.width, height: element.height } };
      });
      const allText = boxes.map((box) => box.text).join('');
      const normalize = (s) => s.replace(/\s+/g, '');
      const textPresence = elements.filter((e) => e.type === 'text').map((e) => { const node = new DOMParser().parseFromString(e.content, 'text/html'); const text = node.body.textContent || ''; return { id: e.id, text, present: normalize(allText).includes(normalize(text)) }; });
      const formulaCount = slide.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'oMath').length;
      const chartFiles = parsed.filter(({ name }) => /^ppt\/charts\/chart[^/]+\.xml$/.test(name));
      return { malformed, slideSizePx: { width: Number(size.getAttribute('cx')) / 9144, height: Number(size.getAttribute('cy')) / 9144 }, boxes, coordinates, textPresence, formulaCount, formulaText: [...slide.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 't')].map((node) => node.textContent).join(''), charts: chartFiles.map(({ name, doc }) => ({ name, values: [...doc.getElementsByTagName('c:v')].map((e) => e.textContent) })) };
    }, { xmlFiles, elements: content.elements });
    const report = { id, bytes: data.length, zipEntries: names.length, sourceTypes: [...new Set(content.elements.map((e) => e.type))], ...inspected,
      passed: inspected.malformed.length === 0 && inspected.coordinates.every((c) => c.matched) && inspected.textPresence.every((t) => t.present) && inspected.formulaCount === content.elements.filter((e) => e.type === 'latex').length && inspected.charts.length === content.elements.filter((e) => e.type === 'chart').length, browserErrors: [...errors] };
    reports.push(report);
    await writeFile(path.join(output, `${id}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id, passed: report.passed, coordinates: inspected.coordinates.length, missingCoordinates: inspected.coordinates.filter((c) => !c.matched), textBoxes: inspected.textPresence.length, formulaCount: inspected.formulaCount, chartCount: inspected.charts.length }));
  }
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ method: 'Existing buildPptxBlob in real Chromium; ZIP CRC and XML parse; text and geometry checks', reports }, null, 2));
} finally { await browser.close(); server.close(); }

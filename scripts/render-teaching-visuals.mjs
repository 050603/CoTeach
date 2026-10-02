/** Render every saved attempt and inspect native PPTX exports. No model calls,
 * course writes, shared builds or generation of new media occurs here.
 * node scripts/render-teaching-visuals.mjs --output=.openpbl-runtime/teaching-visuals/samples
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, cp, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((value) => { const [name, ...pieces] = value.replace(/^--/, '').split('='); return [name, pieces.join('=') || 'true']; }));
if (args.has('help')) { console.log('--output=.openpbl-runtime/基准目录 [--ids=case-id,...] [--skip-export] [--deck-name=course-slide-samples.pptx] [--gallery-title=同课页面样本]\n指定 deck-name 或 gallery-title 时，合并全部选中案例的采用页，并按 source.pageNumber（原课1基页号）及续页顺序排列。'); process.exit(0); }
if (!args.has('output')) throw new Error('需要 --output 基准目录');
const output = path.resolve(root, args.get('output'));
if (!output.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('所有输出必须位于 .openpbl-runtime 隔离目录');
const selectedIds = args.get('ids')?.split(',');
const courseGallery = args.has('deck-name') || args.has('gallery-title');
const combinedDeckId = args.get('deck-name')?.replace(/\.pptx$/iu, '') ?? (courseGallery ? 'course-slide-samples' : 'eight-design-specimens');
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(combinedDeckId) || combinedDeckId === 'true') throw new Error('deck-name 必须是安全的文件名，不包含目录，例如 course-slide-samples.pptx');
const galleryTitle = args.get('gallery-title') ?? (courseGallery ? '同一课程的教学图解样本' : '以教学图解为核心的视觉构件');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const JSZip = require('jszip');
const exportImplementationFiles = ['src/lib/openmaic/export/use-export-pptx.ts', 'src/lib/openmaic/export/svg-path-parser.ts',
  'src/lib/openmaic/export/html-parser/index.ts', 'src/lib/openmaic/export/html-parser/format.ts',
  'src/lib/openmaic/export/html-parser/parser.ts', 'src/lib/openmaic/export/html-parser/lexer.ts',
  'scripts/render-teaching-visuals.mjs', 'scripts/teaching-visual-acceptance-render.tsx', 'scripts/approved-visual-render-inspection.ts'];
async function exportFingerprint() {
  const files = await Promise.all(exportImplementationFiles.map(async (filename) => ({ filename, body: await readFile(path.join(root, filename), 'utf8') })));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
const exportImplementationSha256 = await exportFingerprint();
const runtime = path.join(output, 'acceptance-browser');
await mkdir(runtime, { recursive: true });
await mkdir(path.join(output, 'renders'), { recursive: true });
await mkdir(path.join(output, 'exports'), { recursive: true });
const rendererPlugins = [{ name: 'isolated-readonly-assets', setup(builder) {
  builder.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'settings', namespace: 'settings' }));
  builder.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"};export const useSettingsStore=Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' }));
  builder.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-generation', namespace: 'generation' }));
  builder.onLoad({ filter: /.*/, namespace: 'generation' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Media generation is disabled in visual acceptance")}export async function generateMediaForOutlines(){throw new Error("Media generation is disabled in visual acceptance")}' }));
} }];
await build({ absWorkingDir: root, entryPoints: ['scripts/teaching-visual-acceptance-render.tsx'], outfile: path.join(runtime, 'render.js'), bundle: true,
  platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: rendererPlugins });
const exportEntry = `import {buildPptxBlob} from ${JSON.stringify(path.join(root, 'src/lib/openmaic/export/use-export-pptx.ts'))};
import {getLineElementPath} from ${JSON.stringify(path.join(root, 'src/lib/openmaic/utils/element.ts'))};
import {SVGPathData} from 'svg-pathdata';
const sourceGeometry=(el)=>{
  if(el.type!=='line'&&(el.type!=='shape'||el.special))return undefined;
  const scale=el.type==='line'?{x:1,y:1}:{x:el.width/el.viewBox[0],y:el.height/el.viewBox[1]};
  const commands=new SVGPathData(el.type==='line'?getLineElementPath(el):el.path).toAbs().normalizeHVZ(false,true,true).normalizeST().aToC().commands;
  return commands.map(command=>{
    const type={1:'close',2:'moveTo',16:'lnTo',32:'cubicBezTo',128:'quadBezTo'}[command.type];
    if(!type)throw new Error('Unsupported source geometry command '+command.type);
    const points=[];
    if(command.type===32||command.type===128)points.push({x:command.x1,y:command.y1});
    if(command.type===32)points.push({x:command.x2,y:command.y2});
    if(command.type!==1)points.push({x:command.x,y:command.y});
    return {type,points:points.map(point=>({x:el.left+point.x*scale.x,y:el.top+point.y*scale.y}))};
  });
};
window.exportTeachingVisual=async(pages,id)=>{
  const slides=pages.map((content,index)=>({id:id+':'+index,viewportSize:1000,viewportRatio:0.5625,...content}));
  const scenes=slides.map((canvas,index)=>({id:canvas.id,stageId:'acceptance-export',type:'slide',title:id,order:index,actions:[],content:{type:'slide',canvas}}));
  const blob=await buildPptxBlob(slides,scenes,0.5625,1000,100,100/72);
  return {bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),expected:slides.map(slide=>slide.elements.map(el=>{
    const geometry=sourceGeometry(el),hull=geometry?.flatMap(command=>command.points);
    const lineBounds=el.type==='line'&&hull.length?{left:Math.min(...hull.map(point=>point.x)),top:Math.min(...hull.map(point=>point.y)),
      width:Math.max(...hull.map(point=>point.x))-Math.min(...hull.map(point=>point.x)),height:Math.max(...hull.map(point=>point.y))-Math.min(...hull.map(point=>point.y))}:{};
    return {id:el.id,type:el.type,left:el.left,top:el.top,width:el.width,height:el.height,...lineBounds,geometry,
      lineStyle:el.type==='line'?{beginArrow:el.points[0]?'arrow':'none',endArrow:el.points[1]?'arrow':'none',dash:{solid:'solid',dashed:'dash',dotted:'sysDot'}[el.style]}:undefined,
      html:el.type==='text'?el.content:el.type==='shape'?el.text?.content:undefined,data:el.type==='chart'?el.data:undefined,
      tableCells:el.type==='table'?el.data.flat().map(cell=>cell.text):undefined,
      shapeCommands:geometry?.filter(command=>command.type!=='close').length};
  }))};
};`;
await writeFile(path.join(runtime, 'export-entry.ts'), exportEntry);
await build({ entryPoints: [path.join(runtime, 'export-entry.ts')], outfile: path.join(runtime, 'export.js'), bundle: true, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'unused-export-hooks', setup(builder) {
    builder.onResolve({ filter: /^@openmaic\/lib\/(?:store(?:\/canvas|\/media-generation)?|hooks\/use-i18n)$/ }, () => ({ path: 'unused-export-hooks', namespace: 'export-hooks' }));
    builder.onLoad({ filter: /.*/, namespace: 'export-hooks' }, () => ({ contents: 'export const useStageStore=()=>({});export const useCanvasStore={use:{viewportSize:()=>1000,viewportRatio:()=>0.5625}};export const useMediaGenerationStore={getState:()=>({tasks:{}})};export const isMediaPlaceholder=()=>false;export const useI18n=()=>({t:(s)=>s});' }));
  } }, ...rendererPlugins] });
const staticRoot = path.join(runtime, 'static');
const productionStatic = path.join(root, process.env.NEXT_DIST_DIR || '.next-build', 'static');
await cp(path.join(productionStatic, 'css'), path.join(staticRoot, 'css'), { recursive: true });
await cp(path.join(productionStatic, 'media'), path.join(staticRoot, 'media'), { recursive: true });
const cssFiles = (await readdir(path.join(staticRoot, 'css'), { recursive: true })).filter((filename) => filename.endsWith('.css'));
if (!cssFiles.length) throw new Error('缺少生产 CSS，不能声明真实渲染验收');
const cssFingerprint = createHash('sha256').update(Buffer.concat(await Promise.all(cssFiles.map((filename) => readFile(path.join(staticRoot, 'css', filename)))))).digest('hex');
const mime = (filename) => filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.woff2') ? 'font/woff2' : filename.endsWith('.png') ? 'image/png' : 'application/octet-stream';
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8">' + cssFiles.map((css) => `<link rel="stylesheet" href="/_next/static/css/${css}">`).join('')
        + '<style>html,body{margin:0;background:#eef2f6}#root{width:1000px;height:562.5px}</style></head><body><div id="root"></div><script src="/render.js"></script><script src="/export.js"></script></body></html>');
      return;
    }
    const filename = ['/render.js', '/export.js'].includes(url.pathname) ? path.join(runtime, path.basename(url.pathname))
      : url.pathname.startsWith('/_next/static/') ? path.resolve(staticRoot, '.' + url.pathname.slice('/_next/static'.length))
        : url.pathname.startsWith('/renders/') ? path.resolve(output, '.' + url.pathname) : undefined;
    if (!filename || !(filename.startsWith(runtime + path.sep) || filename.startsWith(path.join(output, 'renders') + path.sep))) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', mime(filename)); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser, browserError;
for (const executablePath of [...new Set([process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH, undefined, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])]) {
  if (executablePath && !await access(executablePath).then(() => true, () => false)) continue;
  try { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); break; } catch (error) { browserError = error; }
}
if (!browser) { server.close(); throw browserError ?? new Error('缺少Chromium'); }
const origin = `http://127.0.0.1:${server.address().port}`;
const context = await browser.newContext({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 1 });
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() === 'GET' && (url.origin === origin || ['blob:', 'data:'].includes(url.protocol))) await route.continue();
  else await route.abort();
});
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(error.message));
await page.goto(origin);
await page.waitForFunction(() => typeof window.renderTeachingVisual === 'function' && typeof window.exportTeachingVisual === 'function');
const renderReports = [], exportReports = [], sampleFigures = [], samplePages = [], courseFigures = [], actualCourseFigures = [], selectedCourseFigures = [], selectedCoursePages = [];
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const originalPageNumber = (result) => result.source?.pageNumber ?? result.coursePage?.pageNumber ?? (result.caseId === 'original-page-19' ? 19 : undefined);

async function exportAndInspect(pages, id) {
  browserErrors.length = 0;
  const exported = await page.evaluate(({ pages, id }) => window.exportTeachingVisual(pages, id), { pages, id });
  const body = Buffer.from(exported.bytes);
  await writeFile(path.join(output, 'exports', `${id}.pptx`), body);
  const zip = await JSZip.loadAsync(body, { checkCRC32: true });
  const xmlFiles = await Promise.all(Object.keys(zip.files).filter((filename) => /\.(?:xml|rels)$/u.test(filename)).map(async (name) => ({ name, xml: await zip.file(name).async('string') })));
  const report = await page.evaluate(({ xmlFiles, expected }) => {
    const parsed = xmlFiles.map(({ name, xml }) => ({ name, doc: new DOMParser().parseFromString(xml, 'application/xml') }));
    const malformed = parsed.filter(({ doc }) => doc.querySelector('parsererror')).map(({ name }) => name);
    const normalize = (value) => value.replace(/\s+/gu, '');
    const sourcePages = expected.map((elements, index) => {
      const doc = parsed.find(({ name }) => name === `ppt/slides/slide${index + 1}.xml`)?.doc;
      if (!doc) return { index, missing: true, coordinates: [], text: [] };
      const tree = doc.getElementsByTagName('p:spTree')[0];
      const objects = [...tree.children].flatMap((item) => item.localName === 'AlternateContent' ? [...(item.getElementsByTagName('mc:Choice')[0]?.children ?? [])] : [item]);
      const nativeBox = (item) => {
        const xfrm = item.getElementsByTagName('a:xfrm')[0] ?? item.getElementsByTagName('p:xfrm')[0];
        const off = xfrm?.getElementsByTagName('a:off')[0], ext = xfrm?.getElementsByTagName('a:ext')[0];
        const bounds = off && ext ? { left: Number(off.getAttribute('x')) / 9144, top: Number(off.getAttribute('y')) / 9144,
          width: Number(ext.getAttribute('cx')) / 9144, height: Number(ext.getAttribute('cy')) / 9144 } : {};
        let validViewport = true;
        const geometry = [...item.getElementsByTagName('a:path')].flatMap((path) => {
          const width = Number(path.getAttribute('w')), height = Number(path.getAttribute('h'));
          return [...path.children].map((command) => ({ type: command.localName,
            points: [...command.getElementsByTagName('a:pt')].map((point) => {
              const x = Number(point.getAttribute('x')), y = Number(point.getAttribute('y'));
              if ((width === 0 && (x !== 0 || bounds.width !== 0)) || (height === 0 && (y !== 0 || bounds.height !== 0))) validViewport = false;
              return { x: bounds.left + (width ? x / width * bounds.width : 0), y: bounds.top + (height ? y / height * bounds.height : 0) };
            }) }));
        });
        const line = item.getElementsByTagName('a:ln')[0];
        return { kind: item.localName, text: [...item.getElementsByTagName('a:t')].map((text) => text.textContent).join(''),
          geometry, validViewport, geometryCommands: geometry.filter((command) => command.type !== 'close').length,
          lineStyle: { beginArrow: line?.getElementsByTagName('a:headEnd')[0]?.getAttribute('type') ?? 'none',
            endArrow: line?.getElementsByTagName('a:tailEnd')[0]?.getAttribute('type') ?? 'none',
            dash: line?.getElementsByTagName('a:prstDash')[0]?.getAttribute('val') ?? 'solid' }, ...bounds };
      };
      const nativeObjects = objects.filter((item) => ['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(item.localName));
      const boxes = nativeObjects.map(nativeBox);
      const geometryMatches = (element, box) => !element.geometry || (box.validViewport && element.geometry.length === box.geometry.length
        && element.geometry.every((command, index) => command.type === box.geometry[index].type && command.points.length === box.geometry[index].points.length
          && command.points.every((point, pointIndex) => ['x', 'y'].every((axis) => Math.abs(point[axis] - box.geometry[index].points[pointIndex][axis]) < 0.1))));
      const lineStyleMatches = (element, box) => !element.lineStyle || ['beginArrow', 'endArrow', 'dash'].every((key) => element.lineStyle[key] === box.lineStyle[key]);
      const matches = (element, box) => ['left', 'top', 'width', 'height'].every((key) => Math.abs(box[key] - element[key]) < 0.1)
        && geometryMatches(element, box) && lineStyleMatches(element, box)
        && (element.type !== 'text' || normalize(box.text) === normalize(new DOMParser().parseFromString(element.html ?? '', 'text/html').body.textContent || ''));
      const available = [...boxes];
      const coordinates = elements.map((element) => {
        // Geometry and text decide between all objects sharing a rectangle;
        // source-map proxy shapes must never consume their text overlay.
        const match = available.findIndex((box) => matches(element, box));
        const box = match >= 0 ? available[match] : undefined;
        if (match >= 0) available.splice(match, 1);
        return { id: element.id, type: element.type, matched: match >= 0,
          ...(element.geometry ? { sourceGeometryCommands: element.shapeCommands, nativeGeometryCommands: box?.geometryCommands ?? 0,
            geometryCommandsPreserved: Boolean(box && geometryMatches(element, box)), globalPointsPreserved: Boolean(box && geometryMatches(element, box)),
            finiteGeometryViewport: Boolean(box?.validViewport) } : {}),
          ...(element.lineStyle ? { arrowAndDashPreserved: Boolean(box && lineStyleMatches(element, box)) } : {}) };
      });
      // Exercise the actual XML checker with the observed zero-viewport bug,
      // missing geometry, changed controls and lost directed-line semantics.
      const geometryRejectionChecks = [];
      for (const element of elements.filter((element) => element.geometry)) {
        const index = boxes.findIndex((box) => matches(element, box));
        if (index < 0) continue;
        const item = nativeObjects[index], curve = item.getElementsByTagName('a:cubicBezTo')[0] ?? item.getElementsByTagName('a:quadBezTo')[0];
        const check = (name, mutate) => {
          const corrupted = item.cloneNode(true); mutate(corrupted);
          geometryRejectionChecks.push({ id: element.id, name, rejected: !matches(element, nativeBox(corrupted)) });
        };
        check('missing-path-command', (clone) => { const command = clone.getElementsByTagName('a:path')[0].firstElementChild; command.remove(); });
        if (curve) {
          check('changed-control-point', (clone) => { const point = clone.getElementsByTagName('a:cubicBezTo')[0]?.firstElementChild ?? clone.getElementsByTagName('a:quadBezTo')[0].firstElementChild; point.setAttribute('x', String(Number(point.getAttribute('x')) + 9144)); });
          const axis = element.width > 0 ? 'w' : 'h';
          check('zero-viewport-with-nonconstant-points', (clone) => { clone.getElementsByTagName('a:path')[0].setAttribute(axis, '0'); });
        }
        if (element.lineStyle?.endArrow === 'arrow') check('lost-arrowhead', (clone) => { clone.getElementsByTagName('a:tailEnd')[0].setAttribute('type', 'none'); });
        if (element.lineStyle?.dash === 'dash') check('lost-dashed-condition', (clone) => { clone.getElementsByTagName('a:prstDash')[0].setAttribute('val', 'solid'); });
      }
      const allText = boxes.map((box) => box.text).join('');
      const text = elements.filter((element) => element.html).map((element) => {
        const plain = new DOMParser().parseFromString(element.html, 'text/html').body.textContent || '';
        return { id: element.id, text: plain, present: normalize(allText).includes(normalize(plain)) };
      });
      const tableText = elements.flatMap((element) => (element.tableCells ?? []).map((html, cellIndex) => {
        const plain = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
        return { id: element.id, cellIndex, text: plain, present: normalize(allText).includes(normalize(plain)),
          literalMarkup: html !== plain && normalize(allText).includes(normalize(html)) };
      }));
      const imageCount = doc.getElementsByTagName('p:pic').length;
      const chartCount = doc.getElementsByTagName('c:chart').length;
      return { index, coordinates, text, tableText, geometryRejectionChecks, imageCount, expectedImages: elements.filter((element) => element.type === 'image').length,
        chartCount, expectedCharts: elements.filter((element) => element.type === 'chart').length,
        expectedLines: elements.filter((element) => element.type === 'line').length, nativeObjects: boxes.length };
    });
    const charts = parsed.filter(({ name }) => /^ppt\/charts\/chart[^/]+\.xml$/u.test(name)).map(({ name, doc }) => ({ name, values: [...doc.getElementsByTagName('c:v')].map((item) => item.textContent) }));
    const values = charts.flatMap((chart) => chart.values);
    const dataPresence = expected.flatMap((elements) => elements.filter((element) => element.type === 'chart').map((element) => ({
      id: element.id, labelsPresent: element.data.labels.every((label) => values.includes(String(label))),
      valuesPresent: element.data.series.flatMap((series) => series).every((value) => values.includes(String(value))),
    })));
    return { malformed, pages: sourcePages, charts, dataPresence,
      structuralPassed: !malformed.length && sourcePages.every((item) => !item.missing && item.coordinates.every((coordinate) => coordinate.matched && coordinate.geometryCommandsPreserved !== false)
        && item.geometryRejectionChecks.every((check) => check.rejected)
        && item.text.every((text) => text.present) && item.tableText.every((cell) => cell.present && !cell.literalMarkup)
        && item.imageCount >= item.expectedImages && item.chartCount === item.expectedCharts) && dataPresence.every((item) => item.labelsPresent && item.valuesPresent) };
  }, { xmlFiles, expected: exported.expected });
  const final = { id, bytes: body.length, zipEntries: Object.keys(zip.files).length, ...report, errors: [...browserErrors], method: '实际 buildPptxBlob；ZIP CRC、XML、原生对象坐标、全部路径/全局控制点、箭头/虚线、文字、图片与图表值核对，包含真实XML负向变异检查',
    nativeEditingReview: 'pending', officeVisualReview: 'not-run', beautyReview: 'pending' };
  await writeFile(path.join(output, 'exports', `${id}.json`), JSON.stringify(final, null, 2));
  return final;
}

try {
  const original = JSON.parse(await readFile(path.join(output, 'source-snapshot', 'original-scene.json'), 'utf8'));
  if (original.content?.type === 'slide') {
    const originalReport = await page.evaluate(({ content, id }) => window.renderTeachingVisual(content, id), { content: original.content.canvas, id: original.id });
    await page.screenshot({ path: path.join(output, 'renders', 'original-slide-19.png') });
    await writeFile(path.join(output, 'renders', 'original-slide-19.json'), JSON.stringify({ ...originalReport, title: original.title, phase: 'original-source-snapshot' }, null, 2));
  }
  const files = (await readdir(path.join(output, 'results'))).filter((filename) => filename.endsWith('.json')).sort();
  const selectedResults = (await Promise.all(files.map(async (filename) => JSON.parse(await readFile(path.join(output, 'results', filename), 'utf8')))))
    .filter((result) => !selectedIds || selectedIds.includes(result.caseId) || selectedIds.includes(result.id));
  if (courseGallery) {
    for (const result of selectedResults) {
      if (result.source?.kind === 'course-snapshot' && (!Number.isInteger(originalPageNumber(result)) || originalPageNumber(result) < 1)) throw new Error(`${result.id} 缺少真实原课页号 source.pageNumber，不能按标题或文件名猜测课程顺序`);
    }
    selectedResults.sort((a, b) => (originalPageNumber(a) ?? Infinity) - (originalPageNumber(b) ?? Infinity) || a.id.localeCompare(b.id));
  }
  for (const result of selectedResults) {
    for (const [phase, content] of [['first', result.first], ['final', result.final]]) {
      if (!content?.elements?.length) continue;
      const pages = [content, ...(content.continuationPages ?? [])];
      for (let index = 0; index < pages.length; index++) {
        const id = `${result.id}-${phase}-p${index + 1}`;
        await page.setViewportSize({ width: 1000, height: 563 });
        browserErrors.length = 0;
        let report;
        try {
          report = await page.evaluate(({ content, id }) => window.renderTeachingVisual(content, id), { content: pages[index], id });
          await page.screenshot({ path: path.join(output, 'renders', `${id}.png`) });
          report = { ...report, id, caseId: result.caseId, phase, pageIndex: index, errors: [...browserErrors], status: browserErrors.length ? 'failed' : 'completed' };
        } catch (error) { report = { id, caseId: result.caseId, phase, pageIndex: index, status: 'failed', error: error.message, errors: [...browserErrors] }; }
        await writeFile(path.join(output, 'renders', `${id}.json`), JSON.stringify(report, null, 2));
        renderReports.push(report);
        if (phase === 'final' && result.repetition === 1 && (courseGallery || result.sample || result.caseId === 'original-page-19')) {
          const figure = { id, caseId: result.caseId, title: content.teachingVisual?.scene.pages.find((page) => page.id === pages[index].teachingVisual?.pageId)?.title ?? result.source.title,
            source: result.source.note, src: `renders/${id}.png`, originalPageNumber: originalPageNumber(result), continuationIndex: index, totalPages: pages.length };
          if (courseGallery) { selectedCourseFigures.push(figure); selectedCoursePages.push(pages[index]); }
          if (result.sample) {
            sampleFigures.push(figure);
            samplePages.push(pages[index]);
            if (result.source.kind === 'course-snapshot' && (!courseGallery || result.caseId === 'original-page-19')) courseFigures.push(figure);
          } else if (!courseGallery || result.caseId === 'original-page-19') actualCourseFigures.push(figure);
          for (const view of [{ name: '1366x768', width: 1366, height: 768, canvas: 900 }, { name: '1440x900', width: 1440, height: 900, canvas: 1000 }]) {
            await page.setViewportSize({ width: view.width, height: view.height });
            const notebook = await page.evaluate(({ content, id, displayedWidth }) => window.renderTeachingVisual(content, id, displayedWidth), { content: pages[index], id, displayedWidth: view.canvas });
            await page.screenshot({ path: path.join(output, 'renders', `${id}-${view.name}.png`) });
            await writeFile(path.join(output, 'renders', `${id}-${view.name}.json`), JSON.stringify({ ...notebook, id, phase, isolatedNotebookCanvas: true }, null, 2));
          }
        }
      }
      if (phase === 'final' && !args.has('skip-export')) {
        try { exportReports.push(await exportAndInspect(pages, result.id)); }
        catch (error) { exportReports.push({ id: result.id, structuralPassed: false, error: error.message, officeVisualReview: 'not-run' }); }
      }
    }
    console.log(JSON.stringify({ id: result.id, renderedPages: renderReports.filter((item) => item.caseId === result.caseId).length, exportPassed: exportReports.find((item) => item.id === result.id)?.structuralPassed }));
  }
  const galleryFigures = courseGallery ? selectedCourseFigures : sampleFigures;
  const galleryPages = courseGallery ? selectedCoursePages : samplePages;
  if (galleryPages.length && !args.has('skip-export')) {
    try { exportReports.push(await exportAndInspect(galleryPages, combinedDeckId)); }
    catch (error) { exportReports.push({ id: combinedDeckId, structuralPassed: false, error: error.message }); }
  }
  const galleryId = courseGallery ? combinedDeckId : 'specimens';
  const html = '<!doctype html><meta charset="utf-8"><title>' + escape(galleryTitle) + '</title><style>body{margin:0;background:#eaf0f5;font-family:"Noto Sans SC",sans-serif;color:#22364f}main{max-width:1250px;margin:36px auto;display:grid;grid-template-columns:1fr 1fr;gap:28px}h1,p{grid-column:1/-1;margin:0}figure{margin:0}img{width:100%;display:block;box-shadow:0 3px 18px #0f172a14}figcaption{font-size:18px;line-height:1.6;margin:12px 0 0}.source{font-size:12px;color:#64748b}</style><main><h1>' + escape(galleryTitle) + '</h1><p>实际播放器画布 · 原生文字、关系和图表可编辑 · 美观与教学质量仍待逐页评审</p>'
    + galleryFigures.map((figure) => `<figure><img src="${figure.src}"><figcaption>${courseGallery && figure.originalPageNumber ? `原第 ${figure.originalPageNumber} 页${figure.totalPages > 1 ? ` · 续画面 ${figure.continuationIndex + 1}/${figure.totalPages}` : ''}：` : ''}${escape(figure.title)}</figcaption><div class="source">${escape(figure.source)}</div></figure>`).join('') + '</main>';
  await writeFile(path.join(output, `${galleryId}.html`), html);
  if (galleryFigures.length) {
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.setContent(html.replaceAll('src="renders/', `src="${origin}/renders/`));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode())); });
    await page.screenshot({ path: path.join(output, `${courseGallery ? `${combinedDeckId}-preview` : 'specimens'}.png`), fullPage: true });
  }
  for (const comparisonSet of [
    { figures: courseFigures, id: 'slide-19-comparison', label: '教学图解设计样板', note: '真实来源隔离副本 · 共同承担原页97秒 · 原课堂和音频未改写' },
    { figures: actualCourseFigures, id: 'slide-19-model-comparison', label: '完整原页面真实模型重设计', note: '完整原大纲、教材证据与原流程拓扑 · 模型自行规划1至3页 · 原课堂和音频未改写' },
  ]) {
    if (!comparisonSet.figures.length) continue;
    comparisonSet.figures.sort((a, b) => a.caseId.startsWith('state-') ? -1 : b.caseId.startsWith('state-') ? 1 : a.id.localeCompare(b.id));
    const comparison = '<!doctype html><meta charset="utf-8"><title>第19页重设计对照</title><style>body{margin:0;background:#eaf0f5;font-family:"Noto Sans SC",sans-serif;color:#22364f}main{max-width:1240px;margin:30px auto}h1,h2{margin:0 0 16px}section{display:flex;justify-content:center;margin:0 0 30px;gap:24px}figure{margin:0;flex:1;max-width:1000px}img{width:100%;display:block;background:white;box-shadow:0 3px 18px #0f172a14}figcaption{font-size:18px;margin:10px 0}p{color:#64748b;font-size:15px}</style><main><h1>第19页：支架撤除与教学过程</h1><p>真实来源隔离副本 · 两个教学画面共同承担原页97秒 · 原课堂和音频未改写</p><h2>原保存页面</h2><section><figure><img src="renders/original-slide-19.png"></figure></section><h2>教学图解设计样板</h2><section>'
      .replace('真实来源隔离副本 · 两个教学画面共同承担原页97秒 · 原课堂和音频未改写', escape(comparisonSet.note)).replace('教学图解设计样板</h2>', `${escape(comparisonSet.label)}</h2>`)
      + comparisonSet.figures.map((figure) => `<figure><img src="${figure.src}"><figcaption>${escape(figure.title)}</figcaption></figure>`).join('') + '</section></main>';
    await writeFile(path.join(output, `${comparisonSet.id}.html`), comparison);
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.setContent(comparison.replaceAll('src="renders/', `src="${origin}/renders/`));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode())); });
    await page.screenshot({ path: path.join(output, `${comparisonSet.id}.png`), fullPage: true });
  }
  await writeFile(path.join(output, 'acceptance-report.json'), JSON.stringify({
    method: 'ReadonlySlideCanvas with snapshotted production CSS/fonts; browser-native PPTX exporter', cssSha256: cssFingerprint, productionStatic,
    exportImplementationSha256, exportImplementationUnchanged: exportImplementationSha256 === await exportFingerprint(),
    generatedAttemptFiles: files.length, renderedPages: renderReports.length,
    renderFailures: renderReports.filter((item) => item.status === 'failed').length,
    renderIssues: renderReports.reduce((sum, item) => sum + (item.issues?.length ?? 0), 0),
    requiredFontIssues: renderReports.reduce((sum, item) => sum + (item.essentialFontIssues?.length ?? 0), 0),
    exports: exportReports.length, exportFailures: exportReports.filter((item) => !item.structuralPassed || item.errors?.length).length,
    sampleFigures: sampleFigures.length, completeOriginal19ModelPages: actualCourseFigures.length,
    combinedDeck: combinedDeckId, galleryTitle, galleryPages: galleryFigures.map((figure) => ({ id: figure.id, originalPageNumber: figure.originalPageNumber, continuationIndex: figure.continuationIndex })),
    fullStudentScreenReview: 'not-run', officeVisualReview: 'not-run', contentReview: 'pending', beautyReview: 'pending',
    reports: renderReports.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'measurements'))), exportReports,
  }, null, 2));
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

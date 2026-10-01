/** Actual ReadonlySlideCanvas screenshots; no model calls or application writes. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (process.argv.includes('--help')) {
  console.log('单页真实渲染对比：--before <scene.json> [--after <scene.json>] --output <目录> [--snapshot-dir <目录>] [--storage-state <已授权.json>] [--base-url http://127.0.0.1:3000]');
  process.exit(0);
}
if (!arg('--before') || !arg('--output')) throw new Error('需要 --before 和 --output');
const output = path.resolve(arg('--output'));
if (!output.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('截图输出必须位于 .openpbl-runtime 隔离目录');
const runtime = path.join(output, 'browser');
const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('仅允许读取明确的本机服务资源');
const before = JSON.parse(await readFile(arg('--before'), 'utf8'));
const after = arg('--after') ? JSON.parse(await readFile(arg('--after'), 'utf8')) : undefined;
if (before.content?.type !== 'slide' || (after && after.content?.type !== 'slide')) throw new Error('仅支持原生幻灯片场景');
const canvas = before.content.canvas;
const width = canvas.viewportSize, height = width * canvas.viewportRatio;
if (after && (after.content.canvas.viewportSize !== width || after.content.canvas.viewportRatio !== canvas.viewportRatio)) throw new Error('对比画布大小必须一致');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
await mkdir(runtime, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['scripts/benchmark-first-pass-slide-render.tsx'], outfile: path.join(runtime, 'render.js'),
  bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  plugins: [{ name: 'readonly-visual-acceptance', setup(builder) {
    builder.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'audit-settings', namespace: 'audit-settings' }));
    builder.onLoad({ filter: /.*/, namespace: 'audit-settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"}; export const useSettingsStore=Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' }));
    builder.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-generation', namespace: 'audit-generation' }));
    builder.onLoad({ filter: /.*/, namespace: 'audit-generation' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Generation disabled in screenshot harness")} export async function generateMediaForOutlines(){throw new Error("Generation disabled in screenshot harness")}' }));
  } }],
});
const staticRoot = path.join(root, process.env.NEXT_DIST_DIR || '.next-build', 'static');
const cssFiles = (await readdir(path.join(staticRoot, 'css'), { recursive: true })).filter((item) => item.endsWith('.css'));
if (!cssFiles.length) throw new Error('缺少生产页面 CSS，不能以替代样式声明真实渲染');
const snapshotDirectory = arg('--snapshot-dir') ? path.resolve(arg('--snapshot-dir')) : undefined;
const snapshot = snapshotDirectory ? JSON.parse(await readFile(path.join(snapshotDirectory, 'snapshot.json'), 'utf8')) : undefined;
const savedMedia = new Map((snapshot?.media ?? []).filter((item) => item.file).map((item) => [new URL(item.url, baseUrl).pathname, path.join(snapshotDirectory, item.file)]));
const mime = (file) => /\.css$/iu.test(file) ? 'text/css' : /\.woff2$/iu.test(file) ? 'font/woff2'
  : /\.svg$/iu.test(file) ? 'image/svg+xml' : /\.webp$/iu.test(file) ? 'image/webp' : /\.jpe?g$/iu.test(file) ? 'image/jpeg'
    : /\.png$/iu.test(file) ? 'image/png' : /\.js$/iu.test(file) ? 'text/javascript' : 'application/octet-stream';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8">' + cssFiles.map((css) => '<link rel="stylesheet" href="/_next/static/css/' + css + '">').join('')
        + `<style>html,body{margin:0;width:${width}px;height:${Math.ceil(height)}px;overflow:hidden}#root{width:${width}px;height:${Math.ceil(height)}px}</style></head><body><div id="root"></div><script src="/render.js"></script></body></html>`);
    } else {
      const filename = url.pathname === '/render.js' ? path.join(runtime, 'render.js')
        : url.pathname.startsWith('/_next/static/') ? path.resolve(staticRoot, '.' + url.pathname.slice('/_next/static'.length))
          : url.pathname === '/before.png' || url.pathname === '/after.png' ? path.join(output, path.basename(url.pathname)) : undefined;
      if (!filename || (url.pathname.startsWith('/_next/static/') && !filename.startsWith(staticRoot + path.sep))) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', mime(filename)); response.end(await readFile(filename));
    }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const localOrigin = 'http://127.0.0.1:' + server.address().port;
let browser;
let lastBrowserError;
for (const executablePath of [...new Set([process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH, undefined, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])]) {
  if (executablePath && !await access(executablePath).then(() => true, () => false)) continue;
  try { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); break; }
  catch (error) { lastBrowserError = error; }
}
if (!browser) { await new Promise((resolve) => server.close(resolve)); throw lastBrowserError ?? new Error('没有可用 Chromium'); }
const context = await browser.newContext({ viewport: { width, height: Math.ceil(height) }, deviceScaleFactor: 2,
  ...(arg('--storage-state') ? { storageState: arg('--storage-state') } : {}) });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== 'GET') { await route.abort(); return; }
  if (url.protocol === 'data:' || url.protocol === 'blob:') { await route.continue(); return; }
  if (url.origin === localOrigin && !url.pathname.startsWith('/api/')) { await route.continue(); return; }
  if (!/^\/api\/(?:openmaic\/|uploads\/|textbooks\/)/u.test(url.pathname)) { await route.abort(); return; }
  const saved = savedMedia.get(url.pathname);
  if (saved) { await route.fulfill({ status: 200, contentType: mime(saved), body: await readFile(saved) }); return; }
  const result = await context.request.get(baseUrl + url.pathname + url.search);
  await route.fulfill({ response: result });
});
const reports = [];
try {
  await page.goto(localOrigin);
  await page.waitForFunction(() => typeof window.benchmarkRender === 'function');
  for (const [label, scene] of [['before', before], ['after', after]]) {
    if (!scene) continue;
    pageErrors.length = 0;
    const report = await page.evaluate(async ({ content, id }) => window.benchmarkRender(content, id), { content: scene.content.canvas, id: scene.id });
    await page.screenshot({ path: path.join(output, label + '.png') });
    reports.push({ label, sceneId: scene.id, title: scene.title, ...report, errors: [...pageErrors] });
  }
  await writeFile(path.join(output, 'render-report.json'), JSON.stringify({ renderer: 'actual ReadonlySlideCanvas with production CSS/font assets',
    width, height, deviceScaleFactor: 2, reports }, null, 2));
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const comparison = '<!doctype html><html><head><meta charset="utf-8"><style>'
    + `*{box-sizing:border-box}html,body{margin:0;background:#eef2f6;color:#23364d;font-family:"Noto Sans SC",sans-serif}main{display:flex;gap:24px;padding:24px}section{width:${width}px}h2{font-size:24px;line-height:36px;margin:0 0 12px;font-weight:700}img{display:block;width:${width}px;height:${Math.ceil(height)}px;background:white;box-shadow:0 2px 12px #23364d14}.subtitle{font-size:16px;margin:0 0 20px;color:#617086}</style></head><body><main>`
    + reports.map((report) => `<section><h2>${report.label === 'before' ? '原页面' : '优化后'}</h2><div class="subtitle">第 ${snapshot?.slide ?? ''} 页 · ${escape(report.title)}</div><img src="${report.label}.png"></section>`).join('') + '</main></body></html>';
  await writeFile(path.join(output, 'comparison.html'), comparison);
  if (after) {
    await page.setViewportSize({ width: width * 2 + 72, height: Math.ceil(height) + 132 });
    await page.setContent(comparison.replaceAll('src="before.png"', `src="${localOrigin}/before.png"`).replaceAll('src="after.png"', `src="${localOrigin}/after.png"`));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode())); });
    await page.screenshot({ path: path.join(output, 'comparison.png'), fullPage: true });
  }
  console.log(JSON.stringify({ output, screenshots: reports.map((report) => report.label + '.png'), issues: reports.map((report) => ({ label: report.label, count: report.issues.length })) }));
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

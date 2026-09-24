/** Offline visual acceptance using actual playback components. No model calls or application writes.
 * node scripts/render-classroom-artifacts.mjs --classroom <classroom.json> [--storage-state <authorized.json>] [--output <directory>]
 * Optional --match <title-regexp> restricts screenshots; measurements always cover all slides.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (process.argv.includes('--help')) {
  console.log('Read-only rendered classroom acceptance: --classroom <json> [--storage-state <authorized.json>] [--output <dir>] [--match <title-regexp>] [--base-url <local-service>]');
  process.exit(0);
}
const file = arg('--classroom');
if (!file) throw new Error('Pass --classroom <classroom.json>');
const root = process.cwd();
const output = path.resolve(arg('--output') ?? path.join(path.dirname(file), 'visual-acceptance'));
const runtime = path.join(output, 'browser');
const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('Use an explicitly local deployment for authorized media reads');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const artifact = JSON.parse(await readFile(file, 'utf8'));
const classroom = artifact.classroom ?? artifact;
if (!Array.isArray(classroom.scenes)) throw new Error('Artifact does not contain classroom scenes');
const slides = classroom.scenes.filter((scene) => scene.content?.type === 'slide');
const match = arg('--match') ? new RegExp(arg('--match')) : null;
await mkdir(runtime, { recursive: true });
await mkdir(path.join(output, 'screenshots'), { recursive: true });
await build({
  entryPoints: ['scripts/benchmark-first-pass-slide-render.tsx'], outfile: path.join(runtime, 'render.js'),
  bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  plugins: [{ name: 'disable-audit-generation', setup(builder) {
    builder.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'audit-settings', namespace: 'audit-settings' }));
    builder.onLoad({ filter: /.*/, namespace: 'audit-settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"}; export const useSettingsStore=Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' }));
    builder.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-generation', namespace: 'audit-generation' }));
    builder.onLoad({ filter: /.*/, namespace: 'audit-generation' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Generation disabled during visual acceptance")} export async function generateMediaForOutlines(){throw new Error("Generation disabled during visual acceptance")}' }));
  } }],
});
const staticRoot = path.join(root, process.env.NEXT_DIST_DIR || '.next-build', 'static');
const cssFiles = (await readdir(path.join(staticRoot, 'css'), { recursive: true })).filter((item) => item.endsWith('.css'));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta charset="utf-8">' + cssFiles.map((css) => '<link rel="stylesheet" href="/_next/static/css/' + css + '">').join('')
        + '<style>html,body{margin:0;width:1000px;height:563px;overflow:hidden}#root{width:1000px;height:563px}</style></head><body><div id="root"></div><script src="/render.js"></script></body></html>');
    } else if (url.pathname === '/render.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(path.join(runtime, 'render.js')));
    } else if (url.pathname.startsWith('/_next/static/')) {
      const asset = path.resolve(staticRoot, '.' + url.pathname.slice('/_next/static'.length));
      if (!asset.startsWith(staticRoot + path.sep)) throw new Error('Invalid static path');
      response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      response.end(await readFile(asset));
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 1,
  ...(arg('--storage-state') ? { storageState: arg('--storage-state') } : {}) });
const page = await context.newPage();
const reports = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await context.route('**/api/**', async (route) => {
  const request = route.request();
  if (request.method() !== 'GET' || !/^\/api\/(?:openmaic\/|uploads\/)/.test(new URL(request.url()).pathname)) {
    await route.abort(); return;
  }
  const url = new URL(request.url());
  const response = await context.request.get(baseUrl + url.pathname + url.search);
  await route.fulfill({ response });
});
try {
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.benchmarkRender === 'function');
  for (const [index, scene] of slides.entries()) {
    pageErrors.length = 0;
    const canvas = scene.content.canvas;
    const content = { ...canvas, theme: canvas.theme ?? { fontName: 'Noto Sans SC', fontColor: '#333333', backgroundColor: '#ffffff', themeColors: ['#1E3A8A'] } };
    const report = await page.evaluate(async ({ content, id }) => {
      const rendered = await window.benchmarkRender(content, id);
      const orphanLines = [];
      for (const wrapper of document.querySelectorAll('[data-review-element]')) {
        const textRoot = wrapper.querySelector('.ProseMirror-static');
        if (!textRoot || [...(textRoot.textContent ?? '').trim()].length < 2) continue;
        const lines = new Map();
        const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          let index = 0;
          for (const char of node.textContent ?? '') {
            const range = document.createRange();
            range.setStart(node, index);
            index += char.length;
            range.setEnd(node, index);
            const rect = range.getClientRects()[0];
            if (!rect || !rect.width || !rect.height) continue;
            const y = Math.round(rect.top * 2) / 2;
            lines.set(y, (lines.get(y) ?? '') + char);
          }
        }
        const visible = [...lines.entries()].sort(([a], [b]) => a - b).map(([, text]) => text.trim()).filter(Boolean);
        if (visible.length > 1 && visible.some((line) => /^[\u3400-\u9fff]$/.test(line.replace(/[\s\p{P}\p{S}]/gu, '')))) {
          orphanLines.push({ elementId: wrapper.getAttribute('data-review-element'), lines: visible, text: textRoot.textContent });
        }
      }
      return { ...rendered, orphanLines };
    }, { content, id: scene.id });
    const name = String(index + 1).padStart(3, '0') + '-' + scene.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100);
    const screenshot = !match || match.test(scene.title) ? 'screenshots/' + name + '.png' : undefined;
    if (screenshot) await page.screenshot({ path: path.join(output, screenshot) });
    reports.push({ index: index + 1, sceneId: scene.id, title: scene.title, ...report, screenshot, errors: [...pageErrors] });
    console.log(JSON.stringify({ page: index + 1, title: scene.title, issues: report.issues.length, orphanElements: report.orphanLines.length, screenshot }));
  }
  const summary = { source: path.resolve(file), createdAt: new Date().toISOString(), renderer: 'actual ReadonlySlideCanvas with deployed CSS and font assets', slides: reports.length,
    orphanElements: reports.reduce((sum, report) => sum + report.orphanLines.length, 0),
    missingImages: reports.flatMap((report) => report.issues.filter((issue) => issue.id.includes('image-missing'))).length,
    issues: reports.reduce((sum, report) => sum + report.issues.length, 0), reports };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(summary, null, 2));
  const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  await writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>课堂页面实际渲染验收</title><style>body{font:16px sans-serif;margin:24px;background:#eee}.page{margin-bottom:32px}img{max-width:100%;width:1000px;border:1px solid #bbb}pre{white-space:pre-wrap}</style>'
    + reports.map((report) => '<section class="page"><h2>' + report.index + '. ' + escape(report.title) + '</h2>'
      + (report.screenshot ? '<a href="' + report.screenshot + '"><img src="' + report.screenshot + '"></a>' : '')
      + '<pre>' + escape(JSON.stringify({ orphanLines: report.orphanLines, issues: report.issues.map((issue) => ({ title: issue.title, evidence: issue.evidence })), errors: report.errors }, null, 2)) + '</pre></section>').join(''));
  console.log(JSON.stringify({ output, slides: summary.slides, orphanElements: summary.orphanElements, missingImages: summary.missingImages, issues: summary.issues }));
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }


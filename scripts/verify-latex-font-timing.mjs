/** Reproduce delayed KaTeX font loading using an unchanged frozen slide. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const root = process.cwd();
const output = path.resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? '.openpbl-runtime/latex-font-verification');
const reuseFrozenRuntime = process.argv.includes('--reuse-frozen-runtime');
const runtime = path.join(output, 'browser');
await mkdir(runtime, { recursive: true });
if (!reuseFrozenRuntime) await build({ entryPoints: ['scripts/benchmark-first-pass-slide-render.tsx'], outfile: path.join(runtime, 'render.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'disable-benchmark-media-generation', setup(build) { build.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'benchmark-settings', namespace: 'settings' })); build.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"}; export const useSettingsStore = Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' })); build.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-media-generation', namespace: 'benchmark' })); build.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Media generation is disabled in offline rendering")} export async function generateMediaForOutlines(){throw new Error("Media generation is disabled in offline rendering")}' })); } }]  });
const frozen = path.join(root, '.openpbl-runtime/first-pass-benchmark-final');
const staticRoot = path.join(frozen, 'browser/deployed-static');
const cssFiles = (await readdir(path.join(staticRoot, 'css'))).filter((file) => file.endsWith('.css'));
const result = JSON.parse(await readFile(path.join(frozen, 'results/01-budget-2.json'), 'utf8'));
const content = result.final;
if (!content?.elements?.length) throw new Error('Missing frozen formula fixture');
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head>${cssFiles.map((file) => `<link rel="stylesheet" href="/_next/static/css/${file}">`).join('')}<style>html,body{margin:0;width:1000px;height:563px;overflow:hidden}#root{width:1000px;height:563px}</style></head><body><div id="root"></div><script src="/${url.searchParams.get('version')}.js"></script></body></html>`);
    } else if (url.pathname === '/old.js' || url.pathname === '/new.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(path.join(url.pathname === '/old.js' ? path.join(frozen, 'browser') : runtime, 'render.js')));
    } else if (url.pathname.startsWith('/_next/static/') && !url.pathname.includes('..')) {
      const file = path.join(staticRoot, url.pathname.slice('/_next/static/'.length));
      if (/KaTeX.*\.(woff2?|ttf)$/.test(file)) await new Promise((resolve) => setTimeout(resolve, 1200));
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      response.end(await readFile(file));
    } else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const version of ['old', 'new']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?version=${version}`);
    await page.waitForFunction(() => typeof window.benchmarkRender === 'function');
    await page.evaluate(async (content) => window.benchmarkRender(content, 'unchanged-formula-fixture'), content);
    const formulas = await page.evaluate(() => [...document.querySelectorAll('.base-element-latex')].map((element) => {
      const frame = element.getBoundingClientRect();
      const inner = element.querySelector('[style*="scale("]');
      const ink = inner.getBoundingClientRect();
      return { frame: frame.toJSON(), ink: ink.toJSON(), transform: inner.style.transform,
        clipped: ink.left < frame.left - 1 || ink.right > frame.right + 1 || ink.top < frame.top - 1 || ink.bottom > frame.bottom + 1 };
    }));
    await page.screenshot({ path: path.join(output, `${version}.png`) });
    reports.push({ version, errors, formulas });
    await page.close();
  }
  const sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const report = { fixture: 'first-pass-benchmark-final/results/01-budget-2.json',
    fixtureSha256: sha256(await readFile(path.join(frozen, 'results/01-budget-2.json'))),
    oldBundleSha256: sha256(await readFile(path.join(frozen, 'browser/render.js'))),
    newBundleSha256: sha256(await readFile(path.join(runtime, 'render.js'))),
    unchangedDsl: true, fontDelayMs: 1200, reports };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!reports[0].formulas.some((formula) => formula.clipped) || reports[1].errors.length || !reports[1].formulas.length || reports[1].formulas.some((formula) => formula.clipped)) process.exitCode = 1;
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

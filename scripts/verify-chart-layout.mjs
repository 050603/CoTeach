/** Compare compact native charts against frozen renderer output without changing DSL. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const root = process.cwd();
const output = path.resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? '.openpbl-runtime/chart-layout-verification');
const reuseFrozenRuntime = process.argv.includes('--reuse-frozen-runtime');
const runtime = path.join(output, 'browser');
await mkdir(runtime, { recursive: true });
if (!reuseFrozenRuntime) await build({ entryPoints: ['scripts/benchmark-first-pass-slide-render.tsx'], outfile: path.join(runtime, 'render.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'disable-benchmark-media-generation', setup(build) { build.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'benchmark-settings', namespace: 'settings' })); build.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"}; export const useSettingsStore = Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' })); build.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-media-generation', namespace: 'benchmark' })); build.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Media generation is disabled in offline rendering")} export async function generateMediaForOutlines(){throw new Error("Media generation is disabled in offline rendering")}' })); } }]  });
const frozen = path.join(root, '.openpbl-runtime/first-pass-benchmark-final');
const staticRoot = path.join(frozen, 'browser/deployed-static');
const cssFiles = (await readdir(path.join(staticRoot, 'css'))).filter((file) => file.endsWith('.css'));
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
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      response.end(await readFile(file));
    } else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const fixture of ['16-budget-1', '16-budget-2']) {
    const source = await readFile(path.join(frozen, 'results', `${fixture}.json`));
    const content = JSON.parse(source).final;
    for (const version of ['old', 'new']) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 1 });
      const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?version=${version}`);
      await page.waitForFunction(() => typeof window.benchmarkRender === 'function');
      await page.evaluate(async (content) => window.benchmarkRender(content, 'unchanged-chart-fixture'), content);
      // ECharts animates data on mount; inspect the settled chart consistently.
      await page.waitForTimeout(1500);
      const charts = await page.evaluate(() => [...document.querySelectorAll('.base-element-chart')].map((element) => {
        const frame = element.getBoundingClientRect();
        const labels = [...element.querySelectorAll('svg text')].map((text) => ({ text: text.textContent, bounds: text.getBoundingClientRect().toJSON() }));
        const bars = [...element.querySelectorAll('svg path')].filter((path) => /^(rgb|#)/.test(path.getAttribute('fill') || ''))
          .map((path) => ({ fill: path.getAttribute('fill'), height: path.getBBox().height }));
        return { frame: frame.toJSON(), labels, bars };
      }));
      await page.screenshot({ path: path.join(output, `${fixture}-${version}.png`) });
      reports.push({ fixture, fixtureSha256: createHash('sha256').update(source).digest('hex'), version, errors, charts });
      await page.close();
    }
  }
  const report = { unchangedDsl: true,
    oldBundleSha256: createHash('sha256').update(await readFile(path.join(frozen, 'browser/render.js'))).digest('hex'),
    newBundleSha256: createHash('sha256').update(await readFile(path.join(runtime, 'render.js'))).digest('hex'), reports };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const row of reports.filter((row) => row.version === 'new')) {
    if (row.errors.length || !row.charts.length) process.exitCode = 1;
    for (const chart of row.charts) {
      if (['周一', '周二', '周三'].some((text) => !chart.labels.some((label) => label.text === text))) process.exitCode = 1;
      if (Math.max(...chart.bars.map((bar) => bar.height)) < chart.frame.height * 0.45) process.exitCode = 1;
    }
  }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

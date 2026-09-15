/** Render generated benchmark artifacts with the actual playback components. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { chromium } = require('playwright');
const root = process.cwd();
const output = path.resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? '.openpbl-runtime/first-pass-benchmark');
const watch = process.argv.includes('--watch');
const reuseFrozenRuntime = process.argv.includes('--reuse-frozen-runtime');
const runtime = path.join(output, 'browser');
await mkdir(runtime, { recursive: true });
if (!reuseFrozenRuntime) await build({ entryPoints: ['scripts/benchmark-first-pass-slide-render.tsx'], outfile: path.join(runtime, 'render.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'disable-benchmark-media-generation', setup(build) { build.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({ path: 'benchmark-settings', namespace: 'settings' })); build.onLoad({ filter: /.*/, namespace: 'settings' }, () => ({ contents: 'const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"}; export const useSettingsStore = Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});' })); build.onResolve({ filter: /media-orchestrator$/ }, () => ({ path: 'disabled-media-generation', namespace: 'benchmark' })); build.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: 'export async function retryMediaTask(){throw new Error("Media generation is disabled in offline rendering")} export async function generateMediaForOutlines(){throw new Error("Media generation is disabled in offline rendering")}' })); } }]  });
// Compile the exact baseline source's deterministic first-draft preparation.
// This runs no model calls and retains the raw response separately.
async function firstDraftNormalizer(group) {
  if (reuseFrozenRuntime) return (await import(pathToFileURL(path.join(runtime, `${group}-first-normalizer.mjs`)).href)).normalizeBenchmarkFirstDraft;
  const custom = group === 'custom';
  const original = custom ? path.join(output, 'legacy-source/src/lib/openmaic/generation/scene-generator.ts') : path.join(root, 'src/lib/openmaic/generation/scene-generator.ts');
  let source = await readFile(original, 'utf8');
  source = source.replace(/(['"])\.\/([^'"\n]+)\1/g, (_match, quote, suffix) => `${quote}${path.join(path.dirname(original), suffix)}${quote}`);
  source += `
export function normalizeBenchmarkFirstDraft(raw) {
  const data = parseJsonResponse(raw);
  if (!data || !Array.isArray(data.elements)) return null;
  const repaired = fixElementDefaults(data.elements);
  const prepared = processLatexElements(repaired.elements).map((element, index) => ({...element, id: element.id || 'element-' + index, rotate:0}));
  return {...data, elements: prepared, theme:resolveCourseVisualStyle('').theme};
}
`;
  const entry = path.join(runtime, `${group}-first-normalizer.ts`);
  const compiled = path.join(runtime, `${group}-first-normalizer.mjs`);
  await writeFile(entry, source);
  await build({ entryPoints: [entry], outfile: compiled, bundle: true, packages: 'external', platform: 'node', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'), banner: { js: "import {createRequire as __normalizerRequire} from 'node:module'; const require=__normalizerRequire(import.meta.url);" } });
  return (await import(pathToFileURL(compiled).href)).normalizeBenchmarkFirstDraft;
}
const normalizeFirst = {
  official: await firstDraftNormalizer('official'),
  custom: await firstDraftNormalizer('custom'),
  adapted: await firstDraftNormalizer('adapted'),
};
const dist = process.env.NEXT_DIST_DIR || '.next-build';
const staticRoot = path.join(runtime, 'deployed-static');
try { await readFile(path.join(staticRoot, 'snapshot.json')); } catch {
  if (reuseFrozenRuntime) throw new Error('Frozen deployed CSS snapshot is missing');
  await mkdir(staticRoot, { recursive: true });
  await cp(path.join(root, dist, 'static/css'), path.join(staticRoot, 'css'), { recursive: true });
  await cp(path.join(root, dist, 'static/media'), path.join(staticRoot, 'media'), { recursive: true });
  await writeFile(path.join(staticRoot, 'snapshot.json'), JSON.stringify({ at: new Date().toISOString(), sourceDist: dist }));
}
const cssFiles = (await readdir(path.join(staticRoot, 'css'), { recursive: true })).filter((file) => file.endsWith('.css'));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head>${cssFiles.map((file) => `<link rel="stylesheet" href="/_next/static/css/${file}">`).join('')}<style>html,body{margin:0;width:1000px;height:563px;overflow:hidden}#root{width:1000px;height:563px}</style></head><body><div id="root"></div><script src="/render.js"></script></body></html>`);
    } else if (url.pathname === '/render.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(path.join(runtime, 'render.js'))); }
    else if (url.pathname.startsWith('/_next/static/') && !url.pathname.includes('..')) {
      const file = path.join(staticRoot, url.pathname.slice('/_next/static/'.length));
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
      response.end(await readFile(file));
    } else { response.statusCode = 404; response.end(); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await browser.close(); server.close(); process.exit(0); });
const page = await browser.newPage({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://127.0.0.1:${server.address().port}`);
await page.waitForFunction(() => typeof window.benchmarkRender === 'function');
await mkdir(path.join(output, 'renders'), { recursive: true });
let idle = 0;
try {
  do {
    const files = await readdir(path.join(output, 'results')).catch(() => []);
    let rendered = 0;
    for (const file of files.filter((file) => file.endsWith('.json'))) {
      const result = JSON.parse(await readFile(path.join(output, 'results', file), 'utf8'));
      const firstFile = path.join(output, 'renders', `${result.id}-first-prepared.json`);
      const finalFile = path.join(output, 'renders', `${result.id}.json`);
      const doneFirst = await readFile(firstFile).then(() => true, () => false);
      const doneFinal = !result.final?.elements?.length || await readFile(finalFile).then(() => true, () => false);
      if (doneFirst && doneFinal) continue;
      const raw = result.calls?.[0]?.response;
      let first;
      if (raw) {
        try { first = normalizeFirst[result.group](raw); } catch { /* Parse/normalization failure is retained in source artifact. */ }
      }
      for (const [phase, candidate] of [['first', first], ['final', result.final]]) {
        if (!candidate?.elements?.length) continue;
        const id = phase === 'first' ? `${result.id}-first-prepared` : result.id;
        const reportPath = path.join(output, 'renders', `${id}.json`);
        try { await readFile(reportPath); continue; } catch { /* Render once. */ }
        const content = { ...candidate, theme: candidate.theme ?? result.final?.theme ?? { fontName: result.group === 'custom' ? 'Microsoft YaHei' : 'Noto Sans SC', fontColor: '#333333', themeColors: ['#5B9BD5'], backgroundColor: '#FFFFFF' } };
        errors.length = 0;
        let report;
        try {
          report = await page.evaluate(async ({ content, id }) => window.benchmarkRender(content, id), { content, id });
          await page.screenshot({ path: path.join(output, 'renders', `${id}.png`) });
          report.errors = [...errors]; report.status = errors.length ? 'failed' : 'completed';
        } catch (error) { report = { status: 'failed', error: error.message, errors: [...errors] }; }
        report.phase = phase;
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ rendered: id, status: report.status, issues: report.issues?.length, errors: report.errors }));
        rendered++;
      }
    }
    idle = rendered ? 0 : idle + 1;
    if (watch && idle < 180) await new Promise((resolve) => setTimeout(resolve, 10000));
  } while (watch && idle < 180);
} finally { await browser.close(); server.close(); }

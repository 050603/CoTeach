// Sequential browser acceptance; keeps business writes inside verify-prelaunch-functional.mjs.
// Run: node scripts/run-prelaunch-audit.mjs [--with-providers] [--browser-only] [--with-zoom]
// --with-zoom covers equivalent CSS viewports. Run native-browser-zoom.spec.ts
// separately for actual Chromium page zoom; DPR-only runs below test HiDPI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.PRELAUNCH_OUTPUT_DIR || path.join(root, 'test-results/prelaunch'));
mkdirSync(output, { recursive: true });
const baseURL = process.env.PRELAUNCH_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Browser audit requires a local instance');
const browsers = (process.env.PRELAUNCH_BROWSERS || 'chromium,firefox,webkit').split(',').map(value => value.trim()).filter(Boolean);
if (browsers.some(value => !['chromium', 'firefox', 'webkit'].includes(value))) throw new Error('Unknown browser');
const desktopProfiles = 'desktop-768x576,desktop-768x768,desktop-1024x576,desktop-1024x768,desktop-1280x720,desktop-1366x768,desktop-1440x900,desktop-1920x1080,desktop-2560x1440,desktop-3840x2160';
const teachingProfiles = 'desktop-split,desktop-laptop,desktop-1280x720,desktop-1366x768,desktop,desktop-1920x1080,desktop-4k';
const zoomFactors = (process.env.PRELAUNCH_ZOOM_FACTORS || '1.25,1.5').split(',').map(Number);
if (zoomFactors.some(value => !Number.isFinite(value) || value < 1 || value > 2)) throw new Error('Zoom factors must be between 1 and 2');
const results = [];

function execute(name, script, extra = {}, timeout = 3_600_000) {
  const childEnv = { ...process.env, LAYOUT_BASE_URL: baseURL, ...extra };
  const useContainer = name.includes('webkit') && process.env.PRELAUNCH_WEBKIT_CONTAINER === '1';
  const command = useContainer ? 'docker' : process.execPath;
  const args = useContainer
    ? ['run', '--rm', '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`,
      '--volume', `${root}:${root}`, '--workdir', root,
      '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      ...Object.entries(childEnv).filter(([key]) => /^(LAYOUT|TEACHING)_/.test(key)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      'mcr.microsoft.com/playwright:v1.61.1-noble', 'node', script, '--assert']
    : [script, '--assert'];
  const result = spawnSync(command, args, {
    cwd: root, env: childEnv,
    stdio: 'inherit', timeout,
  });
  const summaryPath = extra.LAYOUT_OUTPUT_DIR || extra.TEACHING_OUTPUT_DIR || extra.PRELAUNCH_OUTPUT_DIR;
  let summary = null;
  try { summary = summaryPath ? JSON.parse(readFileSync(path.join(summaryPath, extra.PRELAUNCH_OUTPUT_DIR ? 'report.json' : 'summary.json'), 'utf8')) : null; } catch { /* startup failed */ }
  const entry = { name, status: result.status === 0 ? '通过' : '失败', exitCode: result.status, summary };
  results.push(entry);
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ baseURL, results }, null, 2));
  return entry;
}

for (const browser of browsers) {
  execute(`platform-${browser}-dpr1`, 'scripts/check-desktop-layout.mjs', {
    LAYOUT_BROWSER: browser,
    LAYOUT_ZOOM: '1',
    LAYOUT_DPR: '1',
    LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, 'dpr1'),
    LAYOUT_DEVICES: process.env.PRELAUNCH_LAYOUT_DEVICES || desktopProfiles,
    ...(process.env.PRELAUNCH_LAYOUT_SCENARIOS ? { LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS } : {}),
  });
  execute(`teaching-${browser}-dpr1`, 'scripts/check-teaching-layout.mjs', {
    TEACHING_BROWSER: browser,
    TEACHING_ZOOM: '1',
    TEACHING_DPR: '1',
    TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, 'dpr1'),
    TEACHING_DEVICES: process.env.PRELAUNCH_TEACHING_DEVICES || teachingProfiles,
    ...(process.env.PRELAUNCH_TEACHING_SCENARIOS ? { TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS } : {}),
  });
  execute(`platform-${browser}-dpr2`, 'scripts/check-desktop-layout.mjs', {
    LAYOUT_BROWSER: browser,
    LAYOUT_ZOOM: '1',
    LAYOUT_DPR: '2',
    LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, 'dpr2'),
    LAYOUT_DEVICES: process.env.PRELAUNCH_LAYOUT_DEVICES || 'desktop-768x576,desktop-1440x900,desktop-3840x2160',
    ...(process.env.PRELAUNCH_LAYOUT_SCENARIOS ? { LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS } : {}),
  });
  execute(`teaching-${browser}-dpr2`, 'scripts/check-teaching-layout.mjs', {
    TEACHING_BROWSER: browser,
    TEACHING_ZOOM: '1',
    TEACHING_DPR: '2',
    TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, 'dpr2'),
    TEACHING_DEVICES: process.env.PRELAUNCH_TEACHING_DEVICES || 'desktop-split,desktop,desktop-4k',
    ...(process.env.PRELAUNCH_TEACHING_SCENARIOS ? { TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS } : {}),
  });
  if (process.argv.includes('--with-zoom')) {
    for (const zoom of zoomFactors) {
      execute(`platform-${browser}-zoom${zoom}`, 'scripts/check-desktop-layout.mjs', {
        LAYOUT_BROWSER: browser, LAYOUT_ZOOM: String(zoom), LAYOUT_DPR: String(zoom),
        LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, `zoom${zoom}`),
        LAYOUT_DEVICES: process.env.PRELAUNCH_ZOOM_DEVICES || 'desktop-1366x768,desktop-1920x1080',
        ...(process.env.PRELAUNCH_LAYOUT_SCENARIOS ? { LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS } : {}),
      });
      execute(`teaching-${browser}-zoom${zoom}`, 'scripts/check-teaching-layout.mjs', {
        TEACHING_BROWSER: browser, TEACHING_ZOOM: String(zoom), TEACHING_DPR: String(zoom),
        TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, `zoom${zoom}`),
        TEACHING_DEVICES: process.env.PRELAUNCH_ZOOM_DEVICES || 'desktop-1366x768,desktop-1920x1080',
        ...(process.env.PRELAUNCH_TEACHING_SCENARIOS ? { TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS } : {}),
      });
    }
  }
}
if (!process.argv.includes('--browser-only')) {
  execute('isolated-functional', 'scripts/verify-prelaunch-functional.mjs', {
    PRELAUNCH_OUTPUT_DIR: path.join(output, 'functional'),
    PRELAUNCH_REAL_PROVIDERS: process.argv.includes('--with-providers') ? '1' : '0',
  }, 1_800_000);
}
if (results.some(result => result.status !== '通过')) process.exitCode = 1;

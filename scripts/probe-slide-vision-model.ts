/** One explicitly selected vision-model protocol probe; never changes production routing. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { initializeServerProviderConfig } from '../src/lib/openmaic/server/provider-config';
import { resolveModel } from '../src/lib/openmaic/server/resolve-model';
import { callLLM } from '../src/lib/openmaic/ai/llm';

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || 'true']; }));
const output = path.resolve(args.get('output') ?? '.openpbl-runtime/slide-vision-probe');
if (!args.has('model')) throw new Error('Explicit --model=provider:model is required');
await mkdir(output, { recursive: true });
if (args.has('service-env')) {
  const pid = execFileSync('systemctl', ['--user', 'show', 'openpbl.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  const allowed = new Set(['DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY', 'JWT_SECRET', 'MODEL_ROUTES', 'DEFAULT_MODEL', 'OPENPBL_OUTBOUND_PROXY']);
  for (const entry of (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')) {
    const index = entry.indexOf('=');
    if (allowed.has(entry.slice(0, index))) process.env[entry.slice(0, index)] = entry.slice(index + 1);
  }
}
await initializeServerProviderConfig();
const resolved = await resolveModel({ modelString: args.get('model') });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
await page.setContent('<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="white"/><text x="130" y="45" font-family="sans-serif" font-size="30">COTEACH 731</text><rect x="45" y="90" width="90" height="70" fill="green"/><circle cx="240" cy="125" r="42" fill="blue"/><path d="M390 82 L440 168 L340 168 Z" fill="red"/></svg></body></html>');
const png = await page.screenshot({ path: path.join(output, 'probe.png') });
await browser.close();
const start = Date.now();
const report: Record<string, unknown> = { at: new Date().toISOString(), model: resolved.modelString, configuredVision: resolved.modelInfo?.capabilities?.vision === true, logicalCalls: 1, transportRetries: 0, expected: { text: 'COTEACH 731', objectsLeftToRight: ['green rectangle', 'blue circle', 'red triangle'] }, prompt: 'Read the exact text in the attached image. Then list each shape and its color, from left to right. Return JSON with text and objectsLeftToRight. Do not guess if the image cannot be accessed.' };
try {
  const result = await callLLM({ model: resolved.model, system: 'Describe only what is visible in the supplied image.', messages: [{ role: 'user', content: [{ type: 'text', text: String(report.prompt) }, { type: 'image', image: `data:image/png;base64,${png.toString('base64')}` }] }], maxOutputTokens: 2048, maxRetries: 0, abortSignal: AbortSignal.timeout(120000) }, 'offline-slide-vision-probe', undefined, resolved.thinkingConfig);
  report.response = result.text;
  report.usage = result.usage;
  report.status = 'responded';
} catch (error) {
  report.status = 'failed';
  report.error = String(error instanceof Error ? error.message : error).split(resolved.apiKey || '\0').join('[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 1500);
}
report.elapsedMs = Date.now() - start;
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exit(report.status === 'responded' ? 0 : 1);

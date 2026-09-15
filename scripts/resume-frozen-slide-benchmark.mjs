/** Resume a stopped experiment using its original bundle, never current implementation code. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const original = path.resolve(argument('runtime') ?? '.openpbl-runtime/first-pass-benchmark-runtime.mjs');
const output = path.resolve(argument('output') ?? '.openpbl-runtime/first-pass-benchmark-final');
const expectedHash = argument('expected-runtime-sha256');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const frozen = await readFile(original, 'utf8');
if (!expectedHash || sha(frozen) !== expectedHash) throw new Error('Explicit matching --expected-runtime-sha256 is required');
const metadata = JSON.parse(await readFile(path.join(output, 'metadata.json'), 'utf8'));
const require = createRequire(import.meta.url);
const { transform } = createRequire(require.resolve('tsx'))('esbuild');
const extract = (source) => `async function generateSlideContent(${source.split('async function generateSlideContent(')[1].split('async function generateQuizContent(')[0]}`;
const normalize = async (source, loader) => (await transform(source, { loader, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false })).code;
const currentSlide = await normalize(extract(await readFile('src/lib/openmaic/generation/scene-generator.ts', 'utf8')), 'ts');
const frozenSlide = await normalize(extract(frozen).replace(/\blog12\b/g, 'log').replace(/\bnanoid7\b/g, 'nanoid'), 'js');
if (currentSlide !== frozenSlide) throw new Error('The current slide generation function differs from frozen runtime; investigate before resuming');
const fingerprintLine = 'const implementationSha256 = sha((await Promise.all(implementationSources.map((file) => readFile2(path5.join(root, file), "utf8")))).join("\\n"));';
if (!frozen.includes(fingerprintLine)) throw new Error('Unsupported frozen harness');
const baselinePath = path.join(output, 'baseline-source/scene-generator.mjs');
const baselineSha256 = sha(await readFile(baselinePath));
// Only experiment bookkeeping is changed. The model implementation and saved baseline are immutable.
const resumed = frozen.replace(fingerprintLine, `const implementationSha256 = ${JSON.stringify(metadata.implementationSha256)};`)
  .replace('await snapshotBaseline(String(metadata.baselineCommit));', '/* Reuse the already compiled, frozen baseline runtime. */');
const resumedPath = path.join(path.dirname(original), 'first-pass-benchmark-frozen-resume.mjs');
await writeFile(resumedPath, resumed);
await writeFile(path.join(output, 'resume-evidence.json'), JSON.stringify({ at: new Date().toISOString(), originalRuntimeSha256: sha(frozen), resumedRuntimeSha256: sha(resumed), baselineRuntimeSha256: baselineSha256, originalImplementationSha256: metadata.implementationSha256, slideFunctionEquivalent: true, rationale: 'The original runtime is reused. Only the obsolete live-source fingerprint calculation and baseline recompilation call are bypassed. All saved result files are retained; model and sample hash checks remain active.' }, null, 2));
const forwarded = process.argv.slice(2).filter((arg) => !arg.startsWith('--runtime=') && !arg.startsWith('--expected-runtime-sha256='));
const child = spawnSync(process.execPath, [resumedPath, ...forwarded], { stdio: 'inherit', env: process.env });
process.exit(child.status ?? 1);

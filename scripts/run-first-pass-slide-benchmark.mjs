import { createRequire } from 'node:module';
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const experiment = path.resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) ?? '.openpbl-runtime/first-pass-benchmark');
const output = path.join(experiment, 'generation-runtime.mjs');
await mkdir(experiment, { recursive: true });
const exists = (file) => access(file).then(() => true, () => false);
if (await exists(path.join(experiment, 'metadata.json'))) {
  if (!await exists(output)) throw new Error('Legacy experiment has no per-directory runtime; use resume-frozen-slide-benchmark.mjs with its preserved original runtime and hash');
} else {
  await build({ entryPoints: ['scripts/benchmark-first-pass-slides.ts'], outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    banner: { js: "import {createRequire as __benchmarkCreateRequire} from 'node:module'; const require = __benchmarkCreateRequire(import.meta.url);" } });
}
const child = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(child.status ?? 1);

import { createRequire } from 'node:module';
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputDir = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : '.openpbl-runtime/teaching-stage-first-pass');
await mkdir(outputDir, { recursive: true });
const bundle = path.join(outputDir, 'frozen-runtime.mjs');
const exists = (file) => access(file).then(() => true, () => false);
if (!await exists(bundle)) {
  if (await exists(path.join(outputDir, 'manifest.json'))) throw new Error('Cannot rebuild the runtime of an existing experiment');
  await build({ entryPoints: ['scripts/evaluate-teaching-stage-first-pass.ts'], outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    banner: { js: "import {createRequire as __experimentRequire} from 'node:module'; const require = __experimentRequire(import.meta.url);" } });
}
const result = spawnSync(process.execPath, [bundle, ...args], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);

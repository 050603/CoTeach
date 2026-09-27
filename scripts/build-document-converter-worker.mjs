import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const output = path.join(root, 'workers/docx-converter.cjs');
await mkdir(path.dirname(output), { recursive: true });
const result = await build({ entryPoints: [path.join(root, 'src/lib/project-practice/document-conversion-worker.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', sourcemap: false,
});
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
for (const file of Object.values(result.metafile.outputs)) for (const dependency of file.imports) {
  assert.ok(dependency.external && builtins.has(dependency.path), `Worker retains runtime dependency: ${dependency.path}`);
}
const bytes = await readFile(output);
await writeFile(path.join(root, 'workers/docx-converter-manifest.json'), JSON.stringify({ protocol: 1, file: 'docx-converter.cjs', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, target: 'node22', externalDependencies: 'node-builtins-only' }, null, 2) + '\n');
// Prove the bundle boots and converts with no source/node_modules/loader nearby.
const temporary = await mkdtemp(path.join(tmpdir(), 'openpbl-docx-bundle-'));
const originalCwd = process.cwd(); let worker;
try {
  const isolated = path.join(temporary, 'docx-converter.cjs'); await copyFile(output, isolated);
  process.chdir(temporary);
  worker = new Worker(isolated, { execArgv: [], env: { NODE_ENV: 'production', TZ: 'UTC' } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated worker self-check timeout')), 20000);
    worker.once('error', reject); worker.once('exit', code => reject(new Error(`Worker exited before self-check: ${code}`)));
    worker.on('message', message => {
      if (message.type === 'ready') { assert.equal(message.protocol, 1); worker.postMessage({ type: 'convert', id: 'self-check', input: { html: '<h1>独立产物验证</h1><p>完整归档</p>', title: '验证', imageCount: 0 } }); }
      else if (message.type === 'result') {
        try { assert.equal(message.id, 'self-check'); assert.ok(message.bytes.byteLength > 0); assert.equal(createHash('sha256').update(message.bytes).digest('hex'), message.sha256); clearTimeout(timeout); resolve(); }
        catch (error) { clearTimeout(timeout); reject(error); }
      } else { clearTimeout(timeout); reject(new Error(`Isolated worker failed: ${message.code || message.error}`)); }
    });
  });
} finally { await worker?.terminate(); process.chdir(originalCwd); await rm(temporary, { recursive: true, force: true }); }
console.log(`DOCX worker bundle verified without source, dependencies or loader: ${bytes.length} bytes`);

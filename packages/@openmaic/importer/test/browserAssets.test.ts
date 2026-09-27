import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('hosts the importer with a same-origin legacy PDF worker while preserving the package default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'importer-browser-assets-'));
  try {
    const script = path.join(root, 'scripts/sync-maic-importer.mjs');
    const dist = path.join(root, 'packages/@openmaic/importer/dist');
    const pdfjs = path.join(root, 'packages/@openmaic/importer/node_modules/pdfjs-dist/legacy/build');
    await Promise.all([mkdir(path.dirname(script), { recursive: true }), mkdir(dist, { recursive: true }), mkdir(pdfjs, { recursive: true })]);
    await copyFile(fileURLToPath(new URL('../../../../scripts/sync-maic-importer.mjs', import.meta.url)), script);
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(dist, 'index.js'), [
      'export let workerSrc = "https://cdn.example/pdf.worker.mjs";',
      'export function configurePdfWorker(src) { workerSrc = src; }',
      'export function parse() { return "parsed"; }',
    ].join('\n'));
    await writeFile(path.join(pdfjs, 'pdf.min.mjs'), 'legacy-main');
    await writeFile(path.join(pdfjs, 'pdf.worker.min.mjs'), 'legacy-worker');

    execFileSync(process.execPath, [script], { encoding: 'utf8' });
    const hostedEntry = path.join(root, 'public/vendor/maic-importer/index.js');
    const hosted = await import(/* @vite-ignore */ pathToFileURL(hostedEntry).href);
    expect(hosted.parse()).toBe('parsed');
    expect(hosted.workerSrc).toBe(pathToFileURL(path.join(root, 'public/vendor/pdfjs/pdf.worker.legacy.min.mjs')).href);
    expect(await readFile(fileURLToPath(hosted.workerSrc), 'utf8')).toBe('legacy-worker');
    const original = await import(/* @vite-ignore */ pathToFileURL(path.join(dist, 'index.js')).href);
    expect(original.workerSrc).toBe('https://cdn.example/pdf.worker.mjs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

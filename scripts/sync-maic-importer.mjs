#!/usr/bin/env node
/**
 * Copy browser-only document parsers to public/vendor/ so the app can
 * load them at runtime via URL-based dynamic imports.
 *
 * Why: the bundle contains dynamic `require()` patterns (from pdfjs-dist)
 * that Turbopack rejects as a hard "Module not found: Can't resolve <dynamic>"
 * error. By serving it as a static asset and importing it via a runtime URL,
 * we bypass the bundler entirely while keeping types via the workspace package.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'packages/@openmaic/importer/dist');
const destDir = path.join(root, 'public/vendor/maic-importer');
// The modern bundle requires newer APIs (including Promise.withResolvers)
// than our desktop browser baseline. Both realms need the legacy polyfills.
const pdfJsSrcDir = path.join(root, 'packages/@openmaic/importer/node_modules/pdfjs-dist/legacy/build');
const pdfJsDestDir = path.join(root, 'public/vendor/pdfjs');

try {
  await stat(srcDir);
} catch {
  console.error(`[sync-maic-importer] missing dist: ${srcDir}`);
  console.error('Run `cd packages/@openmaic/importer && pnpm run build` first.');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true });

await rm(pdfJsDestDir, { recursive: true, force: true });
await mkdir(pdfJsDestDir, { recursive: true });
await Promise.all([
  cp(path.join(pdfJsSrcDir, 'pdf.min.mjs'), path.join(pdfJsDestDir, 'pdf.legacy.min.mjs')),
  cp(path.join(pdfJsSrcDir, 'pdf.worker.min.mjs'), path.join(pdfJsDestDir, 'pdf.worker.legacy.min.mjs')),
]);

console.log(
  `[sync-maic-importer] copied document parsers → public/vendor`,
);

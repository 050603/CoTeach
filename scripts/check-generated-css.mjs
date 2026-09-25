import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const cssDirectory = path.resolve(process.env.NEXT_DIST_DIR || '.next-build', 'static/css');
const cssFiles = readdirSync(cssDirectory).filter((name) => name.endsWith('.css'));
if (cssFiles.length === 0) throw new Error(`No generated CSS found in ${cssDirectory}`);

const decoder = new TextDecoder('utf-8', { fatal: true });
for (const name of cssFiles) {
  const bytes = readFileSync(path.join(cssDirectory, name));
  const css = decoder.decode(bytes);
  if (css.includes('\0') || css.includes('\uFFFD')) {
    throw new Error(`Generated CSS contains damaged text: ${path.join(cssDirectory, name)}`);
  }
}

console.log(`Generated CSS integrity: ${cssFiles.length} files passed`);

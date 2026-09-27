import { access } from 'node:fs/promises';
import path from 'node:path';

const standalone = path.resolve(process.env.NEXT_DIST_DIR || '.next-build', 'standalone');
const forbidden = ['.openpbl-data', '.openpbl-runtime', 'data/classrooms', 'deploy/secrets', 'deploy/.deploy.env', 'test-results'];
const included = [];
for (const entry of forbidden) {
  try { await access(path.join(standalone, entry)); included.push(entry); } catch { /* correctly excluded */ }
}
if (included.length) {
  console.error(`Production build contains private runtime data: ${included.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Production build excludes classroom data, backups and deployment credentials.');
}

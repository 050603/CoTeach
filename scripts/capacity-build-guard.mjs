import { readFile, readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function readCapacityBuildId(file, read = readFile) {
  let value;
  try { value = (await read(file, 'utf8')).trim(); }
  catch (error) { throw new Error('Acceptance build identity is unavailable; a build may be in progress', { cause: error }); }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || value === 'build-in-progress') {
    throw new Error('Acceptance build identity is invalid; require a completed production build');
  }
  return value;
}

export async function assertCapacityBuildUnchanged(file, expected, read = readFile) {
  if (!expected) throw new Error('Acceptance did not capture a valid starting build identity');
  const actual = await readCapacityBuildId(file, read);
  if (actual !== expected) throw new Error(`Acceptance build changed from ${expected} to ${actual}; environment was modified during the workload`);
  return actual;
}

/** Local migration inputs only; no SQL content or database credentials in evidence. */
export async function readCapacityMigrationIdentity(directory, { requireLock = true } = {}) {
  const root = path.resolve(directory);
  const files = [];
  async function walk(current) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || await realpath(current) !== current) throw new Error('Acceptance migration identity rejects symbolic links');
    if (!info.isDirectory()) throw new Error('Acceptance migration directory is unavailable');
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const location = path.join(current, entry.name);
      const stat = await lstat(location);
      if (stat.isSymbolicLink()) throw new Error('Acceptance migration identity rejects symbolic links');
      if (stat.isDirectory()) { await walk(location); continue; }
      if (entry.name !== 'migration.sql' && entry.name !== 'migration_lock.toml') continue;
      if (!stat.isFile()) throw new Error('Acceptance migration input is not a regular file');
      const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('Acceptance migration input changed during inspection');
        const content = await handle.readFile();
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Acceptance migration input changed during inspection');
        files.push({ path: path.relative(root, location).split(path.sep).join('/'), sha256: createHash('sha256').update(content).digest('hex') });
      } finally { await handle.close(); }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (requireLock && !files.some(file => file.path === 'migration_lock.toml')) throw new Error('Acceptance migration lock identity is unavailable');
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

export async function assertCapacityMigrationsUnchanged(directory, expected) {
  if (!expected?.files || !expected.sha256) throw new Error('Acceptance did not capture a valid starting migration identity');
  const actual = await readCapacityMigrationIdentity(directory, { requireLock: false });
  if (actual.sha256 !== expected.sha256) {
    const before = new Map(expected.files.map(file => [file.path, file.sha256]));
    const after = new Map(actual.files.map(file => [file.path, file.sha256]));
    const diff = {
      added: actual.files.filter(file => !before.has(file.path)),
      removed: expected.files.filter(file => !after.has(file.path)),
      changed: actual.files.filter(file => before.has(file.path) && before.get(file.path) !== file.sha256)
        .map(file => ({ path: file.path, before: before.get(file.path), after: file.sha256 })),
    };
    const error = new Error('Acceptance migration inputs changed; refusing to continue or restart the service');
    error.migrationDiff = diff;
    throw error;
  }
  return actual;
}

/** Check immediately before the restart callback, which may apply migrations. */
export async function withCapacityRestartIdentityGuard({ buildFile, buildId, migrationsDirectory, migrationIdentity }, restart) {
  await assertCapacityBuildUnchanged(buildFile, buildId);
  await assertCapacityMigrationsUnchanged(migrationsDirectory, migrationIdentity);
  return restart();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readCapacityBuildId, assertCapacityBuildUnchanged } from './capacity-build-guard.mjs';

test('requires a valid completed build at startup and accepts unchanged identity', async () => {
  const read = async () => 'Abc_123-x\n';
  const original = await readCapacityBuildId('/unused', read);
  assert.equal(original, 'Abc_123-x');
  assert.equal(await assertCapacityBuildUnchanged('/unused', original, read), original);
});
test('missing identity fails both startup and subsequent checks', async () => {
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(readCapacityBuildId('/unused', missing), /unavailable/);
  await assert.rejects(assertCapacityBuildUnchanged('/unused', 'original', missing), /unavailable/);
});
test('changed build fails and retains both original and observed identities in evidence', async () => {
  await assert.rejects(assertCapacityBuildUnchanged('/unused', 'original', async () => 'changed'), /original to changed/);
});
test('empty, placeholder, malformed and absent starting identity fail closed', async () => {
  for (const value of ['', 'build-in-progress', 'two ids', 'a\nb', 'x'.repeat(129)]) {
    await assert.rejects(readCapacityBuildId('/unused', async () => value), /invalid/);
  }
  await assert.rejects(assertCapacityBuildUnchanged('/unused', undefined, async () => 'new'), /starting build/);
});

import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCapacityMigrationIdentity, assertCapacityMigrationsUnchanged, withCapacityRestartIdentityGuard } from './capacity-build-guard.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'capacity-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrationsDirectory = path.join(root, 'migrations');
  await mkdir(path.join(migrationsDirectory, '002'), { recursive: true });
  await mkdir(path.join(migrationsDirectory, '001'));
  await writeFile(path.join(migrationsDirectory, 'migration_lock.toml'), 'provider = "postgresql"');
  for (const name of ['002', '001']) await writeFile(path.join(migrationsDirectory, name, 'migration.sql'), `SELECT ${name};`);
  const buildFile = path.join(root, 'BUILD_ID'); await writeFile(buildFile, 'build-one');
  return { buildFile, buildId: 'build-one', migrationsDirectory, migrationIdentity: await readCapacityMigrationIdentity(migrationsDirectory) };
}
test('migration identity sorts relative filenames and accepts same-content rewrites', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.migrationIdentity.files.map(file => file.path), ['001/migration.sql', '002/migration.sql', 'migration_lock.toml']);
  await writeFile(path.join(f.migrationsDirectory, '001/migration.sql'), 'SELECT 001;');
  assert.deepEqual(await assertCapacityMigrationsUnchanged(f.migrationsDirectory, f.migrationIdentity), f.migrationIdentity);
  assert.ok(f.migrationIdentity.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(!JSON.stringify(f.migrationIdentity).includes('SELECT'));
});
for (const mutation of ['add', 'remove', 'change', 'lock-change']) {
  test(`migration ${mutation} blocks restart and retains original baseline and hash-only diff`, async t => {
    const f = await fixture(t), original = JSON.stringify(f.migrationIdentity);
    if (mutation === 'add') { await mkdir(path.join(f.migrationsDirectory, '003')); await writeFile(path.join(f.migrationsDirectory, '003/migration.sql'), 'SELECT secret_body;'); }
    if (mutation === 'remove') await rm(path.join(f.migrationsDirectory, '001/migration.sql'));
    if (mutation === 'change') await writeFile(path.join(f.migrationsDirectory, '001/migration.sql'), 'SELECT secret_body;');
    if (mutation === 'lock-change') await writeFile(path.join(f.migrationsDirectory, 'migration_lock.toml'), 'changed');
    let restarts = 0;
    await assert.rejects(withCapacityRestartIdentityGuard(f, () => { restarts++; }), error => {
      const category = mutation === 'add' ? 'added' : mutation === 'remove' ? 'removed' : 'changed';
      assert.equal(error.migrationDiff[category].length, 1);
      assert.ok(!JSON.stringify(error.migrationDiff).includes('secret_body'));
      return /migration inputs changed/.test(error.message);
    });
    assert.equal(restarts, 0); assert.equal(JSON.stringify(f.migrationIdentity), original);
  });
}
test('unchanged restart returns callback result; changed build blocks it', async t => {
  const f = await fixture(t); let restarts = 0;
  assert.equal(await withCapacityRestartIdentityGuard(f, () => { restarts++; return 'restarted'; }), 'restarted');
  await writeFile(f.buildFile, 'build-two');
  await assert.rejects(withCapacityRestartIdentityGuard(f, () => { restarts++; }), /build changed/);
  assert.equal(restarts, 1);
});
for (const target of ['file', 'directory', 'root']) {
  test(`rejects migration ${target} symlinks`, async t => {
    const f = await fixture(t);
    if (target === 'file') {
      await rm(path.join(f.migrationsDirectory, '001/migration.sql'));
      await symlink('../002/migration.sql', path.join(f.migrationsDirectory, '001/migration.sql'));
    } else if (target === 'directory') await symlink('002', path.join(f.migrationsDirectory, 'linked'));
    else { const link = `${f.migrationsDirectory}-link`; await symlink(f.migrationsDirectory, link); f.migrationsDirectory = link; }
    let restarts = 0;
    await assert.rejects(withCapacityRestartIdentityGuard(f, () => { restarts++; }), /symbolic links/);
    assert.equal(restarts, 0);
  });
}
test('missing migration lock fails closed', async t => {
  const f = await fixture(t); await rm(path.join(f.migrationsDirectory, 'migration_lock.toml'));
  await assert.rejects(readCapacityMigrationIdentity(f.migrationsDirectory), /lock identity is unavailable/);
  await assert.rejects(assertCapacityMigrationsUnchanged(f.migrationsDirectory, f.migrationIdentity), error => {
    assert.equal(error.migrationDiff.removed[0].path, 'migration_lock.toml'); return true;
  });
});

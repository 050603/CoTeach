import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Atomic replacement: readers see the complete prior or complete new report.
 * A post-rename directory fsync failure still rejects; rollback is not claimed.
 */
export async function writeCapacityReport(file, report, io = { open, rename, unlink }) {
  const serialized = JSON.stringify(report, null, 2);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle; let directory; let owned = false; let failure;
  try {
    handle = await io.open(temporary, 'wx', 0o600); owned = true;
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await io.rename(temporary, file); owned = false;
    directory = await io.open(path.dirname(file), 'r');
    await directory.sync();
  } catch (error) { failure = error; }
  finally {
    for (const resource of [handle, directory]) {
      if (resource) try { await resource.close(); } catch (error) { failure ??= error; }
    }
    if (owned) try { await io.unlink(temporary); } catch (error) {
      if (error.code !== 'ENOENT') failure ??= error;
    }
  }
  if (failure) throw failure;
}

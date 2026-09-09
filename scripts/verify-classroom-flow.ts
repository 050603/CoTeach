// Historical command now runs the V2 persistence suite in a disposable database.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-research-database.mjs', import.meta.url))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

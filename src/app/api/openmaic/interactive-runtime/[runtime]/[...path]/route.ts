import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PYODIDE_VERSION = '0.25.0';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// Optional Pyodide wheels are fetched once by the server and cached under the
// existing writable/persistent data volume. The production container runs as
// an unprivileged user and cannot safely create arbitrary directories in the
// application root; `.openpbl-data` is created and chowned by the image.
const RUNTIME_CACHE_DIR = path.join(
  process.cwd(),
  '.openpbl-data',
  'interactive-runtime-cache',
);
const CODEMIRROR_ROOT = path.join(process.cwd(), 'node_modules', 'codemirror');
const KATEX_ROOT = path.join(process.cwd(), 'node_modules', 'katex', 'dist');
const MONACO_ROOT = path.join(process.cwd(), 'node_modules', 'monaco-editor', 'min', 'vs');
const PYODIDE_ROOT = path.join(process.cwd(), 'node_modules', 'pyodide');
const THREE_VERSION = '0.160.0';
const THREE_ROOT = path.join(process.cwd(), 'node_modules', 'three');
let pyodidePackageFilesPromise: Promise<Set<string>> | null = null;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.data': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.tar': 'application/x-tar',
  '.wasm': 'application/wasm',
  '.whl': 'application/zip',
  '.zip': 'application/zip',
};

function isSafePath(parts: string[]): boolean {
  return (
    parts.length > 0 &&
    parts.every((part) => /^[A-Za-z0-9@_+.,-]+$/.test(part) && part !== '.' && part !== '..')
  );
}

function responseFor(bytes: Uint8Array, fileName: string): Response {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(bytes.byteLength),
      'Content-Type': MIME_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

async function readLocalAsset(root: string, pathParts: string[]): Promise<Uint8Array | null> {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, ...pathParts);
  if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function allowedPyodidePackageFiles(): Promise<Set<string>> {
  pyodidePackageFilesPromise ??= fs
    .readFile(path.join(PYODIDE_ROOT, 'pyodide-lock.json'), 'utf8')
    .then((raw) => {
      const lock = JSON.parse(raw) as { packages?: Record<string, { file_name?: unknown }> };
      return new Set(
        Object.values(lock.packages ?? {}).flatMap((pkg) =>
          typeof pkg.file_name === 'string' ? [pkg.file_name] : [],
        ),
      );
    });
  return pyodidePackageFilesPromise;
}

async function fetchAndCachePyodideAsset(pathParts: string[]): Promise<Uint8Array | null> {
  if (pathParts.length !== 1 || !(await allowedPyodidePackageFiles()).has(pathParts[0])) {
    return null;
  }
  const cacheRoot = path.join(RUNTIME_CACHE_DIR, `pyodide-${PYODIDE_VERSION}`);
  const cached = await readLocalAsset(cacheRoot, pathParts);
  if (cached) return cached;

  const remoteUrl = new URL(pathParts.map(encodeURIComponent).join('/'), PYODIDE_CDN);
  const response = await fetch(remoteUrl, {
    cache: 'force-cache',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;

  const bytes = new Uint8Array(await response.arrayBuffer());
  const filePath = path.resolve(cacheRoot, ...pathParts);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Blue/green app containers can share this cache volume. Use a random
  // suffix so concurrent first requests from processes with the same PID do
  // not write the same temporary file.
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, bytes);
  await fs.rename(temporaryPath, filePath).catch(async () => {
    await fs.rm(temporaryPath, { force: true });
  });
  return bytes;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runtime: string; path: string[] }> },
) {
  const { runtime: runtimeName, path: pathParts } = await context.params;
  if (!isSafePath(pathParts)) {
    return new Response('Invalid interactive runtime path', { status: 400 });
  }

  try {
    let bytes: Uint8Array | null = null;
    if (runtimeName === 'codemirror') {
      bytes = await readLocalAsset(CODEMIRROR_ROOT, pathParts);
    } else if (runtimeName === 'katex') {
      bytes = await readLocalAsset(KATEX_ROOT, pathParts);
    } else if (runtimeName === 'monaco') {
      bytes = await readLocalAsset(MONACO_ROOT, pathParts);
    } else if (runtimeName === 'three') {
      const [version, ...assetParts] = pathParts;
      const assetPath = assetParts.join('/');
      // Serve only executable browser assets from the pinned package. Never
      // expose package metadata, server entry points, or arbitrary CDN fetches.
      const allowed = /^build\/three(?:\.module)?(?:\.min)?\.js$/.test(assetPath)
        || /^examples\/jsm\/.+\.js$/.test(assetPath);
      if (version !== THREE_VERSION || !allowed) return new Response('Unknown Three.js runtime asset', { status: 404 });
      bytes = await readLocalAsset(THREE_ROOT, assetParts);
    } else if (runtimeName === 'pyodide') {
      bytes = await readLocalAsset(PYODIDE_ROOT, pathParts);
      bytes ??= await fetchAndCachePyodideAsset(pathParts);
    } else {
      return new Response('Unknown interactive runtime', { status: 404 });
    }

    if (!bytes) return new Response('Interactive runtime asset not found', { status: 404 });
    return responseFor(bytes, pathParts.at(-1) ?? 'runtime.bin');
  } catch (error) {
    console.error('[interactive-runtime] Failed to serve asset', {
      runtime: runtimeName,
      path: pathParts.join('/'),
      error,
    });
    return new Response('Failed to load interactive runtime asset', { status: 502 });
  }
}

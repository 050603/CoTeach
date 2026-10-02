// @vitest-environment node
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Use the repository's existing bundler dependency through its owning package.
const { build } = createRequire(require.resolve('tsx'))('esbuild') as {
  build(options: Record<string, unknown>): Promise<{
    metafile: { inputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }> };
    outputFiles: Array<{ text: string }>;
  }>;
};

describe('teaching visual browser dependency boundary', () => {
  it('bundles the complete editor recompose and scene/source helpers without Node services', async () => {
    const result = await build({
      absWorkingDir: process.cwd(),
      entryPoints: [
        'src/lib/openmaic/edit/teaching-visual-recompose.ts',
        'src/lib/openmaic/generation/teaching-visual-scene.ts',
      ],
      bundle: true, platform: 'browser', format: 'esm', write: false,
      outdir: 'unused-in-memory-output', metafile: true, treeShaking: false,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).map((name) => name.split(path.sep).join('/'));
    expect(inputs).toContain('packages/@openmaic/generation/dist/browser.js');
    expect(inputs).toContain('packages/@openmaic/generation/dist/diagram-compiler.js');
    expect(inputs).toContain('src/lib/openmaic/generation/visible-content.ts');
    expect(inputs).not.toContain('packages/@openmaic/generation/dist/index.js');
    expect(inputs.some((name) => name.includes('/prompts/loader.')
      || name.includes('/slide-spatial-measurement.') || name.includes('/semantic-page-capacity.'))).toBe(false);
    const imports = Object.values(result.metafile.inputs).flatMap((file) => file.imports);
    expect(imports.filter((item) => item.external || isBuiltin(item.path))).toEqual([]);
    expect(result.outputFiles).toHaveLength(2);
  }, 15_000);
});

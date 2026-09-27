import { describe, expect, it } from 'vitest';
import { patchHtmlForIframe } from './iframe';

describe('patchHtmlForIframe activity bridge', () => {
  it('exposes an explicit completion/reset API before generated page scripts', () => {
    const html = '<html><head></head><body><script>window.generatedPageLoaded = true;</script></body></html>';
    const patched = patchHtmlForIframe(html);

    expect(patched).toContain('window.__maicActivity');
    expect(patched).toContain("complete: function () { postActivity('activity-complete'); }");
    expect(patched).toContain("reset: function () { postActivity('activity-reset'); }");
    expect(patched.indexOf('window.__maicActivity')).toBeLessThan(
      patched.indexOf('window.generatedPageLoaded'),
    );
  });

  it('keeps declarative completion and reset controls as compatibility fallbacks', () => {
    const patched = patchHtmlForIframe('<main></main>');

    expect(patched).toContain('[data-activity-complete]');
    expect(patched).toContain('[data-activity-reset]');
    expect(patched).toContain("postActivity('activity-complete')");
    expect(patched).toContain("postActivity('activity-reset')");
  });

  it('does not treat an arbitrary form submission or answer check as mastery', () => {
    const patched = patchHtmlForIframe('<form><button type="submit">Check</button></form>');

    expect(patched).not.toContain('button[type="submit"]');
    expect(patched).not.toContain('#check-answer');
    expect(patched).not.toContain("document.addEventListener('submit'");
  });
});

describe('patchHtmlForIframe interactive runtimes', () => {
  it.each(['https://unpkg.com/three@0.160.0/', 'https://cdn.jsdelivr.net/npm/three@0.160.0/', '//unpkg.com/three/'])('self-hosts Three.js import maps and addons from %s', (cdn) => {
    const html = `<script type="importmap">{"imports":{"three":"${cdn}build/three.module.js","three/addons/":"${cdn}examples/jsm/"}}</script><script type="module">import { OrbitControls } from '${cdn}addons/controls/OrbitControls.js';</script>`;
    const patched = patchHtmlForIframe(html);
    expect(patched).toContain('"three":"/api/openmaic/interactive-runtime/three/0.160.0/build/three.module.js"');
    expect(patched).toContain('"three/addons/":"/api/openmaic/interactive-runtime/three/0.160.0/examples/jsm/"');
    expect(patched).toContain("import { OrbitControls } from '/api/openmaic/interactive-runtime/three/0.160.0/examples/jsm/controls/OrbitControls.js'");
    expect(patched).not.toContain(cdn);
  });

  it('routes generated Pyodide and CodeMirror assets through the same-origin runtime service', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
      <script src="https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"></script>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
    </head><body><script>
      const runtime = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.0/full/' });
    </script></body></html>`;

    const patched = patchHtmlForIframe(html);

    expect(patched).toContain('/api/openmaic/interactive-runtime/codemirror/lib/codemirror.css');
    expect(patched).toContain('/api/openmaic/interactive-runtime/codemirror/lib/codemirror.js');
    expect(patched).toContain('/api/openmaic/interactive-runtime/codemirror/mode/python/python.js');
    expect(patched).toContain('/api/openmaic/interactive-runtime/pyodide/pyodide.js');
    expect(patched).toContain('/api/openmaic/interactive-runtime/katex/katex.min.css');
    expect(patched).toContain('/api/openmaic/interactive-runtime/katex/contrib/auto-render.min.js');
    expect(patched).toContain(
      "indexURL: new URL('/api/openmaic/interactive-runtime/pyodide/', document.baseURI).href",
    );
    expect(patched).not.toContain('cdnjs.cloudflare.com');
    expect(patched).not.toContain('cdn.jsdelivr.net/pyodide');
    expect(patched).not.toContain('cdn.jsdelivr.net/npm/katex');
  });

  it('repairs other generated CDN versions instead of depending on one exact version', () => {
    const html = `<html><head>
      <script src="https://unpkg.com/pyodide@0.27.7/pyodide.js" defer></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.64.0/codemirror.min.js"></script>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
    </head><body><script>
      loadPyodide({ indexURL: "https://unpkg.com/pyodide@0.27.7/" });
    </script></body></html>`;

    const patched = patchHtmlForIframe(html);

    expect(patched).toContain('/api/openmaic/interactive-runtime/pyodide/pyodide.js');
    expect(patched).toContain('/api/openmaic/interactive-runtime/codemirror/lib/codemirror.js');
    expect(patched).toContain('/api/openmaic/interactive-runtime/katex/katex.min.css');
    expect(patched).not.toContain('unpkg.com');
    expect(patched).not.toContain('cdnjs.cloudflare.com');
    expect(patched).not.toContain('cdn.jsdelivr.net');
  });

  it('defines a retryable local Pyodide loader before generated code when the loader is missing', () => {
    const generatedCode = '<script>loadPyodide().then(() => window.ready = true);</script>';
    const patched = patchHtmlForIframe(`<html><head></head><body>${generatedCode}</body></html>`);

    expect(patched).toContain('data-iframe-pyodide-loader');
    expect(patched).toContain("script.src = loaderUrl");
    expect(patched).toContain(
      "runtimeBase = new URL('/api/openmaic/interactive-runtime/pyodide/', document.baseURI).href",
    );
    expect(patched).toContain("safeOptions.indexURL = runtimeBase");
    expect(patched).toContain("loaderPromise = null");
    expect(patched.indexOf('data-iframe-pyodide-loader')).toBeLessThan(
      patched.indexOf(generatedCode),
    );
  });

  it('does not add the Python runtime to interactions that do not execute Python', () => {
    const patched = patchHtmlForIframe(
      '<html><head></head><body><script>window.answer = 42;</script></body></html>',
    );

    expect(patched).not.toContain('data-iframe-pyodide-loader');
    expect(patched).not.toContain('/interactive-runtime/pyodide/pyodide.js');
  });

  it('does not rewrite generated program logic while repairing known runtime asset URLs', () => {
    const source = '<script>const py = await loadPyodide();</script>';
    const patched = patchHtmlForIframe(`<html><head></head><body>${source}</body></html>`);

    expect(patched).toContain(source);
    expect(patched).not.toContain('__maicLoadPyodide');
  });
});

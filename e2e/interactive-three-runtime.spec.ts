import { expect, test } from '@playwright/test';
import { patchHtmlForIframe } from '../src/lib/openmaic/utils/iframe';

test('sandboxed Three.js and OrbitControls load locally and render a 3D scene under production CSP', async ({ page }) => {
  const diagnostics: string[] = [];
  const runtimeResponses: Array<{ url: string; status: number }> = [];
  const externalRequests: string[] = [];
  page.on('pageerror', (error) => diagnostics.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(message.text()); });
  page.on('response', (response) => {
    if (response.url().includes('/interactive-runtime/three/')) runtimeResponses.push({ url: response.url(), status: response.status() });
  });
  await page.route(/https?:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//, (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  const html = `<!doctype html><html><head>
    <script type="importmap">{"imports": {
      "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }}</script>
    </head><body><script type="module">
      import * as THREE from 'three';
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
      import { SVGRenderer } from 'three/addons/renderers/SVGRenderer.js';
      try {
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        camera.position.set(3, 2, 4);
        const renderer = new SVGRenderer();
        renderer.setSize(240, 240);
        document.body.appendChild(renderer.domElement);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.update();
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0x2288dd })));
        renderer.render(scene, camera);
        window.parent.postMessage({ threeProbe: true, revision: THREE.REVISION, paths: renderer.domElement.querySelectorAll('path').length }, '*');
      } catch (error) {
        window.parent.postMessage({ threeProbe: true, error: String(error) }, '*');
      }
    </script></body></html>`;
  const result = await page.evaluate((srcdoc) => new Promise<{ revision?: string; paths?: number; error?: string }>((resolve) => {
    const timer = window.setTimeout(() => resolve({ error: 'Three.js runtime timed out' }), 15_000);
    const onMessage = (event: MessageEvent) => {
      if (!event.data?.threeProbe) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    window.addEventListener('message', onMessage);
    const iframe = document.createElement('iframe');
    iframe.id = 'three-runtime-probe';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
  }), patchHtmlForIframe(html));

  expect(result.error, diagnostics.join('\n')).toBeUndefined();
  expect(result.revision).toBe('160');
  expect(result.paths).toBeGreaterThan(0);
  expect(externalRequests).toEqual([]);
  // Branded Chromium may deliver the sandbox's network events after its
  // postMessage. Wait for those events before checking the completed imports.
  await expect.poll(() => runtimeResponses.length).toBeGreaterThanOrEqual(4);
  expect(runtimeResponses.every((response) => response.status === 200)).toBe(true);
  await expect(page.locator('#three-runtime-probe')).toHaveAttribute('sandbox', 'allow-scripts');
});

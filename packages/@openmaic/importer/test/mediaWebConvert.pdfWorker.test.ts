import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: { workerSrc: '' },
  destroy: vi.fn(async () => undefined),
  render: vi.fn(() => ({ promise: Promise.resolve() })),
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  version: '4.8.69', GlobalWorkerOptions: mocks.options, getDocument: mocks.getDocument,
}));
vi.mock('../src/utils/emfParser', () => ({ parseEmfContent: () => ({ type: 'pdf', data: new Uint8Array([1, 2, 3]) }) }));

afterEach(() => vi.unstubAllGlobals());

it('uses the configured worker when converting an embedded PDF image', async () => {
  const { configurePdfWorker, encodeMediaForWebDisplay } = await import('../src/utils/mediaWebConvert');
  expect(mocks.options.workerSrc).toBe('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/legacy/build/pdf.worker.min.mjs');
  configurePdfWorker('/vendor/pdfjs/pdf.worker.legacy.min.mjs');
  mocks.getDocument.mockImplementation(() => {
    expect(mocks.options.workerSrc).toBe('/vendor/pdfjs/pdf.worker.legacy.min.mjs');
    return { promise: Promise.resolve({
      getPage: async () => ({ getViewport: () => ({ width: 100, height: 50 }), render: mocks.render }),
      destroy: mocks.destroy,
    }) };
  });
  vi.stubGlobal('document', { createElement: () => ({
    getContext: () => ({ fillRect() {}, fillStyle: '' }),
    toDataURL: () => 'data:image/png;base64,converted',
  }) });
  expect(await encodeMediaForWebDisplay('image.emf', new Uint8Array())).toBe('data:image/png;base64,converted');
  expect(mocks.getDocument).toHaveBeenCalledOnce();
  expect(mocks.render).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

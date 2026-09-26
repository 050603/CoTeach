import { expect, test } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";

test("PDF renders with a real worker when newer Promise and typed-array APIs are unavailable", async ({ page }) => {
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([400, 300]);
  sheet.drawText("DESKTOP PDF COMPATIBILITY", { x: 20, y: 250, size: 16 });
  sheet.drawRectangle({ x: 40, y: 40, width: 120, height: 100, color: rgb(1, 0, 0) });
  const bytes = Array.from(await pdf.save());
  const removeNewApis = `
    delete Promise.withResolvers;
    delete Uint8Array.fromBase64;
    delete Uint8Array.prototype.toBase64;
    delete Uint8Array.prototype.toHex;
  `;
  await page.addInitScript(removeNewApis);
  // Workers have their own globals; removing only the window API can hide a
  // missing polyfill in the separately deployed worker bundle.
  await page.route("**/vendor/pdfjs/pdf.worker.legacy.min.mjs", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${removeNewApis}\n${await response.text()}` });
  });
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto("/");
  const result = await page.evaluate(async (data) => {
    const missingBeforeLoad = typeof Promise.withResolvers === "undefined";
    const moduleUrl = "/vendor/pdfjs/pdf.legacy.min.mjs";
    const pdfjs = await import(/* webpackIgnore: true */ moduleUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.legacy.min.mjs";
    const document = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    try {
      const firstPage = await document.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      const canvas = window.document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d")!;
      await firstPage.render({ canvasContext: context, viewport }).promise;
      const content = await firstPage.getTextContent();
      return {
        missingBeforeLoad,
        pages: document.numPages,
        text: content.items.map((item: { str?: string }) => item.str || "").join(" "),
        pixel: Array.from(context.getImageData(80, 200, 1, 1).data),
      };
    } finally {
      await document.destroy();
    }
  }, bytes);
  expect(result.missingBeforeLoad).toBe(true);
  expect(result.pages).toBe(1);
  expect(result.text).toContain("DESKTOP PDF COMPATIBILITY");
  expect(result.pixel).toEqual([255, 0, 0, 255]);
  expect(workers.some((url) => url.endsWith("/pdf.worker.legacy.min.mjs"))).toBe(true);
});

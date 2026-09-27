import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { buildProjectDocumentDocx, prepareProjectDocumentHtml } from "./document-archive";

vi.mock("./document-conversion-pool", async () => {
  const { convertDocument } = await import("./document-conversion-engine");
  return { convertDocumentInWorker: convertDocument, initializeDocumentConversionPool: vi.fn() };
});
const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3pWQAAAABJRU5ErkJggg==";

describe("project practice document archive", () => {
  it("sanitizes document markup before archiving", async () => {
    const prepared = await prepareProjectDocumentHtml({
      courseId: "course-1",
      studentId: "student-1",
      html: '<h2 style="color: red; position: fixed">方案</h2><script>alert(1)</script><p>先观察</p>',
    });
    expect(prepared.html).toContain("<h2 style=\"color: red\">方案</h2>");
    expect(prepared.html).not.toContain("script");
  });

  it("rejects external image URLs so the Word file is self-contained", async () => {
    await expect(prepareProjectDocumentHtml({
      courseId: "course-1",
      studentId: "student-1",
      html: '<p>正文</p><img src="https://example.com/image.png" />',
    })).rejects.toMatchObject({ code: "EXTERNAL_IMAGE" });
  });

  it("packages embedded document images into the immutable Word archive", async () => {
    const archive = await buildProjectDocumentDocx({
      courseId: "course-1",
      studentId: "student-1",
      title: "项目成果",
      html: `<h1>项目成果</h1><figure><img src="${ONE_PIXEL_PNG}" alt="测试图"></figure><p>结论</p>`,
    });
    const zip = await JSZip.loadAsync(archive.bytes);
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name].dir);
    const relationships = await zip.file("word/_rels/document.xml.rels")?.async("text");

    expect(archive.imageCount).toBe(1);
    expect(mediaFiles.length).toBeGreaterThanOrEqual(1);
    expect(relationships).toContain("media/");
  });
});

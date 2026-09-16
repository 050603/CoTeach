import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCourseQualityLabServer, parseCliOptions } from "./server";
import type { CourseQualityLabManifest, LabVariantResult } from "./types";

const COMPLETE = { state: "complete" as const };

function variant(prefix: string): LabVariantResult {
  return {
    statuses: { ppt: COMPLETE, script: COMPLETE, tts: COMPLETE },
    slides: [{
      id: `${prefix}-slide-1`,
      title: "概念解释",
      imageUrl: `/files/artifacts/pair-1/${prefix}/slides/slide-1.png`,
      renderUrl: `/render/section-1/1/${prefix}/0`,
    }],
    script: [{
      id: `${prefix}-segment-1`,
      slideIndex: 0,
      text: "先解释原因，再检查理解。",
      audioUrl: `/files/audio/pair-1/${prefix}/segment-1.mp3`,
    }],
    quiz: [],
    downloads: {
      pptx: `/files/artifacts/pair-1/${prefix}/course.pptx`,
      script: `/files/artifacts/pair-1/${prefix}/script.txt`,
    },
  };
}

function manifest(): CourseQualityLabManifest {
  return {
    version: 1,
    title: "课程质量实验",
    ttsConfig: { provider: "test", voice: "same" },
    sections: [{
      id: "section-1",
      title: "功率与电能",
      learningObjectives: ["解释功率和电能的关系"],
      sources: [],
      pairs: [{
        id: "pair-1",
        batch: 1,
        variants: { baseline: variant("baseline"), enhanced: variant("enhanced") },
      }],
    }],
  };
}

describe("course quality lab server", () => {
  let workspace: string;
  let rootDir: string;
  let buildDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "course-quality-lab-test-"));
    rootDir = path.join(workspace, "runtime");
    buildDir = path.join(workspace, "build");
    await mkdir(buildDir, { recursive: true });
    await mkdir(path.join(buildDir, "_next", "static", "media"), { recursive: true });
    await writeFile(path.join(buildDir, "index.html"), "<main>lab client</main>");
    await writeFile(path.join(buildDir, "slide-frame.js"), "document.documentElement.dataset.frame='ready'");
    await writeFile(path.join(buildDir, "_next", "static", "media", "formula.woff2"), "standalone-font");
    const value = manifest() as CourseQualityLabManifest & { apiKey?: string };
    value.apiKey = "must-not-leak";
    await mkdir(rootDir, { recursive: true });
    await writeFile(path.join(rootDir, "manifest.json"), JSON.stringify(value));
    for (const variantKey of ["baseline", "enhanced"]) {
      const artifactDir = path.join(rootDir, "artifacts", "pair-1", variantKey);
      await mkdir(path.join(artifactDir, "slides"), { recursive: true });
      await mkdir(path.join(rootDir, "audio", "pair-1", variantKey), { recursive: true });
      await writeFile(path.join(artifactDir, "slides", "slide-1.png"), "fake-png");
      await writeFile(path.join(artifactDir, "course.pptx"), "fake-pptx");
      await writeFile(path.join(artifactDir, "script.txt"), `script-${variantKey}`);
      await writeFile(path.join(rootDir, "audio", "pair-1", variantKey, "segment-1.mp3"), "0123456789");
    }
    server = createCourseQualityLabServer({ rootDir, buildDir, logger: { info() {}, error() {} } });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  });

  it("listens on all interfaces by default and allows an explicit host override", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    expect(parseCliOptions([], env)).toMatchObject({ host: "0.0.0.0", port: 3010 });
    expect(parseCliOptions(["--host", "127.0.0.1", "--port", "4010"], env)).toMatchObject({
      host: "127.0.0.1",
      port: 4010,
    });
  });

  it("serves health, a redacted manifest and the standalone client", async () => {
    const health = await fetch(`${baseUrl}/api/health/live`);
    expect(await health.json()).toEqual({ status: "ok", service: "course-quality-lab" });

    const manifestResponse = await fetch(`${baseUrl}/api/manifest`);
    const publicManifest = await manifestResponse.json() as Record<string, unknown>;
    expect(manifestResponse.headers.get("cache-control")).toBe("no-store");
    expect(publicManifest.apiKey).toBe("[redacted]");

    const client = await fetch(`${baseUrl}/some/client/route`);
    expect(await client.text()).toContain("lab client");

    const rendererFont = await fetch(`${baseUrl}/_next/static/media/formula.woff2`);
    expect(rendererFont.status).toBe(200);
    expect(await rendererFont.text()).toBe("standalone-font");
  });

  it("atomically creates and updates reviews and exports JSON and safe CSV", async () => {
    expect(await (await fetch(`${baseUrl}/api/reviews`)).json()).toEqual({ reviews: [] });
    const input = {
      pairId: "pair-1",
      outcome: "enhanced",
      dimensions: { explanationDepth: 5, listeningExperience: 4 },
      pageNotes: { "0": "=公式应保持为文本" },
      overallNote: "=增强版解释更完整",
    };
    const save = await fetch(`${baseUrl}/api/reviews/pair-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(save.status).toBe(200);
    expect((await save.json() as { review: { updatedAt?: string } }).review.updatedAt).toBeTruthy();

    const saved = JSON.parse(await readFile(path.join(rootDir, "reviews.json"), "utf8"));
    expect(saved.reviews).toHaveLength(1);
    expect(saved.reviews[0].outcome).toBe("enhanced");

    const csv = await (await fetch(`${baseUrl}/api/exports/reviews.csv`)).text();
    expect(csv).toContain('"pair-1","enhanced"');
    expect(csv).toContain("'=增强版解释更完整");
    const json = await fetch(`${baseUrl}/api/exports/reviews.json`);
    expect(json.headers.get("content-disposition")).toContain("course-quality-reviews.json");
  });

  it("rejects invalid and unknown reviews without changing storage", async () => {
    const invalid = await fetch(`${baseUrl}/api/reviews/pair-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairId: "pair-1", outcome: "enhanced", dimensions: { examples: 9 }, pageNotes: {} }),
    });
    expect(invalid.status).toBe(400);
    const unknown = await fetch(`${baseUrl}/api/reviews/unknown`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "undecided", dimensions: {}, pageNotes: {} }),
    });
    expect(unknown.status).toBe(404);
    expect(await (await fetch(`${baseUrl}/api/reviews`)).json()).toEqual({ reviews: [] });
  });

  it("serves runtime files with byte ranges and blocks traversal and escaping symlinks", async () => {
    const audio = await fetch(`${baseUrl}/files/audio/pair-1/baseline/segment-1.mp3`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(audio.status).toBe(206);
    expect(audio.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await audio.text()).toBe("2345");

    const traversalStatus = await rawStatus(server, "/files/artifacts/%2e%2e/manifest.json");
    expect([400, 404]).toContain(traversalStatus);

    const outside = path.join(workspace, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(rootDir, "artifacts", "escape.txt"));
    expect((await fetch(`${baseUrl}/files/artifacts/escape.txt`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/files/reviews.json`)).status).toBe(404);
  });

  it("renders an isolated slide frame and downloads script, pptx and an audio zip", async () => {
    const frame = await fetch(`${baseUrl}/render/section-1/1/baseline/0`);
    expect(frame.status).toBe(200);
    const frameHtml = await frame.text();
    expect(frameHtml).toContain('/files/artifacts/pair-1/baseline/slides/slide-1.png');
    expect(frameHtml).toContain('<script type="module" src="/slide-frame.js"></script>');

    const script = await fetch(`${baseUrl}/api/download/pair-1/baseline/script`);
    expect(await script.text()).toBe("script-baseline");
    expect(script.headers.get("content-disposition")).toContain("attachment");
    const pptx = await fetch(`${baseUrl}/api/download/pair-1/enhanced/pptx`);
    expect(pptx.status).toBe(200);
    expect(await pptx.text()).toBe("fake-pptx");

    const audio = await fetch(`${baseUrl}/api/download/pair-1/baseline/audio.zip`);
    expect(audio.status).toBe(200);
    const zip = await JSZip.loadAsync(await audio.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(["001-baseline-segment-1.mp3"]);
    expect(await zip.file("001-baseline-segment-1.mp3")?.async("text")).toBe("0123456789");
  });
});

async function rawStatus(server: Server, requestPath: string): Promise<number> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "GET",
      path: requestPath,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

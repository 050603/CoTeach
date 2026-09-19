import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCourseQualityLabServer,
  parseCliOptions,
  withRuntimeMetrics,
  type CourseQualityLabServerOptions,
} from "./server";
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
    ...(prefix === "enhanced" ? {
      teacherReviewNotes: [{
        id: "review-note-1",
        page: 1,
        claim: "示例中的具体年份",
        reason: "现有资料没有提供该年份",
        suggestion: "教师核对原始资料或删除年份",
        origin: "design" as const,
      }],
    } : {}),
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
        experimentId: "experiment-v3",
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
  let startGenerationRetry: NonNullable<CourseQualityLabServerOptions["startGenerationRetry"]>;

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
    startGenerationRetry = vi.fn(async () => ({ pid: 1234 }));
    server = createCourseQualityLabServer({
      rootDir,
      buildDir,
      logger: { info() {}, error() {} },
      startGenerationRetry,
    });
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

  it("starts a new technical recovery round only for a failed variant", async () => {
    const value = manifest();
    value.sections[0]!.pairs[0]!.variants.enhanced.technicalValidation = {
      policyVersion: "technical-generation-v1",
      state: "failed",
      stage: "tts",
      message: "audio failed",
    };
    value.sections[0]!.pairs[0]!.variants.enhanced.statuses.tts = { state: "failed" };
    await writeFile(path.join(rootDir, "manifest.json"), JSON.stringify(value));

    const started = await fetch(`${baseUrl}/api/generation/retry/pair-1/enhanced`, { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ status: "started", pid: 1234 });
    expect(startGenerationRetry).toHaveBeenCalledWith(expect.objectContaining({
      rootDir,
      sectionId: "section-1",
      variant: "enhanced",
    }));

    const notFailed = await fetch(`${baseUrl}/api/generation/retry/pair-1/baseline`, { method: "POST" });
    expect(notFailed.status).toBe(409);
    expect(startGenerationRetry).toHaveBeenCalledTimes(1);
  });

  it("adds token, latency, call and failure metrics from private runtime logs", async () => {
    const value = manifest();
    value.sections[0].pairs[0].variants.enhanced.pipelineVersion = "v5";
    value.sections[0].pairs[0].variants.enhanced.artifactBaseUrl = "/files/artifacts/experiment/section-1/1/enhanced";
    const runDir = path.join(rootDir, "runs", "experiment", "section-1", "1", "enhanced");
    const designDir = path.join(rootDir, "designs", "experiment", "section-1", "1", "v5");
    await mkdir(runDir, { recursive: true });
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(runDir, "calls.json"), JSON.stringify([
      { status: "complete", kind: "slide", module: "slide", elapsedMs: 1_200, systemChars: 1_000, userChars: 500, outputChars: 250, tokenUsage: 640, tokenUsageSource: "provider",
        attempts: [{ status: "failed", startedAt: "2026-01-01T00:00:01.000Z" }, { status: "complete", startedAt: "2026-01-01T00:00:02.000Z" }] },
      { status: "failed", kind: "repair", module: "repair", elapsedMs: 800, systemChars: 100, userChars: 50,
        attempts: [{ status: "failed", startedAt: "2026-01-01T00:00:03.000Z" }] },
    ]));
    await writeFile(path.join(designDir, "calls.json"), JSON.stringify([
      { status: "complete", kind: "design", module: "planning", elapsedMs: 500, systemChars: 250, userChars: 250, outputChars: 100, tokenUsageSource: "estimated",
        attempts: [{ status: "complete", startedAt: "2026-01-01T00:00:00.000Z" }] },
    ]));
    await writeFile(path.join(runDir, "tts-calls.json"), JSON.stringify([
      { status: "complete", elapsedMs: 300, cacheHit: true, audioBytes: 4_096 },
      { status: "failed", elapsedMs: 200, cacheHit: false },
    ]));
    await writeFile(path.join(runDir, "telemetry.json"), JSON.stringify({
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:10.000Z",
      checkpointReuses: 2,
      qualityRepairCalls: 1,
      firstPassPages: 1,
      evaluatedPages: 2,
      deterministicAdjustments: 1,
      pipelineVersion: "v5.0.0",
      artifactVersions: { planning: "plan-v2", narration: "narration-v1" },
      repairEvents: [{
        module: "narration",
        scope: "segment",
        reason: "讲解缺少因果过渡 sk-secretvalue123456",
        targetIds: ["segment-1"],
        outcome: "resolved",
        attempt: 2,
        prompt: "must-not-leak",
      }],
    }));

    const enriched = await withRuntimeMetrics(rootDir, value);
    expect(value.sections[0].pairs[0].variants.enhanced.metrics).toBeUndefined();
    expect(enriched.sections[0].pairs[0].variants.enhanced.metrics).toMatchObject({
      tokenUsage: 940,
      tokenUsageSource: "mixed",
      tokenUsageEstimated: true,
      inputCharacters: 2_150,
      outputCharacters: 350,
      modelCalls: 3,
      failedModelCalls: 1,
      transportAttempts: 4,
      transportRetries: 1,
      transportAttemptsRecorded: true,
      qualityRepairCalls: 1,
      firstPassPages: 1,
      evaluatedPages: 2,
      deterministicAdjustments: 1,
      abandonedModelCalls: 0,
      checkpointReuses: 2,
      telemetryRecorded: true,
      wallClockMs: 10_000,
      modelElapsedMs: 2_500,
      designCalls: 1,
      generationCalls: 2,
      ttsCalls: 2,
      failedTtsCalls: 1,
      ttsElapsedMs: 500,
      ttsCacheHits: 1,
      audioBytes: 4_096,
      pipelineVersion: "v5.0.0",
      artifactVersions: { planning: "plan-v2", narration: "narration-v1" },
    });
    const metrics = enriched.sections[0].pairs[0].variants.enhanced.metrics;
    expect(metrics?.moduleMetrics?.slide).toMatchObject({
      tokenUsage: 640,
      tokenUsageSource: "provider-reported",
      calls: 1,
      transportAttempts: 2,
      transportRetries: 1,
    });
    expect(metrics?.moduleMetrics?.planning).toMatchObject({ tokenUsage: 240, tokenUsageSource: "estimated" });
    expect(metrics?.moduleMetrics?.repair).toMatchObject({ tokenUsage: 60, tokenUsageSource: "unknown" });
    expect(metrics?.moduleMetrics?.tts).toMatchObject({ calls: 2, failedCalls: 1, elapsedMs: 500 });
    expect(metrics?.repairEvents).toEqual([{
      module: "narration",
      scope: "segment",
      reason: "讲解缺少因果过渡 [redacted]",
      targetIds: ["segment-1"],
      outcome: "resolved",
      attempt: 2,
    }]);
    expect(JSON.stringify(metrics)).not.toContain("must-not-leak");
  });

  it("keeps archived token logs explicitly unknown even when they contain a numeric total", async () => {
    const value = manifest();
    value.sections[0].pairs[0].variants.baseline.artifactBaseUrl = "/files/artifacts/archive/section-1/1/baseline";
    const runDir = path.join(rootDir, "runs", "archive", "section-1", "1", "baseline");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "calls.json"), JSON.stringify([{
      status: "complete",
      kind: "slide",
      elapsedMs: 100,
      systemChars: 100,
      userChars: 100,
      outputChars: 50,
      tokenUsage: 77,
    }]));

    const enriched = await withRuntimeMetrics(rootDir, value);
    expect(enriched.sections[0].pairs[0].variants.baseline.metrics).toMatchObject({
      tokenUsage: 77,
      tokenUsageSource: "unknown",
      tokenUsageEstimated: true,
    });
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

    const teacherReviewSave = await fetch(`${baseUrl}/api/reviews/pair-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        teacherReviews: {
          enhanced: {
            experimentId: "experiment-v3",
            variant: "enhanced",
            notes: { "review-note-1": { status: "confirmed", note: "已核对校志" } },
          },
        },
      }),
    });
    expect(teacherReviewSave.status).toBe(200);
    const teacherReviewSaved = JSON.parse(await readFile(path.join(rootDir, "reviews.json"), "utf8"));
    expect(teacherReviewSaved.reviews[0].teacherReviews.enhanced.notes["review-note-1"]).toEqual({
      status: "confirmed",
      note: "已核对校志",
    });

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
    const mismatchedTeacherReview = await fetch(`${baseUrl}/api/reviews/pair-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "undecided",
        dimensions: {},
        pageNotes: {},
        teacherReviews: {
          enhanced: {
            experimentId: "old-experiment",
            variant: "enhanced",
            notes: { "review-note-1": { status: "confirmed" } },
          },
        },
      }),
    });
    expect(mismatchedTeacherReview.status).toBe(400);
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
    const pairFrame = await fetch(`${baseUrl}/render-pair/pair-1/enhanced/0`);
    expect(pairFrame.status).toBe(200);
    expect(await pairFrame.text()).toContain('/files/artifacts/pair-1/enhanced/slides/slide-1.png');

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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.PROJECTION_BASE_URL ?? "http://127.0.0.1:3000";
const courseId = required("PROJECTION_COURSE_ID");
const teacherStorageState = required("PROJECTION_TEACHER_STORAGE_STATE");
const studentStorageDirectory = required("PROJECTION_STUDENT_STORAGE_DIR");
const studentCount = positiveInteger("PROJECTION_STUDENT_COUNT", 30);
const durationSeconds = positiveInteger("PROJECTION_DURATION_SECONDS", 1_800);
const operationIntervalMs = positiveInteger("PROJECTION_OPERATION_INTERVAL_MS", 1_200);
const latencyTargetMs = positiveInteger("PROJECTION_LATENCY_TARGET_MS", 1_000);
const outputPath = path.resolve(
  process.env.PROJECTION_REPORT_PATH ?? "tests/load/reports/projection-sync-report.json",
);
const blockWebSocket = process.env.PROJECTION_BLOCK_WEBSOCKET === "true";
const metricsToken = process.env.PROJECTION_METRICS_TOKEN;

const studentStates = (await readdir(studentStorageDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .slice(0, studentCount)
  .map((name) => path.join(studentStorageDirectory, name));
assert.equal(
  studentStates.length,
  studentCount,
  `Expected ${studentCount} student storage-state files in ${studentStorageDirectory}`,
);

const browser = await chromium.launch({ headless: true });
const contexts = [];
const samples = [];
const failures = [];
let teacherContext;
let metricsBefore;
let metricsAfter;

try {
  teacherContext = await browser.newContext({ storageState: teacherStorageState });
  const teacherPage = await teacherContext.newPage();
  const stateResponse = await teacherContext.request.get(
    `${baseUrl}/api/courses/${encodeURIComponent(courseId)}/state`,
    { headers: { "X-OpenPBL-Role": "teacher" } },
  );
  assert.ok(stateResponse.ok(), `Teacher cannot read course state (${stateResponse.status()})`);
  const { course } = await stateResponse.json();
  const resourceId = process.env.PROJECTION_RESOURCE_ID
    ?? course.resources?.find((item) => ["pdf", "video"].includes(String(item.type).toLowerCase()))?.id
    ?? course.resources?.[0]?.id;
  const resource = course.resources?.find((item) => item.id === resourceId);
  assert.ok(resource, "The classroom needs at least one uploaded PDF/PPT/video resource");
  const stageKey = process.env.PROJECTION_STAGE_KEY
    ?? course.stages?.[course.currentStageIndex]?.key;
  assert.ok(stageKey, "The classroom has no active stage");
  const resourceType = String(resource.previewType ?? resource.type).toLowerCase();
  const isVideo = ["video", "mp4", "mov", "webm"].includes(resourceType)
    || /video\//i.test(String(resource.fileType ?? ""));

  const identities = new Set();
  for (const storageState of studentStates) {
    const context = await browser.newContext({ storageState });
    contexts.push(context);
    if (blockWebSocket) {
      await context.routeWebSocket(/.*/, (socket) => socket.close());
    }
    const identity = await context.request.get(`${baseUrl}/api/auth/me`, {
      headers: { "X-OpenPBL-Role": "student" },
    });
    assert.ok(identity.ok(), `Invalid student session: ${storageState}`);
    const identityBody = await identity.json();
    const identityKey = identityBody.user?.id ?? identityBody.user?.username;
    assert.ok(identityKey, `Student identity missing from ${storageState}`);
    assert.ok(!identities.has(identityKey), `Duplicate student identity: ${identityKey}`);
    identities.add(identityKey);
  }

  const pages = await Promise.all(contexts.map(async (context, index) => {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push({ student: index + 1, kind: "page-error", message: error.message }));
    const response = await page.goto(
      `${baseUrl}/student/classroom/${encodeURIComponent(courseId)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    assert.ok(response?.ok(), `Student ${index + 1} classroom failed (${response?.status()})`);
    await page.locator("[data-course-projection-version]").waitFor({ state: "attached", timeout: 30_000 });
    return page;
  }));

  metricsBefore = await readMetrics(teacherContext);
  let revision = 0;
  let mediaPlaying = false;
  let mediaDuration = null;
  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1_000;

  // Warm the resource on every student before timed samples begin.
  const warmup = await sendProjection({
    page: 1,
    scrollRatio: 0,
    mediaTime: 0,
    mediaPlaying: false,
    mediaPlaybackRate: 1,
  });
  await waitForVersion(pages, warmup.projection.projectionVersion, Date.now(), 30_000, false);
  if (isVideo) {
    const durations = await Promise.all(pages.map(async (page) => {
      await page.locator('[data-teacher-resource-projection] video').waitFor({ state: "attached", timeout: 30_000 });
      await page.waitForFunction(() => {
        const video = document.querySelector('[data-teacher-resource-projection] video');
        return video instanceof HTMLVideoElement && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      }, undefined, { timeout: 30_000 });
      return page.locator('[data-teacher-resource-projection] video').evaluate((video) => video.duration);
    }));
    mediaDuration = Math.min(...durations.filter((duration) => Number.isFinite(duration) && duration > 0));
    assert.ok(Number.isFinite(mediaDuration), "The projected video has no finite playable duration");
  }

  while (Date.now() < deadline) {
    revision += 1;
    mediaPlaying = isVideo ? !mediaPlaying : false;
    const seekSpan = mediaDuration === null ? null : Math.max(0.5, mediaDuration - 2);
    const operationStartedAt = Date.now();
    const ack = await sendProjection({
      page: revision % 10 + 1,
      scrollRatio: (revision % 20) / 20,
      // Keep long-running checks away from the media end so an intentional
      // seek never looks like a failed play synchronization.
      mediaTime: seekSpan === null ? revision * 2 : revision * 2 % seekSpan,
      mediaPlaying,
      mediaPlaybackRate: revision % 4 === 0 ? 1.25 : 1,
    });
    const version = ack.projection.projectionVersion;
    await waitForVersion(
      pages,
      version,
      operationStartedAt,
      latencyTargetMs,
      true,
      isVideo ? { mediaPlaying } : undefined,
    );
    const remaining = operationIntervalMs - (Date.now() - operationStartedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  const stopStartedAt = Date.now();
  const stop = await postAction({ resourceProjection: null });
  await waitForVersion(
    pages,
    stop.projection.projectionVersion,
    stopStartedAt,
    latencyTargetMs,
    true,
    { projectionClosed: true },
  );
  metricsAfter = await readMetrics(teacherContext);

  async function sendProjection(viewState) {
    return postAction({
      resourceProjection: {
        resourceId: resource.id,
        stageKey,
        title: resource.title,
        startedAt: new Date().toISOString(),
        viewState: {
          ...viewState,
          updatedAt: new Date().toISOString(),
          revision: Date.now(),
        },
      },
    });
  }

  async function postAction(patch) {
    const response = await teacherPage.request.post(
      `${baseUrl}/api/courses/${encodeURIComponent(courseId)}/actions`,
      {
        headers: {
          Origin: new URL(baseUrl).origin,
          "X-OpenPBL-Role": "teacher",
        },
        data: {
          requestId: randomUUID(),
          action: { type: "SET_UI_STATE", payload: { courseId, patch } },
        },
      },
    );
    const body = await response.json().catch(() => ({}));
    assert.ok(response.ok(), `Projection action failed (${response.status()}): ${JSON.stringify(body)}`);
    assert.ok(body.projection, "Projection action response did not include its committed snapshot");
    return body;
  }
} finally {
  metricsAfter ??= teacherContext ? await readMetrics(teacherContext).catch(() => null) : null;
  await Promise.all(contexts.map((context) => context.close()));
  await teacherContext?.close();
  await browser.close();
}

const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
const report = {
  generatedAt: new Date().toISOString(),
  config: {
    baseUrl,
    courseId,
    studentCount,
    durationSeconds,
    operationIntervalMs,
    latencyTargetMs,
    blockWebSocket,
  },
  summary: {
    sampleCount: samples.length,
    missCount: failures.filter((failure) => failure.kind === "latency-timeout").length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? null,
    passed: failures.length === 0 && latencies.every((value) => value <= latencyTargetMs),
  },
  perStudent: Array.from({ length: studentCount }, (_, index) => {
    const values = samples.filter((sample) => sample.student === index + 1).map((sample) => sample.latencyMs).sort((a, b) => a - b);
    return { student: index + 1, samples: values.length, p95Ms: percentile(values, 0.95), maxMs: values.at(-1) ?? null };
  }),
  failures,
  metricsBefore,
  metricsAfter,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));
console.log(`Projection synchronization report: ${outputPath}`);
if (!report.summary.passed) process.exitCode = 1;

async function waitForVersion(pages, version, operationStartedAt, timeoutMs, record, expected = {}) {
  await Promise.all(pages.map(async (page, index) => {
    const remaining = Math.max(1, timeoutMs - (Date.now() - operationStartedAt));
    try {
      await page.waitForFunction(
        ({ version: expectedVersion, mediaPlaying, projectionClosed }) => {
          const appliedVersion = Number(document.querySelector("[data-course-projection-version]")?.getAttribute("data-course-projection-version"));
          if (appliedVersion < expectedVersion) return false;
          const projection = document.querySelector("[data-teacher-resource-projection]");
          if (projectionClosed) return !projection;
          if (mediaPlaying === undefined) return true;
          const video = projection?.querySelector("video");
          return video instanceof HTMLVideoElement
            && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && video.paused !== mediaPlaying;
        },
        { version, ...expected },
        { timeout: remaining },
      );
      if (record) samples.push({ student: index + 1, version, latencyMs: Date.now() - operationStartedAt });
    } catch (error) {
      failures.push({ student: index + 1, version, kind: "latency-timeout", latencyMs: Date.now() - operationStartedAt, message: error.message });
    }
  }));
}

async function readMetrics(context) {
  if (!metricsToken) return null;
  const response = await context.request.get(`${baseUrl}/api/metrics`, {
    headers: { Authorization: `Bearer ${metricsToken}` },
  });
  if (!response.ok()) return { status: response.status() };
  const text = await response.text();
  return text.split("\n").filter((line) => /^(process_|nodejs_|http_request_duration_seconds|http_requests_total)/.test(line));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

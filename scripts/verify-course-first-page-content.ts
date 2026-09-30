/** Opt-in single-page production authoring probe; never generates narration or quizzes. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GenerateClassroomInput, GenerateClassroomOptions } from "../src/lib/openmaic/server/classroom-generation";
import type { SceneOutline, GeneratedSlideContent } from "../src/lib/openmaic/types/generation";
import type { Course } from "../src/lib/session/types";
import { writeJsonAtomic } from "../tools/course-quality-lab/storage";
import { freezeCode, initializeReadOnlyClients, disconnect } from "./verify-course-first-pass-cost";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
function arg(key: string) { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; }
function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
async function json<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, "[redacted-url]@");
}
type Probe = {
  requestId: string; createdAt: string; outlineId: string; sourcePagesRun: string; sourceDesignRun: string;
  code: Awaited<ReturnType<typeof freezeCode>>; inputSha256: string; outlinesSha256: string;
  replayRawFrom?: string;
  status: "prepared" | "running" | "passed" | "failed";
};
type ProbeInput = GenerateClassroomInput & { courseId: string };
function runtimePath(value: string): string {
  const resolved = path.resolve(repository, value);
  if (!resolved.startsWith(path.join(repository, ".openpbl-runtime") + path.sep)) {
    throw new Error("探针输出及重放输入必须位于 .openpbl-runtime 隔离目录");
  }
  return resolved;
}

async function worker(output: string) {
  const probe = await json<Probe>(path.join(output, "probe.json"));
  if (probe.status !== "running") throw new Error("仅运行已登记的新请求身份，不自动恢复或重发");
  const load = (module: string) => import(pathToFileURL(path.join(probe.code.directory, module)).href);
  const save = (name: string, data: unknown) => writeJsonAtomic(path.join(output, name), data);
  const observer = await import(pathToFileURL(probe.code.instrumentationModule!).href);
  observer.setVerificationInstrumentationDirectory(output);
  const input = await json<ProbeInput>(path.join(output, "page-input.json"));
  const preparedOutlines = await json<SceneOutline[]>(path.join(output, "prepared-outlines.json"));
  const original = preparedOutlines.find((outline) => outline.id === probe.outlineId)!;
  const continuation = await json<{ course: Course; validation: { passed: boolean; modelCalls: number; issues: string[] } }>(
    path.join(probe.sourceDesignRun, "continuation-input.json"));
  const parentManifest = await json<{ fixtures: Array<{ id: string; request: { textbookEvidence?: unknown }; policy: { modelString: string } }> }>(
    path.join(probe.sourcePagesRun, "../../manifest.json"));
  const fixture = parentManifest.fixtures.find((item) => item.policy.modelString === input.generationModelString
    && item.id === "teaching-theory");
  if (!fixture || !continuation.validation.passed || continuation.validation.modelCalls !== 0
    || continuation.validation.issues.length || continuation.course.id !== input.courseId) throw new Error("缺少同课程已验收设计输入");
  if (sha(JSON.stringify(input)) !== probe.inputSha256 || sha(JSON.stringify(preparedOutlines)) !== probe.outlinesSha256) {
    throw new Error("冻结页面输入在付费前发生变化");
  }
  process.env.CLASSROOM_DATA_DIR = path.join(output, "classrooms");
  process.env.OPENPBL_DATA_DIR = path.join(output, "store");
  await initializeReadOnlyClients();
  let accepted = false;
  let rawText: string | undefined;
  let content: GeneratedSlideContent | undefined;
  let intentionalStopReached = false;
  let authoredOutline = original;
  const stopped = new Error("Verification stopped after the selected accepted content checkpoint");
  let generationError: string | undefined;
  const issues: string[] = [];
  const replay = probe.replayRawFrom ? await json<{
    outline: SceneOutline; stage: string; text: string; complete?: boolean; modelFingerprint: string; inputFingerprint: string;
  }>(path.join(probe.replayRawFrom, "raw-content.json")) : undefined;
  if (replay) {
    if (replay.outline.id !== probe.outlineId || replay.stage !== "content" || replay.complete === false
      || sha(JSON.stringify(await json<ProbeInput>(path.join(probe.replayRawFrom!, "page-input.json")))) !== probe.inputSha256
      || sha(JSON.stringify(await json<SceneOutline[]>(path.join(probe.replayRawFrom!, "prepared-outlines.json")))) !== probe.outlinesSha256) {
      throw new Error("零调用重放仅允许同完整首稿、同原页面输入和完整大纲");
    }
    rawText = replay.text;
    await save("replayed-original-raw.json", { sourceProbe: probe.replayRawFrom, rawSha256: sha(replay.text), ...replay });
  }
  try {
    const provider = await load("src/lib/openmaic/server/provider-config.ts");
    await provider.initializeServerProviderConfig();
    const evidence = await load("src/lib/textbook/course-evidence-types.ts");
    const sourceSequenceContracts = evidence.resolveCourseSourceSequenceContracts(fixture.request.textbookEvidence,
      continuation.course.content.knowledgePoints);
    const classroom = await load("src/lib/openmaic/server/classroom-generation.ts");
    const options: GenerateClassroomOptions = {
      generationOutlineIds: [probe.outlineId], preparedOutlines,
      sourceEvidence: fixture.request.textbookEvidence as GenerateClassroomOptions["sourceEvidence"],
      sourceKnowledgePoints: continuation.course.content.knowledgePoints, sourceSequenceContracts,
      onAuxiliaryAuthoringAttempt: () => { throw new Error("仅第一页 content 探针禁止辅助作者调用"); },
      onSceneStageAttempt: async (outline, stage, attemptsStarted, modelFingerprint, inputFingerprint) => {
        if (replay) throw new Error("零调用重放禁止任何作者请求");
        if (outline.id !== probe.outlineId || stage !== "content") throw new Error("探针禁止其它页面、讲稿和测验调用");
        await save(`attempt-${attemptsStarted}.json`, { requestId: probe.requestId, outlineId: outline.id, stage,
          attemptsStarted, modelFingerprint, inputFingerprint });
      },
      ...(replay ? {
        loadSceneStageAttemptCount: () => 1,
        loadStageAuthoringResponse: (outline: SceneOutline, stage: string, modelFingerprint: string, inputFingerprint: string) => {
          if (outline.id !== replay.outline.id || stage !== replay.stage) return null;
          if (modelFingerprint !== replay.modelFingerprint || inputFingerprint !== replay.inputFingerprint) {
            throw new Error("原始首稿与当前生产请求身份不匹配，不自动重发或越过身份检查");
          }
          return { text: replay.text, complete: replay.complete };
        },
      } : {}),
      onOutlinesPrepared: (outlines) => save("production-prepared-outlines.json", outlines),
      onAuthoringResponse: (response) => save("raw-shared-observer.json", response),
      onStageAuthoringResponse: async (response) => {
        rawText = response.text;
        authoredOutline = response.outline;
        await save("raw-content.json", { requestId: probe.requestId, ...response });
      },
      onStageAuthoringValidated: async (result) => {
        accepted = result.accepted;
        await save("content-acceptance.json", result);
      },
      onSceneStageCompleted: async (outline, stage, payload, modelFingerprint, inputFingerprint) => {
        if (outline.id !== probe.outlineId || stage !== "content") throw new Error("探针出现范围外检查点");
        content = (payload as { content: GeneratedSlideContent }).content;
        await save("accepted-content-checkpoint.json", { requestId: probe.requestId, outline, stage, payload,
          modelFingerprint, inputFingerprint });
        // This callback executes after the unchanged production content gates.
        // Terminate before the section narration stage can start any provider I/O.
        intentionalStopReached = true;
        throw stopped;
      },
      onProgress: (progress) => { console.log(JSON.stringify({ phase: progress.step, selectedPage: probe.outlineId })); },
    };
    try { await classroom.generateClassroom(input, options); }
    catch (error) {
      if (!intentionalStopReached || !content || !accepted) { generationError = diagnostic(error); issues.push(generationError); }
      else await save("bounded-stop.json", { intentional: true, reason: stopped.message, caught: diagnostic(error), providerCallsAfterContent: 0 });
    }
    let parsed: { layoutCandidateId?: unknown; components?: Array<{ kind?: string; placementRef?: string }> } = {};
    if (rawText) {
      const normalized = rawText.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
      try { parsed = JSON.parse(normalized); } catch { /* Production acceptance preserves the parsing failure. */ }
    }
    const adopted = await load("src/lib/openmaic/generation/adopted-page-content.ts");
    const coverage = await load("src/lib/course-generation/source-content-acceptance.ts");
    const layout = await load("src/lib/openmaic/generation/slide-layout-audit.ts");
    let render: unknown, density: unknown;
    let pointCoverage: unknown;
    if (content) {
      const audit = await layout.auditSlideLayout(content, probe.outlineId);
      const measuredDensity = layout.auditSlideDensity(authoredOutline, content);
      render = audit; density = measuredDensity;
      if (audit.status !== "checked") issues.push(`Renderer measurement unavailable: ${audit.reason ?? "unknown"}`);
      issues.push(...audit.issues, ...measuredDensity.issues);
      issues.push(...coverage.findSourceContentIssues([{ outline: authoredOutline, content }], sourceSequenceContracts,
        { visibleOnly: true }).map((issue: { detail: string }) => issue.detail));
      const visible = coverage.sourceSequenceSlideContent(content).statements.join("\n");
      const compact = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, "");
      pointCoverage = adopted.adoptedPageAuthoringContent(authoredOutline).map((point: { id: string; text: string }) => ({
        id: point.id, text: point.text, completelyVisible: compact(visible).includes(compact(point.text)),
      }));
      if ((pointCoverage as Array<{ completelyVisible: boolean }>).some((point) => !point.completelyVisible)) {
        issues.push("Incomplete adopted presentation-point coverage");
      }
      if (content.continuationPages?.length) issues.push("Unexpected post-confirmation pagination");
    }
    const calls = observer.verificationUsageRecords();
    if (replay && calls.length !== 0) issues.push("Zero-call replay unexpectedly reached a provider");
    const authorCalls = calls.filter((call: { providerRejectedBeforeOutput: boolean }) => !call.providerRejectedBeforeOutput);
    if (authorCalls.length !== (replay ? 0 : 1) || authorCalls.some((call: { outlineId?: string; authoringStage?: string }) =>
      call.outlineId !== probe.outlineId || call.authoringStage !== "content")) issues.push("Single-authoring request scope was not satisfied");
    const passed = accepted && Boolean(content) && issues.length === 0;
    await save("result.json", { requestId: probe.requestId, scope: replay ? "same-raw-zero-call-content-replay" : "one-page-content-only",
      replayRawFrom: probe.replayRawFrom, passed, contentAccepted: accepted,
      knowledgeCalls: 0, durationCalls: 0, blueprintCalls: 0, narrationCalls: 0, quizCalls: 0,
      providerCalls: calls.length, authorCalls: authorCalls.length, usage: calls, selectedLayoutCandidateId: parsed.layoutCandidateId ?? null,
      placementReferences: parsed.components?.map((component) => component.placementRef).filter(Boolean) ?? [],
      render, density, pointCoverage, generationError, issues, modelRetriesForContent: 0,
      originalFailedDraftRetained: true, entireCourseQualityVerified: false });
    probe.status = passed ? "passed" : "failed";
    await save("probe.json", probe);
    console.log(JSON.stringify({ requestId: probe.requestId, passed, contentAccepted: accepted, providerCalls: calls.length,
      selectedLayoutCandidateId: parsed.layoutCandidateId ?? null, issues }));
    if (!passed) process.exitCode = 1;
  } finally {
    await Promise.allSettled([disconnect(),
      load("src/lib/openmaic/generation/slide-spatial-measurement.ts").then((module) => module.closeSpatialMeasurementBrowser()),
      load("src/lib/openmaic/generation/slide-layout-audit.ts").then((module) => module.closeSlideLayoutAuditBrowser())]);
  }
}

async function main() {
  const outputArg = arg("--output");
  if (!outputArg) throw new Error("需要独立的 --output .openpbl-runtime/... 目录");
  const output = runtimePath(outputArg);
  if (process.argv.includes("--worker")) { await worker(output); return; }
  const sourceArg = arg("--source-pages-run"), designArg = arg("--source-design-run");
  if (!sourceArg || !designArg) throw new Error("需要原页面 run 与原设计 run；不生成新的设计输入");
  const sourcePagesRun = runtimePath(sourceArg), sourceDesignRun = runtimePath(designArg);
  const replayArg = arg("--replay-raw-from");
  if (await fs.stat(path.join(output, "probe.json")).catch(() => null)) throw new Error("该请求身份已存在；不隐式重发");
  await fs.mkdir(output, { recursive: true });
  const input = await json<ProbeInput>(path.join(sourcePagesRun, "page-input.json"));
  const outlines = await json<SceneOutline[]>(path.join(sourcePagesRun, "prepared-outlines.json"));
  const first = outlines[0];
  if (!first || first.type !== "slide" || first.generationPurpose !== "knowledge-teaching") throw new Error("原第一页不是正常授课幻灯片");
  await writeJsonAtomic(path.join(output, "page-input.json"), input);
  await writeJsonAtomic(path.join(output, "prepared-outlines.json"), outlines);
  const probe: Probe = { requestId: randomUUID(), createdAt: new Date().toISOString(), outlineId: first.id,
    sourcePagesRun, sourceDesignRun, code: await freezeCode(output, "new"),
    ...(replayArg ? { replayRawFrom: runtimePath(replayArg) } : {}),
    inputSha256: sha(JSON.stringify(input)), outlinesSha256: sha(JSON.stringify(outlines)), status: "prepared" };
  await writeJsonAtomic(path.join(output, "probe.json"), probe);
  if (!process.argv.includes("--run")) { console.log(JSON.stringify({ status: "prepared", requestId: probe.requestId, providerCalls: 0 })); return; }
  probe.status = "running";
  await writeJsonAtomic(path.join(output, "probe.json"), probe);
  const log = await fs.open(path.join(output, "worker.log"), "a", 0o600);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repository, "node_modules/tsx/dist/cli.mjs"),
        "--tsconfig", path.join(probe.code.directory, "verification-tsconfig.json"), script, "--worker", "--output", output,
        ...(process.argv.includes("--deployment-secrets") ? ["--deployment-secrets"] : [])], {
        cwd: repository, env: { ...process.env, NODE_OPTIONS: "--conditions=import" }, stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
    });
    console.log(JSON.stringify({ requestId: probe.requestId, output, exitCode }));
    process.exitCode = exitCode;
  } finally { await log.close(); }
}
main().catch((error) => { console.error(diagnostic(error)); process.exitCode = 1; });

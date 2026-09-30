/** Isolated comparison of the production authoring pipeline, never a lab generator. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { Course } from "../src/lib/session/types";
import type { QuickDesignRequest } from "../src/lib/course-design/job-runner";
import type { GenerateClassroomInput } from "../src/lib/openmaic/server/classroom-generation";
import type { SceneOutline } from "../src/lib/openmaic/types/generation";
import type { Scene } from "../src/lib/openmaic/types/stage";
import type { ThinkingConfig } from "../src/lib/openmaic/types/provider";
import { writeJsonAtomic } from "../tools/course-quality-lab/storage";
import { buildFirstPassSourceCatalog, expandFirstPassSourceCatalog, summarizeFirstPassCostRuns, type FirstPassBillingRates, type FirstPassCostRun } from "../src/lib/course-generation/first-pass-cost";
import type { VerificationCallUsage } from "./course-first-pass-cost-instrumentation";

const shell = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const secrets = new Set<string>();
const BASELINE = "89f08ce";

type Job = { id: string; targetId: string; jobType: string; request: QuickDesignRequest & GenerateClassroomInput };
type Template = { id: string; versions: Array<{ version: number; snapshot: unknown }> };
type Fixture = {
  id: string;
  title: string;
  course: Course;
  request: QuickDesignRequest;
  pageInput: GenerateClassroomInput;
  sectionId?: string;
  aiDurationSec: number;
  policy: { modelString: string; thinking?: ThinkingConfig; modelOutputWindow?: number; timeoutMs: number;
    outputBudgetVersion: string; executionBudget: { minTokensPerSecond: number; startupAllowanceMs: number; maxDurationMs: number } };
};
type Manifest = { version: 1; baseline: string; createdAt: string; sourceSha256: string;
  code: Record<"baseline" | "new", { directory: string; commit: string; sourceSha256: string; instrumentationSha256: string; instrumentationModule?: string }>;
  fixtures: Fixture[]; runs: Array<FirstPassCostRun & { id: string; directory: string; sourceRunDirectory?: string }>;
  frozen: { models: string[]; rawSourcesPreserved: boolean; media: string; database: "read-only"; modes: string[] } };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要参数值`);
  return value;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeError(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) value = value.split(secret).join("[redacted]");
  return value.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, "[redacted-url]@");
}
async function json<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
async function readOnlyClient(databaseUrl?: string): Promise<PrismaClient> {
  const { PrismaClient } = await import("@prisma/client");
  const allowed = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
  return new PrismaClient({ ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}), log: ["error"] }).$extends({
    query: { $allOperations({ model, operation, args, query }) {
      if (!allowed.has(operation)) throw new Error(`只读验证禁止数据库操作：${model ?? "raw"}.${operation}`);
      return query(args);
    } },
  }) as unknown as PrismaClient;
}
async function initializeReadOnlyClients(): Promise<void> {
  if (process.argv.includes("--deployment-secrets")) {
    const folder = process.env.OPENPBL_SECRET_DIR || path.join(repository, "deploy/secrets");
    for (const [key, filename] of [["DATABASE_URL", "database_url.txt"], ["PROVIDER_ENCRYPTION_KEY", "provider_encryption_key.txt"]]) {
      process.env[key] = (await fs.readFile(path.join(folder, filename), "utf8")).trim();
    }
  }
  for (const key of ["DATABASE_URL", "PROVIDER_CONFIG_DATABASE_URL", "PROVIDER_ENCRYPTION_KEY"]) if (process.env[key]) secrets.add(process.env[key]!);
  globalThis.__openPblPrisma = await readOnlyClient();
  if (process.env.PROVIDER_CONFIG_DATABASE_URL && process.env.PROVIDER_CONFIG_DATABASE_URL !== process.env.DATABASE_URL) {
    globalThis.__openPblProviderPrisma = await readOnlyClient(process.env.PROVIDER_CONFIG_DATABASE_URL);
  }
}
async function disconnect(): Promise<void> {
  await globalThis.__openPblPrisma?.$disconnect();
  if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
}

function observedClassroomSource(source: string, helper: string): string {
  const wrappers: string[] = [];
  for (const [name, stage, identifier] of [
    ["generateSceneContent", "content", "args[0].id"],
    ["generateSceneActions", "actions", "args[0].id"],
    ["generateTeachingNarration", "narration", "args[0].outline.id"],
    ["generateTeachingSectionNarration", "narration", "args[0].pages.map((page) => page.outline.id).join(',')"],
    ["generateTeachingSourceNarrationInsertions", "source-narration-repair", "args[0].pages.map((page) => page.outline.id).join(',')"],
  ]) {
    const imported = new RegExp(`(\\s)${name}(\\s*,)`);
    if (!imported.test(source)) continue;
    source = source.replace(imported, `$1${name} as verificationOriginal${name}$2`);
    wrappers.push(`const ${name} = (...args: Parameters<typeof verificationOriginal${name}>) => withVerificationAuthoringStage(${JSON.stringify(stage)}, ${identifier}, () => verificationOriginal${name}(...args));`);
  }
  if (!wrappers.length) throw new Error("没有找到课堂作者入口，不能测量首稿调用次数");
  return `import { withVerificationAuthoringStage } from ${JSON.stringify(helper)};\n${source.replace("const log = createLogger('Classroom');", `${wrappers.join("\n")}\nconst log = createLogger('Classroom');`)}`;
}

function stageWasFirstPass(calls: VerificationCallUsage[]): boolean {
  return calls.filter((call) => !call.providerRejectedBeforeOutput).length === 1;
}

function pageStagesWereFirstPass(calls: VerificationCallUsage[]): boolean {
  const byStage = new Map<string, number>();
  for (const call of calls) {
    if (call.providerRejectedBeforeOutput) continue;
    if (!call.authoringStage || !call.outlineId) return false;
    const key = `${call.outlineId}:${call.authoringStage}`;
    byStage.set(key, (byStage.get(key) ?? 0) + 1);
  }
  return byStage.size > 0 && [...byStage.values()].every((count) => count === 1);
}

/** Archive and overlay in scratch directories; the user's branch/worktree is untouched. */
async function freezeCode(output: string, arm: "baseline" | "new") {
  const destination = path.join(output, "code", arm);
  const revision = arm === "baseline" ? BASELINE : "HEAD";
  const { stdout: commit } = await shell("git", ["rev-parse", revision], { cwd: repository });
  await fs.mkdir(destination, { recursive: true });
  const archive = path.join(output, `${arm}-source.tar`);
  await shell("git", ["archive", "--format=tar", `--output=${archive}`, revision], { cwd: repository });
  await shell("tar", ["-xf", archive, "-C", destination]);
  const sourceHash = createHash("sha256");
  sourceHash.update(await fs.readFile(archive));
  if (arm === "new") {
    const { stdout: listed } = await shell("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
    for (const filename of listed.split("\0").filter(Boolean).sort()) {
      const source = path.join(repository, filename);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat?.isFile()) { await fs.rm(path.join(destination, filename), { force: true }); continue; }
      const body = await fs.readFile(source);
      sourceHash.update(filename).update(body);
      await fs.mkdir(path.dirname(path.join(destination, filename)), { recursive: true });
      await fs.copyFile(source, path.join(destination, filename));
    }
  }
  await fs.symlink(path.join(repository, "node_modules"), path.join(destination, "node_modules"), "dir");
  const config = await json<{ compilerOptions: { paths: Record<string, string[]>; baseUrl?: string } }>(path.join(destination, "tsconfig.json"));
  config.compilerOptions.baseUrl = destination;
  config.compilerOptions.paths["@openmaic/generation"] = ["./packages/@openmaic/generation/src/index.ts"];
  config.compilerOptions.paths["@openmaic/dsl"] = ["./packages/@openmaic/dsl/src/index.ts"];
  config.compilerOptions.paths["@openmaic/renderer"] = ["./packages/@openmaic/renderer/src/index.ts"];
  await writeJsonAtomic(path.join(destination, "verification-tsconfig.json"), config);
  const llmPath = path.join(destination, "src/lib/openmaic/ai/llm.ts");
  const original = await fs.readFile(llmPath, "utf8");
  const helper = path.join(destination, "scripts/course-first-pass-cost-instrumentation.ts");
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.copyFile(path.join(repository, "scripts/course-first-pass-cost-instrumentation.ts"), helper);
  const storage = path.join(destination, "tools/course-quality-lab/storage.ts");
  await fs.mkdir(path.dirname(storage), { recursive: true });
  await fs.copyFile(path.join(repository, "tools/course-quality-lab/storage.ts"), storage);
  const instrumented = original.replace("import { generateText, streamText } from 'ai';",
    `import { instrumentedGenerateText as generateText, instrumentedStreamText as streamText } from ${JSON.stringify(helper)};`)
    .replace("generateText(injectedParams)", "generateText(injectedParams, source)")
    .replace("streamText(injectedParams)", "streamText(injectedParams, source)");
  if (instrumented === original) throw new Error(`${arm} 无法安装只读用量观察器`);
  await fs.writeFile(llmPath, instrumented);
  const designPath = path.join(destination, "src/lib/course-design/job-runner.ts");
  const designSource = await fs.readFile(designPath, "utf8");
  if (!designSource.includes("function stageSummaryInput(")) throw new Error(`${arm} 设计输入入口不存在`);
  const observedDesign = designSource.replace("function stageSummaryInput(", "export function stageSummaryInput(");
  await fs.writeFile(designPath, observedDesign);
  const classroomPath = path.join(destination, "src/lib/openmaic/server/classroom-generation.ts");
  const observedClassroom = observedClassroomSource(await fs.readFile(classroomPath, "utf8"), helper);
  await fs.writeFile(classroomPath, observedClassroom);
  return { directory: destination, commit: commit.trim(), sourceSha256: sourceHash.digest("hex"), instrumentationModule: helper,
    instrumentationSha256: sha(instrumented + observedDesign + observedClassroom
      + await fs.readFile(helper, "utf8") + await fs.readFile(storage, "utf8")) };
}

async function prepare(output: string): Promise<Manifest> {
  const directory = arg("--snapshot-dir");
  const pageDirectory = arg("--page-snapshot-dir") ?? directory;
  if (!directory || !pageDirectory) throw new Error("准备需要 --snapshot-dir（failed-jobs/failed-templates）及 --page-snapshot-dir（recent-jobs）");
  const inputs = await Promise.all([fs.readFile(path.join(directory, "failed-jobs.json"), "utf8"),
    fs.readFile(path.join(directory, "failed-templates.json"), "utf8"), fs.readFile(path.join(pageDirectory, "recent-jobs.json"), "utf8")]);
  const designJobs = JSON.parse(inputs[0]!) as Job[];
  const templates = JSON.parse(inputs[1]!) as Template[];
  const pageJobs = JSON.parse(inputs[2]!) as Job[];
  const { decodePblTemplate, createPblTemplateCourse } = await import("../src/lib/platform/pbl-template");
  const { initializeServerProviderConfig } = await import("../src/lib/openmaic/server/provider-config");
  const { resolveModel } = await import("../src/lib/openmaic/server/resolve-model");
  const { resolveLlmRequestTimeoutMs } = await import("../src/lib/llm/request-policy");
  const { COURSE_OUTPUT_BUDGET_VERSION, resolveCourseExecutionBudgetOptions } = await import("../src/lib/openmaic/generation/course-output-budget");
  await initializeServerProviderConfig();
  const fixtures: Fixture[] = [];
  for (const [id, title] of [["teaching-theory", "教学理论与方法"], ["resource-package", "教学资源包开发"]]) {
    const template = templates.find((item) => item.versions.some((version) => decodePblTemplate(version.snapshot)?.name.includes(title!)));
    const design = template?.versions.slice().sort((a, b) => b.version - a.version)[0];
    const decoded = design ? decodePblTemplate(design.snapshot) : null;
    const job = designJobs.find((item) => item.targetId === template?.id && item.jobType === "COURSE_DESIGN");
    const page = pageJobs.find((item) => item.targetId === template?.id && item.jobType === "COURSE_CONTENT");
    if (!decoded || !job || !page) throw new Error(`真实快照缺少 ${title} 的完整课程/设计请求/页面请求`);
    const course = createPblTemplateCourse(template!.id, decoded);
    const resolved = await resolveModel({ modelString: job.request.generationModelString, stage: "scene-outlines-stream" });
    if (resolved.apiKey) secrets.add(resolved.apiKey);
    const aiDurationSec = (course.content.moduleTimingPlan?.allocations ?? [])
      .filter((item) => item.stageKey === "ai-learning").reduce((sum, item) => sum + item.durationMin * 60, 0);
    if (!(aiDurationSec > 0)) throw new Error(`${title} 没有可冻结的已确认时长`);
    fixtures.push({ id: id!, title: course.name, course, request: job.request, pageInput: page.request, aiDurationSec,
      policy: { modelString: resolved.modelString, thinking: resolved.thinkingConfig, modelOutputWindow: resolved.modelInfo?.outputWindow,
        timeoutMs: resolveLlmRequestTimeoutMs("long-generation"), outputBudgetVersion: COURSE_OUTPUT_BUDGET_VERSION,
        executionBudget: resolveCourseExecutionBudgetOptions() } });
  }
  const challenging = fixtures.flatMap((fixture) => [...new Set((fixture.pageInput.sceneOutlines ?? []).map((page) => page.lectureSectionId))]
    .filter((id): id is string => Boolean(id)).map((sectionId) => {
      const pages = fixture.pageInput.sceneOutlines!.filter((page) => page.lectureSectionId === sectionId);
      const source = pages.flatMap((page) => page.keyPoints ?? []).join("\n");
      const branching = pages.filter((page) => page.visualIntent?.diagram?.topology === "branch"
        || (page.visualIntent?.diagram?.edges?.length ?? 0) > (page.visualIntent?.diagram?.nodes.length ?? 0)).length;
      return { fixture, sectionId, score: branching * 100_000 + source.length, branching };
    })).sort((left, right) => right.score - left.score)[0];
  if (!challenging?.branching) throw new Error("真实快照没有包含长列表与实际分支图的完整困难小节");
  fixtures.push({ ...challenging.fixture, id: "long-list-branch", title: `${challenging.fixture.title}／${challenging.sectionId}`,
    sectionId: challenging.sectionId });
  await fs.mkdir(output, { recursive: true });
  await writeJsonAtomic(path.join(output, "fixtures.json"), fixtures);
  const code: Manifest["code"] = { baseline: await freezeCode(output, "baseline"), new: await freezeCode(output, "new") };
  const runs: Manifest["runs"] = [];
  for (const fixture of fixtures) for (const arm of ["baseline", "new"] as const) for (const repetition of [1, 2, 3]) {
    const id = `${fixture.id}-${arm}-${repetition}`;
    runs.push({ id, directory: path.join(output, "runs", id), sampleId: fixture.id, arm, repetition,
      mode: "end-to-end", stage: "all", status: "planned", qualityPassed: false, stageResults: [], usage: [] });
  }
  const manifest: Manifest = { version: 1, baseline: BASELINE, createdAt: new Date().toISOString(), sourceSha256: sha(inputs.join("\n")),
    code, fixtures, runs, frozen: { models: fixtures.map((fixture) => fixture.policy.modelString), rawSourcesPreserved: true,
      media: "保留原请求媒体开关；仅比较正式设计/页面/讲稿/测验作者费用，图片/TTS资产费用另计", database: "read-only", modes: ["end-to-end", "frozen-stages"] } };
  await writeJsonAtomic(path.join(output, "manifest.json"), manifest);
  return manifest;
}

async function worker(output: string): Promise<void> {
  const manifest = await json<Manifest>(path.join(output, "manifest.json"));
  const id = arg("--run-id");
  const run = manifest.runs.find((item) => item.id === id);
  if (!run) throw new Error("worker run-id 不存在");
  const fixture = manifest.fixtures.find((item) => item.id === run.sampleId)!;
  const code = manifest.code[run.arm].directory;
  const load = (module: string) => import(pathToFileURL(path.join(code, module)).href);
  const save = (name: string, value: unknown) => writeJsonAtomic(path.join(run.directory, name), value);
  process.env.CLASSROOM_DATA_DIR = path.join(run.directory, "classrooms");
  process.env.OPENPBL_DATA_DIR = path.join(run.directory, "store");
  const { setVerificationInstrumentationDirectory, verificationUsageRecords } = await import(pathToFileURL(
    manifest.code[run.arm].instrumentationModule ?? path.join(repository, "scripts/course-first-pass-cost-instrumentation.ts")).href);
  setVerificationInstrumentationDirectory(run.directory);
  await initializeReadOnlyClients();
  const stageResults: FirstPassCostRun["stageResults"] = [];
  const continuation = run.sourceRunDirectory ? await json<{
    course: Course; outlines: SceneOutline[]; validation: { passed: boolean; modelCalls: number; issues: string[] };
  }>(path.join(run.sourceRunDirectory, "continuation-input.json")) : undefined;
  if (continuation) {
    if (run.stage !== "pages" || run.mode !== "frozen-stages" || !continuation.validation.passed
      || continuation.validation.modelCalls !== 0 || continuation.validation.issues.length || continuation.course.id !== fixture.course.id) {
      throw new Error("仅允许复用同课程、零模型调用完整验收的大纲继续页面首稿");
    }
    const original = await json<Course>(path.join(run.sourceRunDirectory!, "course-after.json"));
    if (JSON.stringify(original.content.knowledgePoints) !== JSON.stringify(continuation.course.content.knowledgePoints)
      || JSON.stringify(original.content.moduleTimingPlan) !== JSON.stringify(continuation.course.content.moduleTimingPlan)) {
      throw new Error("页面续跑不能重写已完成的知识结构或固定时长规划");
    }
    await save("reused-design-checkpoints.json", { sourceRunDirectory: run.sourceRunDirectory,
      knowledgeAuthorCalls: 0, durationAuthorCalls: 0, blueprintAuthorCalls: 0,
      continuationSha256: sha(JSON.stringify(continuation)) });
  }
  const course = structuredClone(continuation?.course ?? fixture.course);
  let outlines = structuredClone(continuation?.outlines ?? fixture.pageInput.sceneOutlines ?? []);
  const wants = (stage: string) => run.stage === "all" || run.stage === stage;
  try {
    const provider = await load("src/lib/openmaic/server/provider-config.ts");
    await provider.initializeServerProviderConfig();
    const resolver = await load("src/lib/openmaic/server/resolve-model.ts");
    const resolved = await resolver.resolveModel({ modelString: fixture.policy.modelString, thinkingConfig: fixture.policy.thinking });
    if (resolved.apiKey) secrets.add(resolved.apiKey);
    if (resolved.modelString !== fixture.policy.modelString) throw new Error("冻结的正式模型发生变化");
    const design = await load("src/lib/course-design/job-runner.ts");
    const ai = await load("src/lib/openmaic/server/course-generation-ai-call.ts");
    const budget = await import("../src/lib/openmaic/generation/course-output-budget");
    const makeCall = (source: string) => {
      const outputBudget = budget.createCourseOutputBudget({ resource: "planning", modelOutputWindow: fixture.policy.modelOutputWindow, thinking: fixture.policy.thinking });
      const context = {};
      return async (system: string, prompt: string, images?: Array<{ id: string; src: string }>) => {
      const base = ai.createCourseGenerationAiCall({ model: resolved.model, vision: false, source,
        thinking: fixture.policy.thinking, temperature: 0.2, timeoutMs: fixture.policy.timeoutMs,
        maxOutputTokens: Math.min(131_072, outputBudget(system, prompt)),
        outputBudget: (system: string, prompt: string) => Math.min(131_072, outputBudget(system, prompt)),
        executionBudget: fixture.policy.executionBudget, streamResponse: true,
        onResponse: (response: unknown) => save(`${source}-response.json`, response), requireResponsePersistence: true });
      const call = ai.withCourseGenerationAiCallContext?.(base, context) ?? base;
        await save(`${source}-prompt.json`, { system, prompt, ...(images ? { images } : {}) });
        const text = await call(system, prompt, images);
        // Also observe old interfaces which do not support onResponse.
        await save(`${source}-response.json`, { source, system, prompt, text, complete: true });
        return text;
      };
    };
    const packageModule = await load("src/lib/course-design/resource-package-knowledge.ts");
    const teachingBrief = [fixture.request.teacherBrief, fixture.request.supplementalAnswers?.brief ?? ""].filter(Boolean).join("\n");
    const sourceModule = await import("../src/lib/textbook/course-evidence-types");
    const evidenceText = sourceModule.formatCourseEvidenceContext(fixture.request.textbookEvidence, { deduplicateItems: true });
    let request = fixture.request;
    if (run.arm === "baseline" && fixture.request.resourcePackage) {
      const sources = { referenceMaterials: fixture.request.referenceMaterials ?? [], resourcePackage: fixture.request.resourcePackage,
        textbookEvidence: fixture.request.textbookEvidence };
      const catalog = buildFirstPassSourceCatalog(sources);
      if (JSON.stringify(expandFirstPassSourceCatalog(catalog)) !== JSON.stringify(sources)) throw new Error("旧版接口来源投影不能无损还原");
      const content = "冻结教材与资源包原文（旧版输入兼容投影）：sourceTexts 保存完整原文且每个相同段落仅一份；sources 内 sourceTextRef 仅为编号引用，阅读时展开对应完整值。所有版本、出处、确认责任、时长、列表和分支保留。\n"
        + JSON.stringify(catalog);
      request = { ...fixture.request, resourcePackage: undefined,
        referenceMaterials: [{ id: "frozen-full-original-source-catalog", fileName: "原始资料与确认合同编号表", mimeType: "text/plain", content }] };
      // The old typed package parser cannot express this v2 contract. Its
      // equivalent original documents are passed through its supported field.
      // Fixed stage timings/responsibilities remain unchanged; no outputs added.
      course.content.resourcePackage = undefined;
      await save("baseline-input-compatibility.json", { mode: "lossless-reference-projection", nativeSubmission: false,
        sourceSha256: sha(JSON.stringify(sources)), expandedSha256: sha(JSON.stringify(expandFirstPassSourceCatalog(catalog))),
        knownRepresentationDifference: "89f08ce requires obsolete per-stage outputs for typed v2 packages", catalog });
    }
    const context = { teacherRequiredKnowledgePoints: course.content.teacherRequiredKnowledgePoints ?? [],
      teacherKnowledgePoints: packageModule.resourcePackageTeachingPoints(fixture.request.resourcePackage),
      referenceMaterials: request.referenceMaterials,
      textbookEvidence: fixture.request.textbookEvidence,
      teachingCapacity: design.buildKnowledgePlanningCapacity?.({ courseHours: course.hours,
        stagePlan: course.content.stagePlan, assessmentMode: fixture.request.assessmentMode ?? "adaptive" }) };
    if (wants("knowledge")) {
      const stage = "knowledge";
      const callsBefore = verificationUsageRecords().length;
      try {
        const knowledgeInput = design.stageSummaryInput(course, request, false);
        const knowledge = await load("src/lib/knowledge-structure-generation.ts");
        const aiCall = makeCall(stage);
        const baselineContext = context;
        await save("knowledge-input.json", { input: knowledgeInput, context: baselineContext });
        const generated = await knowledge.generateKnowledgeStructureOnce(knowledgeInput, baselineContext, {
          aiCall, modelCall: (messages: Array<{ role: string; content: string }>) => aiCall(messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n"),
            messages.filter((item) => item.role !== "system").map((item) => item.content).join("\n\n")),
        });
        await save("knowledge.json", generated);
        stageResults.push({ stage, passed: true,
          firstPass: stageWasFirstPass(verificationUsageRecords().slice(callsBefore)), issues: [] });
        if (run.mode === "end-to-end") course.content = { ...course.content, ...generated };
      } catch (error) { stageResults.push({ stage, passed: false, firstPass: false, issues: [safeError(error)] }); throw error; }
    }
    if (wants("duration")) {
      const stage = "duration";
      const callsBefore = verificationUsageRecords().length;
      try {
        const duration = await load("src/lib/classroom/new-system-ai-duration.ts");
        const durationInput = { course, knowledgePoints: course.content.knowledgePoints, knowledgeGraph: course.content.knowledgeGraph,
          knowledgeScopePlan: course.content.knowledgeScopePlan, generationMode: fixture.request.generationMode ?? "standard",
          assessmentMode: fixture.request.assessmentMode ?? "adaptive", teacherBrief: [teachingBrief, run.arm === "new" ? evidenceText : ""].filter(Boolean).join("\n\n"),
          teachingRequirements: course.content.teachingRequirements, referenceMaterials: request.referenceMaterials, stagePlan: course.content.stagePlan };
        await save("duration-input.json", durationInput);
        const aiCall = makeCall(stage);
        const recommendation = await duration.generateNewSystemAiDurationRecommendation(durationInput, { aiCall,
          modelCall: (messages: Array<{ role: string; content: string }>) => aiCall(messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n"),
            messages.filter((item) => item.role !== "system").map((item) => item.content).join("\n\n")) });
        await save("duration.json", recommendation);
        if (recommendation.durationMin * 60 !== fixture.aiDurationSec) throw new Error("首稿时长偏离冻结预算；不能用课时变化比较成本");
        stageResults.push({ stage, passed: true,
          firstPass: stageWasFirstPass(verificationUsageRecords().slice(callsBefore)), issues: [] });
        if (run.mode === "end-to-end") {
          const timing = await load("src/lib/classroom/new-system-course.ts");
          course.content.moduleTimingPlan = timing.buildNewSystemAiTimingPlan(recommendation, course.content.knowledgePoints);
        }
      } catch (error) { stageResults.push({ stage, passed: false, firstPass: false, issues: [safeError(error)] }); throw error; }
    }
    if (wants("outline")) {
      const stage = "outline";
      const callsBefore = verificationUsageRecords().length;
      try {
        if (run.arm === "new") {
          const blueprintModule = await load("src/lib/course-design/teaching-blueprint.ts");
          const prepared = await design.prepareTeachingBlueprintInput(course, course.content, fixture.request, fixture.aiDurationSec / 60,
            sha(JSON.stringify(fixture.policy)));
          await save("outline-input.json", prepared.input);
          let blueprint = await blueprintModule.generateTeachingBlueprint(prepared.input, makeCall(stage), {
            resourceCapabilities: { imageGenerationEnabled: fixture.pageInput.enableImageGeneration === true,
              videoGenerationEnabled: fixture.pageInput.enableVideoGeneration === true },
            onValidation: (value: unknown) => save("blueprint-validation.json", value),
          });
          const binding = await load("src/lib/textbook/course-visual-binding.ts");
          const language = await load("src/lib/openmaic/generation/course-language.ts");
          blueprint = binding.bindRequiredTextbookFiguresToBlueprint(blueprint, prepared.textbookFigureResources, prepared.input.sourceSequences);
          outlines = binding.bindRequiredTextbookFiguresToOutlines(
            blueprintModule.teachingBlueprintToOutlines(blueprint, language.ZH_CN_COURSE_LANGUAGE_DIRECTIVE),
            prepared.textbookFigureResources, prepared.input.sourceSequences);
          const capacity = await load("src/lib/openmaic/generation/teaching-page-preflight.ts");
          const preflight = await capacity.prepareTeachingPageCapacity(outlines, {
            lockedOutlineIds: [], resourceDimensions: Object.fromEntries(prepared.textbookFigureResources
              .filter((resource: { width?: number; height?: number }) => resource.width && resource.height)
              .map((resource: { id: string; width: number; height: number }) => [resource.id, { width: resource.width, height: resource.height }])),
          });
          await save("design-page-capacity.json", preflight);
          if (preflight.changed) {
            const sync = await load("src/lib/course-generation/job-runner.ts");
            const content = sync.applyVersionedOutlinePlanToCourseContent({ ...course.content,
              teachingBlueprint: blueprint, _openmaicSceneOutlines: outlines }, preflight.outlines);
            blueprint = content.teachingBlueprint;
            outlines = preflight.outlines;
          }
          const budgetIssues = blueprintModule.validateTeachingBlueprintBudget(blueprint, outlines);
          if (budgetIssues.length) throw new Error(budgetIssues.join("；"));
          binding.assertSourceSequencesInOutlines(outlines, prepared.input.sourceSequences ?? [], prepared.textbookFigureResources);
          await save("blueprint.json", blueprint);
          if (run.mode === "end-to-end") course.content.teachingBlueprint = blueprint;
        } else {
          const outline = await load("src/lib/openmaic/generation/openmaic-baseline.ts");
          const requirement = design.buildOpenMaicKnowledgeLectureRequirement(course, course.content, request, fixture.aiDurationSec / 60);
          const source = design.buildCourseTeachingSourceContext(request.resourcePackage, teachingBrief, request.referenceMaterials ?? []);
          const result = await outline.generateOpenMaicBaselineOutlines({ requirement }, source, undefined, makeCall(stage), {
            imageGenerationEnabled: fixture.pageInput.enableImageGeneration === true,
            videoGenerationEnabled: fixture.pageInput.enableVideoGeneration === true,
          });
          if (!result.success || !result.data?.outlines?.length) throw new Error(result.error ?? "基线大纲首稿无可执行页面");
          outlines = design.normalizeNewSystemAiOutlines(result.data.outlines, { totalDurationSec: fixture.aiDurationSec,
            knowledgePointIds: course.content.knowledgePoints.map((point) => point.id), knowledgePoints: course.content.knowledgePoints,
            knowledgeGraph: course.content.knowledgeGraph, courseLanguageDirective: result.data.languageDirective });
        }
        design.assertAiOutlineKnowledgeCoverage(outlines, course.content.knowledgePoints);
        await save("outlines.json", outlines);
        stageResults.push({ stage, passed: true,
          firstPass: stageWasFirstPass(verificationUsageRecords().slice(callsBefore)), issues: [] });
      } catch (error) { stageResults.push({ stage, passed: false, firstPass: false, issues: [safeError(error)] }); throw error; }
    }
    if (wants("pages")) {
      const stage = "pages";
      const callsBefore = verificationUsageRecords().length;
      try {
        const authoringStages: Array<{ pageId: string; stage: string; responseCount: number; validated?: boolean; issues?: string[] }> = [];
        const classroom = await load("src/lib/openmaic/server/classroom-generation.ts");
        const selected = fixture.sectionId ? outlines.filter((outline) => outline.lectureSectionId === fixture.sectionId) : outlines;
        if (!selected.length) throw new Error("困难小节在新输出中身份发生变化，不能静默改选小节");
        const input = { ...fixture.pageInput, generationModelString: fixture.policy.modelString, sceneOutlines: selected,
          knowledgePoints: course.content.knowledgePoints, moduleTimingPlan: course.content.moduleTimingPlan };
        await save("page-input.json", input);
        const evidence = await load("src/lib/textbook/course-evidence-types.ts");
        const sourceSequenceContracts = typeof evidence.resolveCourseSourceSequenceContracts === "function"
          ? evidence.resolveCourseSourceSequenceContracts(fixture.request.textbookEvidence, course.content.knowledgePoints) : [];
        const generated = await classroom.generateClassroom(input, {
          sourceEvidence: fixture.request.textbookEvidence, sourceKnowledgePoints: course.content.knowledgePoints, sourceSequenceContracts,
          onOutlinesPrepared: (prepared: SceneOutline[]) => save("prepared-outlines.json", prepared),
          onAuthoringResponse: (response: { source: string; text: string }) => save(`page-response-${sha(response.text).slice(0, 12)}.json`, response),
          onStageAuthoringResponse: async (response: { outline: SceneOutline; stage: string; text: string }) => {
            const key = authoringStages.find((item) => item.pageId === response.outline.id && item.stage === response.stage);
            if (key) key.responseCount += 1;
            else authoringStages.push({ pageId: response.outline.id, stage: response.stage, responseCount: 1 });
            await save(`raw-${response.outline.id}-${response.stage}.json`, response);
          },
          onStageAuthoringValidated: async (result: { outline: SceneOutline; stage: string; accepted: boolean; issues?: string[] }) => {
            const key = authoringStages.find((item) => item.pageId === result.outline.id && item.stage === result.stage);
            if (key) { key.validated = result.accepted; key.issues = result.issues; }
            await save("authoring-stage-acceptance.json", authoringStages);
          },
          onSceneCompleted: (outline: SceneOutline, scene: unknown) => save(`page-${outline.id}.json`, scene),
          onSceneStageCompleted: (outline: SceneOutline, currentStage: string, payload: unknown) => save(`stage-${outline.id}-${currentStage}.json`, payload),
          onProgress: (progress: { step: string; scenesGenerated?: number }) => {
            console.log(JSON.stringify({ phase: "pages", runId: id, step: progress.step, scenesGenerated: progress.scenesGenerated }));
          },
        });
        await save("classroom.json", generated);
        if (generated.qualityReport?.ok === false) throw new Error("正式课程质量验收未通过");
        stageResults.push({ stage, passed: true,
          firstPass: pageStagesWereFirstPass(verificationUsageRecords().slice(callsBefore))
            && authoringStages.every((entry) => entry.responseCount === 1 && entry.validated !== false), issues: [] });
      } catch (error) { stageResults.push({ stage, passed: false, firstPass: false, issues: [safeError(error)] }); throw error; }
    }
    run.status = "complete";
    run.qualityPassed = stageResults.every((stage) => stage.passed);
    // Assembly produces editable authoring results. Original image/video/TTS
    // assets are not generated here, so this is not a verified complete course.
    run.scopeCompleteness = "authoring-only";
  } catch (error) {
    run.status = "failed";
    run.qualityPassed = false;
    await save("failure.json", { message: safeError(error), stageResults });
    process.exitCode = 1;
  } finally {
    run.stageResults = stageResults;
    run.usage = verificationUsageRecords();
    await save("run.json", run);
    await save("course-after.json", course);
    for (const [module, name] of [
      ["src/lib/openmaic/generation/slide-spatial-measurement.ts", "closeSpatialMeasurementBrowser"],
      ["src/lib/openmaic/generation/slide-layout-audit.ts", "closeSlideLayoutAuditBrowser"],
    ]) {
      if (await fs.stat(path.join(code, module)).catch(() => null)) {
        const measurement = await load(module);
        await measurement[name]?.();
      }
    }
    await disconnect();
  }
}

/** Both arms face the frozen current renderer/source/playback gates; no author calls. */
async function acceptanceWorker(output: string): Promise<void> {
  const manifest = await json<Manifest>(path.join(output, "manifest.json"));
  const run = manifest.runs.find((entry) => entry.id === arg("--run-id"));
  if (!run) throw new Error("验收 worker run-id 不存在");
  const fixture = manifest.fixtures.find((entry) => entry.id === run.sampleId)!;
  const code = manifest.code.new.directory;
  const load = (module: string) => import(pathToFileURL(path.join(code, module)).href);
  const save = (name: string, value: unknown) => writeJsonAtomic(path.join(run.directory, name), value);
  await initializeReadOnlyClients();
  const issues: string[] = [];
  const checked: Array<Record<string, unknown>> = [];
  try {
    const course = await json<Course>(path.join(run.directory, "course-after.json"));
    const response = await json<{ text: string; complete?: boolean }>(path.join(run.directory, "knowledge-response.json")).catch(() => null);
    if (response) {
      const input = await json<{ input: unknown; context: unknown }>(path.join(run.directory, "knowledge-input.json"));
      try {
        if (response.complete === false) throw new Error("截断或状态不明的保存响应不允许验收复用");
        const knowledge = await load("src/lib/knowledge-structure-generation.ts");
        await knowledge.generateKnowledgeStructureOnce(input.input, input.context, {
          initialResponse: response.text, aiCall: () => { throw new Error("共同验收不允许模型调用"); },
        });
        checked.push({ stage: "knowledge", passed: true, modelCalls: 0 });
      } catch (error) { issues.push(`knowledge: ${safeError(error)}`); }
    }
    const pageInput = await json<GenerateClassroomInput>(path.join(run.directory, "page-input.json")).catch(() => null);
    const generated = await json<{ scenes: Scene[] }>(path.join(run.directory, "classroom.json")).catch(() => null);
    if (pageInput && generated) {
      const outlines = await json<SceneOutline[]>(path.join(run.directory, "prepared-outlines.json"))
        .catch(() => pageInput.sceneOutlines ?? []);
      const evidence = await load("src/lib/textbook/course-evidence-types.ts");
      const binding = await load("src/lib/textbook/course-visual-binding.ts");
      const source = await load("src/lib/course-generation/source-content-acceptance.ts");
      const layout = await load("src/lib/openmaic/generation/slide-layout-audit.ts");
      const quiz = await load("src/lib/openmaic/quiz/quality.ts");
      const language = await load("src/lib/openmaic/generation/course-language.ts");
      const theme = await load("src/lib/openmaic/generation/course-visual-theme.ts");
      const contracts = evidence.resolveCourseSourceSequenceContracts(fixture.request.textbookEvidence, course.content.knowledgePoints);
      try { binding.assertSourceSequencesInOutlines(outlines, contracts, []); }
      catch (error) { issues.push(`outline sources: ${safeError(error)}`); }
      issues.push(...source.findFinalizedSourceContentIssues(outlines, generated.scenes, contracts)
        .map((issue: { detail: string }) => `source: ${issue.detail}`));
      if (generated.scenes.length !== outlines.length) issues.push(`scene count ${generated.scenes.length}/${outlines.length}`);
      for (const outline of outlines) {
        const scene = generated.scenes.find((item) => item.outlineId === outline.id);
        if (!scene) { issues.push(`${outline.id}: missing scene`); continue; }
        issues.push(...language.auditNarrationLanguage(scene.actions, "zh-CN").map((issue: string) => `${outline.id}: ${issue}`));
        if (scene.content.type === "slide") {
          const content = { elements: scene.content.canvas.elements, viewportSize: scene.content.canvas.viewportSize,
            viewportRatio: scene.content.canvas.viewportRatio, theme: scene.content.canvas.theme, background: scene.content.canvas.background };
          const render = await layout.auditSlideLayout(content, outline.id);
          const density = layout.auditSlideDensity(outline, content);
          checked.push({ stage: "render", outlineId: outline.id, render, density });
          if (render.status !== "checked") issues.push(`${outline.id}: render measurement unavailable`);
          issues.push(...render.issues.map((issue: string) => `${outline.id}: ${issue}`),
            ...density.issues.map((issue: string) => `${outline.id}: ${issue}`));
          if (!(scene.actions ?? []).some((action) => action.type === "speech" && action.text.trim())) {
            issues.push(`${outline.id}: missing teaching narration`);
          }
        }
        if (scene.content.type === "quiz") {
          const normalized = quiz.normalizeQuizQuestions(scene.content.questions, { allowedKnowledgePointIds: outline.knowledgePointIds });
          issues.push(...normalized.issues.map((issue: string) => `${outline.id}: ${issue}`));
          const coverage = new Set(scene.content.questions.flatMap((question) => question.knowledgePointIds ?? []));
          for (const id of outline.knowledgePointIds ?? []) if (!coverage.has(id)) issues.push(`${outline.id}: missing quiz coverage ${id}`);
          const actions = scene.actions ?? [];
          const phases = actions.flatMap((action) => action.type === "speech" && action.quizNarrationPhase ? [action.quizNarrationPhase] : []);
          const ordered = phases.filter((phase, index) => phase !== phases[index - 1]);
          const submit = actions.findIndex((action) => action.type === "speech" && "activityPausePurpose" in action && action.activityPausePurpose === "quiz-submit");
          const understood = actions.findIndex((action) => action.type === "speech" && "activityPausePurpose" in action && action.activityPausePurpose === "quiz");
          const introEnd = actions.findLastIndex((action) => action.type === "speech" && action.quizNarrationPhase === "intro");
          const reviewStart = actions.findIndex((action) => action.type === "speech" && action.quizNarrationPhase === "review-guidance");
          const reviewEnd = actions.findLastIndex((action) => action.type === "speech" && action.quizNarrationPhase === "review-guidance");
          const handoff = actions.findIndex((action) => action.type === "speech" && action.quizNarrationPhase === "handoff");
          if (ordered.join(",") !== "intro,review-guidance,handoff" || !(introEnd < submit && submit < reviewStart
            && reviewEnd < understood && understood < handoff)) issues.push(`${outline.id}: quiz three-phase gates invalid`);
          checked.push({ stage: "quiz", outlineId: outline.id, questions: scene.content.questions.length, phases: ordered, submit, understood });
        }
      }
      const visual = theme.auditCourseVisualConsistency(outlines, generated.scenes);
      checked.push({ stage: "course-visual", visual });
      if (!visual.passed) issues.push("course visual consistency failed");
    }
    await save("common-quality-acceptance.json", { status: issues.length ? "failed" : "passed", modelCalls: 0, issues, checked,
      mediaStatus: "not-generated", completeCourseVerified: false });
    if (issues.length) process.exitCode = 1;
  } finally {
    for (const [module, name] of [
      ["src/lib/openmaic/generation/slide-spatial-measurement.ts", "closeSpatialMeasurementBrowser"],
      ["src/lib/openmaic/generation/slide-layout-audit.ts", "closeSlideLayoutAuditBrowser"],
    ]) { const measurement = await load(module); await measurement[name]?.(); }
    await disconnect();
  }
}

async function dispatchWorker(output: string, run: Manifest["runs"][number], code: Manifest["code"]["new"], acceptance = false): Promise<number> {
  await fs.mkdir(run.directory, { recursive: true });
  const log = await fs.open(path.join(run.directory, "worker.log"), "a", 0o600);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repository, "node_modules/tsx/dist/cli.mjs"),
        "--tsconfig", path.join(code.directory, "verification-tsconfig.json"), script,
        acceptance ? "--acceptance-worker" : "--worker", "--output", output, "--run-id", run.id, ...(process.argv.includes("--deployment-secrets") ? ["--deployment-secrets"] : [])], {
        cwd: code.directory, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=import` },
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
  } finally { await log.close(); }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("首稿质量/成本只读比较（生产数据库禁止写入，源码和所有结果隔离保存）。\n"
      + "准备：NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-course-first-pass-cost.ts --prepare --snapshot-dir <设计快照> --page-snapshot-dir <页面快照> --output <.openpbl-runtime目录> --deployment-secrets\n"
      + "干跑：... --output <目录> --dry-run\n真实运行：... --output <目录> --run [--sample teaching-theory|resource-package|long-list-branch] [--arm baseline|new] [--repetition 1|2|3] [--stage knowledge|duration|outline|pages|all] [--mode end-to-end|frozen-stages] --deployment-secrets\n"
      + "汇总：... --output <目录> --report [--rates-file <带source/effectiveAt/currency的费率JSON>]\n"
      + "复用已验收设计仅生成页面：... --stage pages --mode frozen-stages --continue-pages-from <含continuation-input.json的原run目录>\n"
      + "默认三类×两方案×三次，失败调用纳入费用；阶段探针和未验证费率永远不能宣称整课120%达标。媒体开关原样保留；不生成图片或TTS资产，资产成本另计。");
    return;
  }
  const output = path.resolve(arg("--output") ?? `.openpbl-runtime/course-first-pass-cost/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (!output.startsWith(path.join(repository, ".openpbl-runtime") + path.sep)) throw new Error("所有验证输出必须在本仓库 .openpbl-runtime 隔离目录内");
  if (process.argv.includes("--worker")) { await worker(output); return; }
  if (process.argv.includes("--acceptance-worker")) { await acceptanceWorker(output); return; }
  await initializeReadOnlyClients();
  try {
    let manifest = process.argv.includes("--prepare") ? await prepare(output) : await json<Manifest>(path.join(output, "manifest.json"));
    if (process.argv.includes("--dry-run") || process.argv.includes("--prepare")) {
      const estimate = manifest.fixtures.map((fixture) => ({ sampleId: fixture.id, model: fixture.policy.modelString,
        thinking: fixture.policy.thinking, aiDurationSec: fixture.aiDurationSec, frozenPages: fixture.pageInput.sceneOutlines?.length,
        sectionId: fixture.sectionId ?? null, rawEvidenceCharacters: JSON.stringify(fixture.request.textbookEvidence ?? {}).length,
        plannedRuns: 6, billingCost: "unknown-without-provider-rates", baselineApi: "89f08ce: knowledge once → duration once → OpenMAIC outline once",
        limitations: fixture.sectionId ? ["完整困难小节必须有固定身份；新大纲改名时停止，不重新选择样本"] : [] }));
      await writeJsonAtomic(path.join(output, "dry-run.json"), { paidCalls: 0, estimate,
        plannedRuns: manifest.runs.length, sourceSha256: manifest.sourceSha256,
        implementationComparison: "early-baseline API generation with unchanged source; current acceptance must be applied to final outputs before rollout" });
      console.log(JSON.stringify({ phase: "prepared", output, paidCalls: 0, plannedRuns: manifest.runs.length, estimate }));
    }
    if (process.argv.includes("--run")) {
      const sample = arg("--sample"), arm = arg("--arm"), repetition = arg("--repetition");
      const stage = arg("--stage") ?? "all", mode = arg("--mode") ?? "end-to-end";
      const continuation = arg("--continue-pages-from");
      if (continuation && (stage !== "pages" || mode !== "frozen-stages")) throw new Error("--continue-pages-from 仅适用于 pages/frozen-stages");
      if (!["knowledge", "duration", "outline", "pages", "all"].includes(stage) || !["end-to-end", "frozen-stages"].includes(mode)) throw new Error("无效 stage/mode");
      let selected = manifest.runs.filter((run) => run.stage === "all" && run.mode === "end-to-end"
        && (!sample || run.sampleId === sample) && (!arm || run.arm === arm)
        && (!repetition || run.repetition === Number(repetition)));
      if (!selected.length) throw new Error("筛选条件不含运行样本");
      if (stage !== "all" || mode !== "end-to-end") {
        selected = selected.map((original) => {
          const id = `${original.id}-probe-${stage}-${mode}`;
          const prior = manifest.runs.find((run) => run.id === id);
          if (prior) return prior;
          const probe: Manifest["runs"][number] = { ...original, id, directory: path.join(output, "runs", id),
            stage: stage as FirstPassCostRun["stage"], mode: mode as FirstPassCostRun["mode"], status: "planned",
            qualityPassed: false, usage: [], stageResults: [],
            ...(continuation ? { sourceRunDirectory: path.resolve(continuation) } : {}) };
          if (probe.sourceRunDirectory && !probe.sourceRunDirectory.startsWith(path.join(repository, ".openpbl-runtime") + path.sep)) {
            throw new Error("续跑来源必须在 .openpbl-runtime 隔离目录内");
          }
          manifest.runs.push(probe);
          return probe;
        });
      }
      for (const run of selected) {
        // Finished/failed runs never silently replay. A fresh experiment gets
        // a new output directory rather than replacing a better saved result.
        if (run.status !== "planned") continue;
        run.stage = stage as FirstPassCostRun["stage"];
        run.mode = mode as FirstPassCostRun["mode"];
        run.status = "running";
        await writeJsonAtomic(path.join(output, "manifest.json"), manifest);
        console.log(JSON.stringify({ phase: "run-start", runId: run.id, stage, mode, output: run.directory }));
        const exitCode = await dispatchWorker(output, run, manifest.code[run.arm]);
        const result = await json<Manifest["runs"][number]>(path.join(run.directory, "run.json")).catch(() => null);
        if (result) Object.assign(run, result);
        else { run.status = "failed"; run.stageResults = [{ stage, passed: false, firstPass: false, issues: [`worker exit ${exitCode}，未返回成果`] }]; }
        if (result?.status === "complete") {
          const acceptanceCode = await dispatchWorker(output, run, manifest.code.new, true);
          const acceptance = await json<{ status: string; issues: string[] }>(path.join(run.directory, "common-quality-acceptance.json")).catch(() => null);
          if (acceptanceCode !== 0 || acceptance?.status !== "passed") {
            run.status = "failed"; run.qualityPassed = false;
            run.stageResults.push({ stage: "common-quality", passed: false, firstPass: false,
              issues: acceptance?.issues ?? ["共同硬质量检查未完成"] });
          }
          await writeJsonAtomic(path.join(run.directory, "accepted-run.json"), run);
        }
        await writeJsonAtomic(path.join(output, "manifest.json"), manifest);
        console.log(JSON.stringify({ phase: "run-finished", runId: run.id, status: run.status, providerCalls: run.usage.length,
          totalTokens: run.usage.reduce((sum, call) => sum + call.totalTokens, 0), issues: run.stageResults.flatMap((item) => item.issues) }));
      }
      manifest = await json<Manifest>(path.join(output, "manifest.json"));
    }
    const rates = arg("--rates-file") ? await json<FirstPassBillingRates>(path.resolve(arg("--rates-file")!)) : undefined;
    await writeJsonAtomic(path.join(output, "comparison-report.json"), { sourceSha256: manifest.sourceSha256,
      code: manifest.code, ...summarizeFirstPassCostRuns(manifest.runs, rates),
      limits: ["没有可靠输入/输出/缓存费率或provider计量时，费用上限未验证", "阶段探针不能证明整课通过率", "图片/TTS资产费用不包含在作者费用比较"] });
  } finally { await disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}

// Share only isolation and read-only setup with bounded production probes.
export { freezeCode, initializeReadOnlyClients, disconnect };

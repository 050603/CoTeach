import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { QuickDesignRequest } from "../src/lib/course-design/job-runner";
import type { TeachingBlueprintValidation } from "../src/lib/course-design/teaching-blueprint";

type SnapshotCheckpoint = {
  id: string;
  step: string;
  state: {
    schemaVersion?: number;
    status?: string;
    blueprint?: unknown;
    bestCandidate?: unknown;
    rawResponse?: string;
    validationIssues?: string[];
    inputFingerprint?: string;
    contentFingerprint?: string;
    modelFingerprint?: string;
    repairAttempts?: number;
    preserveAcceptedPagePlans?: boolean;
  };
};

type SnapshotJob = {
  id: string;
  jobType: string;
  targetId: string;
  request: QuickDesignRequest;
  checkpoints: SnapshotCheckpoint[];
};

type SnapshotTemplate = {
  id: string;
  versions: Array<{ id: string; version: number; snapshot: unknown }>;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 需要参数值`);
  return value;
}

async function writeJson(file: string, value: unknown): Promise<{ file: string; sha256: string }> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  return { file, sha256: createHash("sha256").update(body).digest("hex") };
}

async function readSnapshots<T>(directory: string, filename: string): Promise<{
  records: T[];
  file: string;
  sha256: string;
}> {
  const file = path.join(directory, filename);
  const body = await fs.readFile(file, "utf8");
  const records: unknown = JSON.parse(body);
  if (!Array.isArray(records)) throw new Error(`${filename} 必须是快照记录数组`);
  return { records: records as T[], file, sha256: createHash("sha256").update(body).digest("hex") };
}

/** Install guarded clients before importing the production pipeline modules. */
async function createReadOnlyDatabaseClient(databaseUrl?: string): Promise<PrismaClient> {
  const { PrismaClient } = await import("@prisma/client");
  const readActions = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
  return new PrismaClient({ ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}), log: ["error"] }).$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        if (!readActions.has(operation)) throw new Error(`只读重放禁止数据库操作：${model ?? "raw"}.${operation}`);
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
}

const redactedValues = new Set<string>();

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactedValues) if (value) message = message.split(value).join("[redacted]");
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, "[redacted-url]@");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("只读重放教学蓝图，不保存课程或任务、不发布课堂。\n用法：NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-course-design-recovery.ts --snapshot-dir <目录> [--output <目录>] [--deployment-secrets] [--repair]\n快照目录需含 failed-jobs.json 与 failed-templates.json。默认仅校验已有草稿；--repair 使用原任务正式模型与服务器推理设置局部修复。输出 manifest.json 中的 SHA256 可用 sha256sum 核对。教材资源只读解析需要数据库配置；--deployment-secrets 从 OPENPBL_SECRET_DIR 或 deploy/secrets 读取配置。");
    return;
  }
  const knownArguments = new Set(["--snapshot-dir", "--output", "--deployment-secrets", "--repair"]);
  for (const value of process.argv.slice(2)) {
    if (value.startsWith("--") && !knownArguments.has(value)) throw new Error(`未知参数：${value}`);
  }
  const snapshotArgument = argument("--snapshot-dir");
  if (!snapshotArgument) throw new Error("请使用 --snapshot-dir 指定失败任务与课程快照目录");
  const snapshotDirectory = path.resolve(snapshotArgument);
  const outputDirectory = path.resolve(argument("--output")
    ?? `.openpbl-runtime/course-design-recovery/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (outputDirectory === snapshotDirectory) throw new Error("输出目录不能覆盖输入快照目录");
  const repair = process.argv.includes("--repair");
  if (process.argv.includes("--deployment-secrets")) {
    const secretDirectory = process.env.OPENPBL_SECRET_DIR || path.resolve("deploy/secrets");
    for (const [key, filename] of [
      ["DATABASE_URL", "database_url.txt"],
      ["PROVIDER_ENCRYPTION_KEY", "provider_encryption_key.txt"],
    ] as const) {
      process.env[key] = (await fs.readFile(path.join(secretDirectory, filename), "utf8")).trim();
    }
  }
  for (const key of ["DATABASE_URL", "PROVIDER_CONFIG_DATABASE_URL", "PROVIDER_ENCRYPTION_KEY"]) {
    if (process.env[key]) redactedValues.add(process.env[key]!);
  }
  const jobs = await readSnapshots<SnapshotJob>(snapshotDirectory, "failed-jobs.json");
  const templates = await readSnapshots<SnapshotTemplate>(snapshotDirectory, "failed-templates.json");
  const templateById = new Map(templates.records.map((template) => [template.id, template]));
  const candidates = jobs.records.filter((job) => job.jobType === "COURSE_DESIGN"
    && job.checkpoints?.some((checkpoint) => checkpoint.step === "teaching-blueprint"));
  if (!candidates.length) throw new Error("快照中没有可重放的教学蓝图任务");

  globalThis.__openPblPrisma = await createReadOnlyDatabaseClient();
  const providerDatabaseUrl = process.env.PROVIDER_CONFIG_DATABASE_URL?.trim();
  if (providerDatabaseUrl && providerDatabaseUrl !== process.env.DATABASE_URL) {
    globalThis.__openPblProviderPrisma = await createReadOnlyDatabaseClient(providerDatabaseUrl);
  }
  const { prisma, providerPrisma } = await import("../src/lib/db/client");
  try {
    const {
      assertAiOutlineKnowledgeCoverage,
      prepareTeachingBlueprintInput,
      restoreTeachingBlueprintRepairSource,
    } = await import("../src/lib/course-design/job-runner");
    const { createPblTemplateCourse, decodePblTemplate } = await import("../src/lib/platform/pbl-template");
    const { isNewSystemAiTimingPlan } = await import("../src/lib/classroom/new-system-course");
    const {
      assertSourceSequencesInOutlines,
      bindRequiredTextbookFiguresToBlueprint,
      bindRequiredTextbookFiguresToOutlines,
      findBlueprintFigureSequenceIssues,
    } = await import("../src/lib/textbook/course-visual-binding");
    const {
      adaptTeachingBlueprintResourceCapabilities,
      buildTeachingBlueprintRepairPrompt,
      generateTeachingBlueprint,
      legacyTeachingBlueprintInputFingerprint,
      revalidateStoredTeachingBlueprint,
      TEACHING_BLUEPRINT_SCHEMA_VERSION,
      teachingBlueprintContentFingerprint,
      teachingBlueprintInputFingerprint,
      teachingBlueprintToOutlines,
      validateTeachingBlueprintBudget,
      validateTeachingBlueprintDraft,
    } = await import("../src/lib/course-design/teaching-blueprint");
    const { fingerprintGenerationValue } = await import("../src/lib/course-generation/page-checkpoints");
    const { applyVersionedOutlinePlanToCourseContent } = await import("../src/lib/course-generation/job-runner");
    const { prepareTeachingPageCapacity } = await import("../src/lib/openmaic/generation/teaching-page-preflight");
    const { ZH_CN_COURSE_LANGUAGE_DIRECTIVE } = await import("../src/lib/openmaic/generation/course-language");
    const {
      COURSE_EXECUTION_BUDGET_VERSION,
      COURSE_OUTPUT_BUDGET_VERSION,
      createCourseOutputBudget,
      resolveCourseExecutionBudgetOptions,
    } = await import("../src/lib/openmaic/generation/course-output-budget");
    const { resolveLlmRequestTimeoutMs } = await import("../src/lib/llm/request-policy");
    const { initializeServerProviderConfig } = await import("../src/lib/openmaic/server/provider-config");
    const { resolveModel } = await import("../src/lib/openmaic/server/resolve-model");
    const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import("../src/lib/openmaic/server/course-generation-ai-call");
    if (repair) await initializeServerProviderConfig();

    const summaries: Array<Record<string, unknown>> = [];
    for (const job of candidates) {
      const courseOutput = path.join(outputDirectory, job.targetId, job.id);
      await fs.mkdir(courseOutput, { recursive: true });
      const artifacts = new Map<string, { file: string; sha256: string }>();
      let modelCalls = 0;
      let savedCandidatePreserved = false;
      const save = async (filename: string, value: unknown) => {
        const artifact = await writeJson(path.join(courseOutput, filename), value);
        artifacts.set(artifact.file, artifact);
      };
      try {
        if (job.targetId !== job.request.courseId) throw new Error("任务目标与请求 courseId 不一致");
        const template = templateById.get(job.targetId);
        const version = template?.versions.slice().sort((left, right) => right.version - left.version)[0];
        if (!version) throw new Error("找不到任务对应的课程版本快照");
        const design = decodePblTemplate(version.snapshot);
        if (!design) throw new Error("课程快照不符合 PBL 课程契约");
        const course = createPblTemplateCourse(job.targetId, design);
        const content = course.content;
        const request = job.request;
        const checkpoint = job.checkpoints.find((entry) => entry.step === "teaching-blueprint")!;
        const state = checkpoint.state;
        const savedCandidate = state.bestCandidate ?? state.blueprint;
        if (!savedCandidate) throw new Error("教学蓝图检查点没有已审核草稿；不能把修复补丁当作整份蓝图");
        savedCandidatePreserved = true;
        const aiDurationMin = content.moduleTimingPlan?.allocations
          .filter((allocation) => allocation.stageKey === "ai-learning")
          .reduce((sum, allocation) => sum + allocation.durationMin, 0) ?? 0;
        if (aiDurationMin <= 0 || !isNewSystemAiTimingPlan(content.moduleTimingPlan, course.hours, content.stagePlan)) {
          throw new Error("课程快照缺少已确认的知识讲授时间预算");
        }
        await save("saved-candidate.json", savedCandidate);
        const resolved = repair ? await resolveModel({ modelString: request.generationModelString, stage: "scene-outlines-stream" }) : undefined;
        if (resolved?.apiKey) redactedValues.add(resolved.apiKey);
        const executionBudget = resolveCourseExecutionBudgetOptions();
        const currentModelFingerprint = resolved ? fingerprintGenerationValue({
          model: resolved.modelString,
          thinking: resolved.thinkingConfig ?? null,
          outputWindow: resolved.modelInfo?.outputWindow ?? null,
          outputBudgetPolicy: COURSE_OUTPUT_BUDGET_VERSION,
          executionBudgetPolicy: COURSE_EXECUTION_BUDGET_VERSION,
          executionBudget,
        }) : state.modelFingerprint;
        if (!currentModelFingerprint) throw new Error("原任务检查点缺少模型指纹，不能忠实重放");
        const { input, textbookFigureResources: resources, legacyFingerprints } = await prepareTeachingBlueprintInput(
          course, content, request, aiDurationMin, currentModelFingerprint,
        );
        await save("textbook-resources.json", resources);
        const inputFingerprint = teachingBlueprintInputFingerprint(input);
        const contentFingerprint = teachingBlueprintContentFingerprint(input);
        const repairSource = restoreTeachingBlueprintRepairSource(
          state, inputFingerprint, contentFingerprint, legacyTeachingBlueprintInputFingerprint(input),
          currentModelFingerprint, [legacyFingerprints.contentFingerprint], input,
        );
        await save("teaching-blueprint-input.json", input);
        await save("input-audit.json", {
          jobId: job.id, courseId: course.id, templateVersionId: version.id,
          requestedModel: request.generationModelString,
          resolvedModel: resolved?.modelString,
          thinking: resolved?.thinkingConfig,
          modelFingerprintSource: resolved ? "current-server-resolution" : "captured-checkpoint",
          savedCandidatePreserved,
          productionResumeCompatible: Boolean(repairSource),
          legacyFingerprints,
          checkpoint: { inputFingerprint: state.inputFingerprint, contentFingerprint: state.contentFingerprint, modelFingerprint: state.modelFingerprint },
          current: { inputFingerprint, contentFingerprint, modelFingerprint: currentModelFingerprint },
          matchesCheckpoint: {
            input: state.inputFingerprint === inputFingerprint,
            content: state.contentFingerprint === contentFingerprint,
            legacySourceInput: state.inputFingerprint === legacyFingerprints.inputFingerprint,
            legacySourceContent: state.contentFingerprint === legacyFingerprints.contentFingerprint,
            model: state.modelFingerprint === currentModelFingerprint,
          },
          sourceSnapshots: { jobsSha256: jobs.sha256, templatesSha256: templates.sha256 },
          courseContentFingerprint: fingerprintGenerationValue(content),
          savedCandidateFingerprint: fingerprintGenerationValue(savedCandidate),
          inputValueFingerprint: fingerprintGenerationValue(input),
        });
        const validation = typeof savedCandidate === "object" && savedCandidate !== null
          && (savedCandidate as { schemaVersion?: unknown }).schemaVersion === TEACHING_BLUEPRINT_SCHEMA_VERSION
          ? revalidateStoredTeachingBlueprint(savedCandidate as Parameters<typeof revalidateStoredTeachingBlueprint>[0], input)
          : validateTeachingBlueprintDraft(savedCandidate, input);
        await save("validation-before.json", { issues: validation.issues, storedIssues: state.validationIssues ?? [] });
        if (validation.issues.length) {
          await save("repair-prompt.json", buildTeachingBlueprintRepairPrompt(
            input, savedCandidate, validation.issues, 2, repairSource?.repairFailure,
            repairSource?.preserveAcceptedPagePlans === true,
          ));
        }
        let blueprint = validation.blueprint;
        const validationHistory: TeachingBlueprintValidation[] = [];
        if (!blueprint && resolved) {
          if (!repairSource?.candidate) throw new Error("原草稿的基础内容或模型指纹与正式恢复输入不兼容，未调用模型或重新生成课程");
          const budget = createCourseOutputBudget({ resource: "planning", modelOutputWindow: resolved.modelInfo?.outputWindow, thinking: resolved.thinkingConfig });
          const baseAiCall = createCourseGenerationAiCall({
            model: resolved.model, vision: false, source: "verify-course-design-recovery",
            outputBudget: (system, prompt) => Math.min(131_072, budget(system, prompt)),
            executionBudget, temperature: 0.2, thinking: resolved.thinkingConfig,
            timeoutMs: resolveLlmRequestTimeoutMs("long-generation"), maxRetries: 2, streamResponse: true,
          });
          const transportAttempts: Array<Record<string, unknown>> = [];
          const aiCall = withCourseGenerationAiCallContext(baseAiCall, {
            attemptsStarted: 0,
            onAttemptStarting: async (attempt) => {
              transportAttempts.push(attempt);
              await save("transport-attempts.json", transportAttempts);
            },
          });
          blueprint = await generateTeachingBlueprint(input, async (system, prompt, images) => {
            const call = ++modelCalls;
            await save(`model-call-${call}-prompt.json`, { system, user: prompt });
            console.log(JSON.stringify({ phase: "repair", courseId: course.id, jobId: job.id, model: resolved.modelString, call }));
            const response = await aiCall(system, prompt, images);
            await save(`model-call-${call}-response.json`, { response, sha256: createHash("sha256").update(response).digest("hex") });
            return response;
          }, {
            repairFrom: repairSource,
            resourceCapabilities: {
              imageGenerationEnabled: request.options?.enableImageGeneration === true,
              videoGenerationEnabled: request.options?.enableVideoGeneration === true,
            },
            onValidation: async (result) => {
              validationHistory.push(result);
              await save("validation-history.json", validationHistory);
              if (result.candidate) await save("latest-candidate.json", result.candidate);
            },
          });
        }
        if (!blueprint) {
          const summary = { courseId: course.id, jobId: job.id, status: "invalid", modelCalls, savedCandidatePreserved, issues: validation.issues };
          await save("quality-structure.json", summary);
          await writeJson(path.join(courseOutput, "manifest.json"), { ...summary, artifacts: [...artifacts.values()] });
          summaries.push(summary);
          console.log(JSON.stringify({ phase: "validation", ...summary }));
          continue;
        }
        blueprint = adaptTeachingBlueprintResourceCapabilities(blueprint, {
          imageGenerationEnabled: request.options?.enableImageGeneration === true,
          videoGenerationEnabled: request.options?.enableVideoGeneration === true,
        });
        let boundBlueprint = bindRequiredTextbookFiguresToBlueprint(blueprint, resources, input.sourceSequences);
        let outlines = bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(boundBlueprint, ZH_CN_COURSE_LANGUAGE_DIRECTIVE), resources, input.sourceSequences);
        await save("scene-outlines-before-capacity.json", outlines);
        const capacity = await prepareTeachingPageCapacity(outlines, {
          lockedOutlineIds: state.preserveAcceptedPagePlans ? outlines.map((page) => page.id) : [],
          explanationNodes: boundBlueprint.sections.flatMap((section) => section.units
            .flatMap((unit) => unit.explanationNodes ?? [])),
          resourceSequences: Object.fromEntries(resources.flatMap((resource) =>
            resource.orderedSteps?.length ? [[resource.id, resource.orderedSteps]] : [])),
          resourceDimensions: Object.fromEntries(resources.flatMap((resource) => resource.width && resource.height
            ? [[resource.id, { width: resource.width, height: resource.height }]] : [])),
        });
        await save("design-page-capacity.json", capacity);
        if (capacity.changed) {
          const synchronized = applyVersionedOutlinePlanToCourseContent({ ...content,
            teachingBlueprint: boundBlueprint, _openmaicSceneOutlines: outlines }, capacity.outlines);
          const rechecked = revalidateStoredTeachingBlueprint(synchronized.teachingBlueprint!, input);
          if (!rechecked.blueprint) throw new Error(`确定性分页后的蓝图验收：${rechecked.issues.join("；")}`);
          boundBlueprint = synchronized.teachingBlueprint!;
          outlines = capacity.outlines;
        }
        const budgetIssues = validateTeachingBlueprintBudget(boundBlueprint, outlines);
        const figureIssues = findBlueprintFigureSequenceIssues(boundBlueprint, [
          ...(input.textbookFigures ?? []).map((figure) => ({ ...figure, scope: "single-page" as const })),
          ...(input.sourceSequences ?? []),
        ]);
        assertAiOutlineKnowledgeCoverage(outlines, content.knowledgePoints);
        assertSourceSequencesInOutlines(outlines, input.sourceSequences ?? [], resources);
        await save("teaching-blueprint.json", boundBlueprint);
        await save("scene-outlines.json", outlines);
        const summary = {
          courseId: course.id, jobId: job.id, status: budgetIssues.length || figureIssues.length ? "invalid" : "validated", modelCalls, savedCandidatePreserved,
          issues: [...budgetIssues, ...figureIssues.map((issue) => issue.detail)],
          sectionCount: boundBlueprint.sections.length,
          unitCount: boundBlueprint.sections.reduce((sum, section) => sum + section.units.length, 0),
          teachingPageCount: boundBlueprint.sections.reduce((sum, section) => sum + section.pages.length, 0),
          outlineCount: outlines.length, budget: boundBlueprint.budget,
          capacityPassed: true,
          deterministicPaginationChanged: capacity.changed,
          blueprintFingerprint: fingerprintGenerationValue(boundBlueprint), outlinesFingerprint: fingerprintGenerationValue(outlines),
        };
        await save("quality-structure.json", summary);
        await writeJson(path.join(courseOutput, "manifest.json"), { ...summary, artifacts: [...artifacts.values()] });
        summaries.push(summary);
        console.log(JSON.stringify({ phase: "validation", ...summary }));
      } catch (error) {
        const summary = { courseId: job.targetId, jobId: job.id, status: "failed", modelCalls, savedCandidatePreserved, error: errorMessage(error) };
        await save("failure.json", summary);
        await writeJson(path.join(courseOutput, "manifest.json"), { ...summary, artifacts: [...artifacts.values()] });
        summaries.push(summary);
        console.error(JSON.stringify(summary));
      }
    }
    await writeJson(path.join(outputDirectory, "manifest.json"), {
      mode: repair ? "repair" : "validation-only", completedAt: new Date().toISOString(),
      databaseAccess: "read-only", modelCallsEnabled: repair,
      snapshots: { jobs: { file: jobs.file, sha256: jobs.sha256 }, templates: { file: templates.file, sha256: templates.sha256 } },
      results: summaries,
    });
    console.log(JSON.stringify({ phase: "complete", outputDirectory, results: summaries.map(({ courseId, status }) => ({ courseId, status })) }));
    if (summaries.some((summary) => summary.status !== "validated")) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    if (providerPrisma !== prisma) await providerPrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

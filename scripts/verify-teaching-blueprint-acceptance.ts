import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function textContent(value: unknown): string[] {
  if (typeof value === "string") {
    const plain = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return plain ? [plain] : [];
  }
  if (Array.isArray(value)) return value.flatMap(textContent);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    ["src", "url", "audioUrl", "id", "type", "color", "fontFamily"].includes(key) ? [] : textContent(child),
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--deployment-secrets")) {
    const directory = process.env.OPENPBL_SECRET_DIR || path.resolve("deploy/secrets");
    for (const [key, filename] of [
      ["DATABASE_URL", "database_url.txt"],
      ["PROVIDER_ENCRYPTION_KEY", "provider_encryption_key.txt"],
    ] as const) {
      process.env[key] = (await fs.readFile(path.join(directory, filename), "utf8")).trim();
    }
  }

  const outputDirectory = path.resolve(
    argument("--output") || `.openpbl-runtime/teaching-blueprint-acceptance/${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await fs.mkdir(outputDirectory, { recursive: true });

  const { initializeServerProviderConfig } = await import("../src/lib/openmaic/server/provider-config");
  await initializeServerProviderConfig();
  const { resolveModel } = await import("../src/lib/openmaic/server/resolve-model");
  const { createCourseGenerationAiCall } = await import("../src/lib/openmaic/server/course-generation-ai-call");
  const {
    generateTeachingBlueprint,
    teachingBlueprintInputFingerprint,
    teachingBlueprintToOutlines,
    validateTeachingBlueprintBudget,
  } = await import("../src/lib/course-design/teaching-blueprint");
  const { sanitizeTeachingReferenceText } = await import("../src/lib/course-design/job-runner");
  const { generateClassroom } = await import("../src/lib/openmaic/server/classroom-generation");
  const {
    generateClassroomAssets,
    summarizeTeachingTimingAudit,
  } = await import("../src/lib/openmaic/server/classroom-asset-generation");

  const rawSource = [
    "训练集用于拟合模型中的参数，测试集用于在训练完成后检查模型面对未参与训练的数据时的表现。",
    "同一条样本若同时影响训练过程和最终测试，会使测试结果过于乐观，这属于数据泄漏。",
    "测试结果描述的是模型在与测试数据同分布的新数据上的表现，不能自动代表所有真实场景。",
    "证据状态：PARTIAL",
    "**PARTIAL**",
    "审查记录：该字段仅供教师管理，不进入课程。",
  ].join("\n");
  const sourceContext = sanitizeTeachingReferenceText(rawSource);
  if (/\bPARTIAL\b|证据状态|审查记录/i.test(sourceContext)) {
    throw new Error("教学上下文净化未移除管理标签");
  }

  const knowledgePoints = [
    {
      id: "kp-train-test",
      name: "训练集与测试集",
      description: "理解训练数据与测试数据承担的不同作用。",
      masteryBoundary: "能说明为什么必须分开，并能判断给定划分是否合理。",
      level: "core" as const,
      groupId: "model-evaluation",
      groupName: "模型训练与评价",
    },
    {
      id: "kp-test-meaning",
      name: "测试结果的含义",
      description: "解释测试指标能够支持和不能支持的结论。",
      masteryBoundary: "能结合数据分布和任务情境解释测试结果的边界。",
      level: "application" as const,
      groupId: "model-evaluation",
      groupName: "模型训练与评价",
    },
    {
      id: "kp-data-leakage",
      name: "数据泄漏",
      description: "识别训练与评价过程中提前使用测试信息的情况。",
      masteryBoundary: "能在案例中定位泄漏路径并解释它为何造成误判。",
      level: "application" as const,
      groupId: "model-evaluation",
      groupName: "模型训练与评价",
    },
  ];
  const knowledgeGraph = {
    nodes: knowledgePoints.map((point) => ({
      id: point.id,
      label: point.name,
      description: point.description,
      level: point.level,
      instructionalRole: "lesson" as const,
      masteryBoundary: point.masteryBoundary,
      groupId: point.groupId,
      groupName: point.groupName,
    })),
    edges: [
      {
        id: "edge-train-test-to-meaning",
        source: "kp-train-test",
        target: "kp-test-meaning",
        label: "先理解数据角色，再解释测试结果",
        type: "required-prerequisite" as const,
        strength: "required" as const,
        rationale: "测试结果的解释依赖对训练集与测试集职责的区分。",
      },
      {
        id: "edge-train-test-to-leakage",
        source: "kp-train-test",
        target: "kp-data-leakage",
        label: "由数据边界识别泄漏",
        type: "required-prerequisite" as const,
        strength: "required" as const,
        rationale: "只有先明确数据边界，才能判断测试信息是否提前进入训练。",
      },
    ],
  };
  const resolved = await resolveModel({ stage: "generate-classroom" });
  const blueprintInput = {
    generationModelFingerprint: resolved.modelString,
    courseTitle: "让测试真正可信：训练集、测试集与数据泄漏",
    subject: "信息科技",
    grade: "高中一年级",
    learningObjectives: [
      "解释训练集和测试集的分工及分开使用的原因",
      "借助完整案例判断测试结果代表什么",
      "识别数据泄漏并说明它如何制造虚假的高分",
    ],
    projectContext: "学生正在比较两个校园垃圾图片分类方案，需要选择更可信的模型。",
    knowledgePoints,
    knowledgeGraph,
    totalDurationSec: 30 * 60,
    assessmentMode: "adaptive" as const,
    generationMode: "standard" as const,
    teacherBrief: "使用同一个校园垃圾分类案例贯穿讲解；先完整讲授，再进行低负担检测。",
    sourceContext,
  };
  const blueprintAiCall = createCourseGenerationAiCall({
    model: resolved.model,
    vision: false,
    source: "verify-teaching-blueprint-acceptance",
    maxOutputTokens: resolved.modelInfo?.outputWindow,
    thinking: resolved.thinkingConfig,
    timeoutMs: 180_000,
    maxRetries: 2,
    streamResponse: true,
    streamMaxDurationMs: 600_000,
  });
  const manifest = {
    startedAt: new Date().toISOString(),
    model: resolved.modelString,
    inputFingerprint: teachingBlueprintInputFingerprint(blueprintInput),
    inputSha256: createHash("sha256").update(JSON.stringify(blueprintInput)).digest("hex"),
    rawSourceRetainedForTeacherAudit: rawSource,
    sanitizedTeachingSource: sourceContext,
  };
  await writeJson(path.join(outputDirectory, "manifest.json"), manifest);
  console.log(JSON.stringify({ phase: "blueprint", model: resolved.modelString, outputDirectory }));

  const expectedBlueprintFingerprint = teachingBlueprintInputFingerprint(blueprintInput);
  const cachedBlueprint = process.argv.includes("--reuse-blueprint")
    ? await readJson<Awaited<ReturnType<typeof generateTeachingBlueprint>>>(path.join(outputDirectory, "teaching-blueprint.json"))
    : undefined;
  const blueprint = cachedBlueprint?.schemaVersion === 1
    ? { ...cachedBlueprint, inputFingerprint: expectedBlueprintFingerprint }
    : await generateTeachingBlueprint(blueprintInput, blueprintAiCall);
  const outlines = teachingBlueprintToOutlines(blueprint, "全部学生可见内容和讲解使用简体中文。");
  const budgetIssues = validateTeachingBlueprintBudget(blueprint, outlines);
  if (budgetIssues.length > 0) throw new Error(`教学蓝图预算检查失败：${budgetIssues.join("；")}`);
  await writeJson(path.join(outputDirectory, "teaching-blueprint.json"), blueprint);
  await writeJson(path.join(outputDirectory, "scene-outlines.json"), outlines);

  console.log(JSON.stringify({ phase: "classroom", pages: outlines.length }));
  const preparedOutlinesFile = path.join(outputDirectory, "prepared-outlines.json");
  const preparedOutlines = process.argv.includes("--resume")
    ? await readJson<typeof outlines>(preparedOutlinesFile)
    : undefined;
  const checkpointFile = (outlineId: string, stage: string) => path.join(
    outputDirectory,
    "page-checkpoints",
    `${outlineId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${stage}.json`,
  );
  type GeneratedClassroom = Awaited<ReturnType<typeof generateClassroom>>;
  let classroomId: string;
  let classroomStage: GeneratedClassroom["stage"];
  let classroomScenes: GeneratedClassroom["scenes"];
  let classroomQualityReport: GeneratedClassroom["qualityReport"] | undefined;
  let timingAudit: Awaited<ReturnType<typeof generateClassroomAssets>>;
  const existingClassroomId = argument("--classroom-id");
  if (existingClassroomId) {
    const persisted = await readJson<Pick<GeneratedClassroom, "id" | "stage" | "scenes">>(
      path.resolve("data/classrooms", `${existingClassroomId}.json`),
    );
    if (!persisted) throw new Error(`找不到已生成课堂 ${existingClassroomId}`);
    const auditOutlines = preparedOutlines?.length ? preparedOutlines : outlines;
    classroomId = persisted.id;
    classroomStage = persisted.stage;
    classroomScenes = persisted.scenes;
    timingAudit = summarizeTeachingTimingAudit({
      outlines: auditOutlines,
      studentScenes: classroomScenes,
      enableTTS: true,
    });
    console.log(JSON.stringify({ phase: "reuse-classroom", classroomId, timingAudit }));
  } else {
    const generated = await generateClassroom({
      generationModelString: resolved.modelString,
      teachingSourceContext: sourceContext,
      requirement: blueprintInput.teacherBrief,
      generationMode: blueprintInput.generationMode,
      knowledgePoints: knowledgePoints.map(({ id, name }) => ({ id, name })),
      courseTitle: blueprintInput.courseTitle,
      languageDirective: "全部学生可见内容和讲解使用简体中文。",
      sceneOutlines: outlines,
      enableWebSearch: false,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: true,
      agentMode: "default",
    }, {
      ...(preparedOutlines?.length ? { preparedOutlines } : {}),
      onOutlinesPrepared: (value) => writeJson(preparedOutlinesFile, value),
      loadSceneStageCheckpoint: async (outline, stage, modelFingerprint, inputFingerprint) => {
        const saved = await readJson<{ modelFingerprint: string; inputFingerprint?: string; payload: unknown }>(checkpointFile(outline.id, stage));
        return saved?.modelFingerprint === modelFingerprint && saved.inputFingerprint === inputFingerprint
          ? saved.payload
          : null;
      },
      onSceneStageCompleted: (outline, stage, payload, modelFingerprint, inputFingerprint) => writeJson(
        checkpointFile(outline.id, stage),
        { modelFingerprint, inputFingerprint, payload },
      ),
      onProgress: (progress) => console.log(JSON.stringify({
        phase: progress.step,
        progress: progress.progress,
        scenesGenerated: progress.scenesGenerated,
        totalScenes: progress.totalScenes,
        message: progress.message,
      })),
    });
    classroomId = generated.id;
    classroomStage = generated.stage;
    classroomScenes = generated.scenes;
    classroomQualityReport = generated.qualityReport;
    console.log(JSON.stringify({ phase: "tts", classroomId }));
    timingAudit = await generateClassroomAssets({
      outlines: generated.assetContext.outlines,
      baseUrl: "http://127.0.0.1:3000",
      studentClassroomId: classroomId,
      studentScenes: classroomScenes,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: true,
      isPblCourse: generated.assetContext.isPblCourse,
      ttsTimingSelection: generated.assetContext.ttsTimingSelection,
      onProgress: (progress) => console.log(JSON.stringify({ phase: progress.phase, ...progress })),
    });
  }

  const visiblePages = classroomScenes.map((scene, index) => ({
    index: index + 1,
    id: scene.id,
    outlineId: scene.outlineId,
    type: scene.type,
    title: outlines.find((outline) => outline.id === scene.outlineId)?.title,
    visibleText: [...new Set(textContent(scene.content))],
  }));
  const studentArtifactText = JSON.stringify({
    stage: classroomStage,
    scenes: classroomScenes,
  });
  if (/\*\*\s*(?:SUPPORTED|PARTIAL|UNSUPPORTED)\s*\*\*|(?:证据状态|审查记录|确认记录|evidenceStatus)\s*[：:]/i.test(studentArtifactText)) {
    throw new Error("学生可见产物泄露管理标签");
  }
  const quizScenes = classroomScenes.filter((scene) => scene.type === "quiz");
  const quizQuestions = quizScenes.flatMap((scene) => scene.content.type === "quiz" ? scene.content.questions : []);
  const shortAnswers = quizQuestions.filter((question) => question.type === "short_answer" && question.format !== "true_false");
  const unmappedQuestions = quizQuestions.filter((question) => !question.teachingUnitIds?.length || !question.knowledgePointIds?.length);
  if (shortAnswers.length > Math.floor(quizQuestions.length * 0.2)) {
    throw new Error(`默认模式短答超过 20%：${shortAnswers.length}/${quizQuestions.length}`);
  }
  if (unmappedQuestions.length > 0) throw new Error(`有 ${unmappedQuestions.length} 道题没有教学单元或知识点映射`);
  if (!timingAudit.complete || !timingAudit.teachingRatioValid || timingAudit.narrationDurationSource !== "actual-audio") {
    throw new Error(`实际音频时长审计未通过：${JSON.stringify(timingAudit)}`);
  }

  const summary = {
    completedAt: new Date().toISOString(),
    model: resolved.modelString,
    classroomId,
    classroomFile: path.resolve("data/classrooms", `${classroomId}.json`),
    blueprint: {
      sectionCount: blueprint.sections.length,
      unitCount: blueprint.sections.reduce((sum, section) => sum + section.units.length, 0),
      teachingPageCount: blueprint.sections.reduce((sum, section) => sum + section.pages.length, 0),
      budget: blueprint.budget,
      sourceBackedUnitCount: blueprint.sections.flatMap((section) => section.units)
        .filter((unit) => unit.sourceKind === "course-source" && unit.evidenceQuotes.length > 0).length,
    },
    classroom: {
      sceneCount: classroomScenes.length,
      slideCount: classroomScenes.filter((scene) => scene.type === "slide").length,
      quizCount: quizScenes.length,
      questionCount: quizQuestions.length,
      shortAnswerCount: shortAnswers.length,
      questionFormats: quizQuestions.map((question) => question.format ?? question.type),
      qualityReport: classroomQualityReport ?? null,
    },
    timingAudit,
    checks: {
      budgetIssues,
      sanitizedManagementLabels: true,
      studentArtifactLeakage: false,
      allQuestionsMappedToTeachingUnits: true,
      adaptiveShortAnswerLimit: `${shortAnswers.length}/${quizQuestions.length}`,
      actualAudioMeasured: timingAudit.measuredSegmentCount === timingAudit.narrationSegmentCount,
    },
  };
  await writeJson(path.join(outputDirectory, "visible-slide-content.json"), visiblePages);
  await writeJson(path.join(outputDirectory, "acceptance-summary.json"), summary);
  console.log(JSON.stringify({ phase: "completed", outputDirectory, summary }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

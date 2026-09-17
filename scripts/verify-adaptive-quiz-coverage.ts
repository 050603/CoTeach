import { promises as fs } from "node:fs";
import path from "node:path";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

  const source = path.resolve(argument("--blueprint")
    || ".openpbl-runtime/teaching-blueprint-acceptance/2026-09-17-30min-adaptive/teaching-blueprint.json");
  const outputDirectory = path.resolve(argument("--output")
    || `.openpbl-runtime/teaching-blueprint-acceptance/${new Date().toISOString().replace(/[:.]/g, "-")}-adaptive-coverage`);
  await fs.mkdir(outputDirectory, { recursive: true });

  const { initializeServerProviderConfig } = await import("../src/lib/openmaic/server/provider-config");
  const { resolveModel } = await import("../src/lib/openmaic/server/resolve-model");
  const { createCourseGenerationAiCall } = await import("../src/lib/openmaic/server/course-generation-ai-call");
  const { teachingBlueprintToOutlines, validateTeachingBlueprintBudget } = await import("../src/lib/course-design/teaching-blueprint");
  const { generateSceneContent } = await import("../src/lib/openmaic/generation/scene-generator");
  const blueprint = JSON.parse(await fs.readFile(source, "utf8"));
  const outlines = teachingBlueprintToOutlines(blueprint, "全部学生可见内容和讲解使用简体中文。");
  const budgetIssues = validateTeachingBlueprintBudget(blueprint, outlines);
  if (budgetIssues.length) throw new Error(`蓝图预算未通过：${budgetIssues.join("；")}`);

  await initializeServerProviderConfig();
  const resolved = await resolveModel({ stage: "generate-classroom" });
  const aiCall = createCourseGenerationAiCall({
    model: resolved.model,
    vision: false,
    source: "verify-adaptive-quiz-coverage",
    maxOutputTokens: resolved.modelInfo?.outputWindow,
    thinking: resolved.thinkingConfig,
    timeoutMs: 180_000,
    maxRetries: 2,
    streamResponse: true,
    streamMaxDurationMs: 600_000,
  });

  const generatedSections = [];
  for (const outline of outlines.filter((item) => item.type === "quiz")) {
    const content = await generateSceneContent(outline, aiCall, "使用简体中文");
    if (!content || !("questions" in content)) throw new Error(`测验生成失败：${outline.id}`);
    const targets = outline.assessmentTargets ?? [];
    const covered = new Set(content.questions.flatMap((question) =>
      (question.teachingUnitIds ?? []).flatMap((unitId) =>
        (question.knowledgePointIds ?? []).map((knowledgePointId) => `${unitId}/${knowledgePointId}`))));
    const missingTargets = targets.filter((target) => !covered.has(`${target.unitId}/${target.knowledgePointId}`));
    if (content.questions.length !== outline.quizConfig?.questionCount || missingTargets.length) {
      throw new Error(`测验覆盖失败：${outline.id}，题数 ${content.questions.length}/${outline.quizConfig?.questionCount}，漏测 ${missingTargets.length}`);
    }
    generatedSections.push({
      outlineId: outline.id,
      title: outline.title,
      assessmentDurationSec: outline.targetDurationSec,
      plannedQuestionCount: outline.quizConfig.questionCount,
      targets,
      missingTargets,
      questions: content.questions,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    model: resolved.modelString,
    blueprintSource: source,
    budgetIssues,
    sectionCount: generatedSections.length,
    targetCount: generatedSections.reduce((sum, section) => sum + section.targets.length, 0),
    questionCount: generatedSections.reduce((sum, section) => sum + section.questions.length, 0),
    allTargetsCovered: generatedSections.every((section) => section.missingTargets.length === 0),
    formats: generatedSections.flatMap((section) => section.questions.map((question) => question.format ?? question.type)),
    sections: generatedSections.map((section) => ({
      outlineId: section.outlineId,
      title: section.title,
      assessmentDurationSec: section.assessmentDurationSec,
      targetCount: section.targets.length,
      questionCount: section.questions.length,
      mappings: section.questions.map((question) => ({
        id: question.id,
        type: question.type,
        format: question.format,
        teachingUnitIds: question.teachingUnitIds,
        knowledgePointIds: question.knowledgePointIds,
      })),
    })),
  };
  await fs.writeFile(path.join(outputDirectory, "generated-quizzes.json"), `${JSON.stringify(generatedSections, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDirectory, "coverage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputDirectory, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

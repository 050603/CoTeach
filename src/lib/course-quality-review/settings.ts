import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { getModelInfo, parseModelString } from "@openmaic/lib/ai/providers";
import { getServerProviders } from "@openmaic/lib/server/provider-config";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export type CourseQualityReviewSettings = {
  /** Empty means use the exact model stored on the course-generation job. */
  modelString?: string;
};

type ConfiguredProvider = { models?: string[]; defaultModel?: string };

const SECTION = "course-quality-review";
const PROVIDER_ID = "reviewer";
const FALLBACK_PATH = path.join(process.cwd(), ".openpbl-course-quality-review.json");

export class CourseQualityReviewSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseQualityReviewSettingsError";
  }
}

function sanitize(input: unknown): CourseQualityReviewSettings {
  const value = input && typeof input === "object"
    ? (input as Record<string, unknown>).modelString
    : undefined;
  return {
    modelString: typeof value === "string" && value.trim()
      ? value.trim().slice(0, 240)
      : undefined,
  };
}

/** A separate reviewer is opt-in and must be both configured and vision-capable. */
export function validateCourseQualityReviewModel(
  modelString: string,
  configuredProviders: Record<string, ConfiguredProvider> = getServerProviders(),
): void {
  let parsed: ReturnType<typeof parseModelString>;
  try {
    parsed = parseModelString(modelString);
  } catch {
    throw new CourseQualityReviewSettingsError("检验模型标识无效，请从已配置的视觉模型中选择。");
  }
  const { providerId, modelId } = parsed;
  const configured = configuredProviders[providerId];
  if (!configured) {
    throw new CourseQualityReviewSettingsError("所选检验模型的服务商尚未在 AI 大模型设置中配置。");
  }
  if (configured.models?.length && !configured.models.includes(modelId)) {
    throw new CourseQualityReviewSettingsError("所选检验模型不在该服务商当前启用的模型列表中。");
  }
  const metadata = getModelInfo(providerId, modelId);
  if (metadata?.capabilities?.vision !== true) {
    throw new CourseQualityReviewSettingsError("检验模型必须明确支持视觉能力；自定义未知能力模型不能用于视觉检验。");
  }
}

export async function getCourseQualityReviewSettings(): Promise<CourseQualityReviewSettings> {
  if (isDatabaseConfigured()) {
    const row = await prisma.providerCredential.findFirst({
      where: { ownerId: null, name: SECTION, provider: PROVIDER_ID },
      select: { config: true },
    });
    return sanitize(row?.config);
  }
  try {
    return sanitize(JSON.parse(await readFile(FALLBACK_PATH, "utf8")));
  } catch {
    return {};
  }
}

export async function saveCourseQualityReviewSettings(
  input: CourseQualityReviewSettings,
): Promise<CourseQualityReviewSettings> {
  const settings = sanitize(input);
  if (settings.modelString) validateCourseQualityReviewModel(settings.modelString);
  if (isDatabaseConfigured()) {
    await runMutationTransaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${SECTION}:${PROVIDER_ID}`}, 0))::text`;
      const existing = await tx.providerCredential.findFirst({
        where: { ownerId: null, name: SECTION, provider: PROVIDER_ID },
      });
      if (existing) {
        await tx.providerCredential.update({
          where: { id: existing.id },
          data: { config: settings as Prisma.InputJsonValue },
        });
      } else {
        await tx.providerCredential.create({
          data: {
            ownerId: null,
            name: SECTION,
            provider: PROVIDER_ID,
            secret: "",
            config: settings as Prisma.InputJsonValue,
          },
        });
      }
    });
  } else {
    await writeFile(FALLBACK_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return settings;
}

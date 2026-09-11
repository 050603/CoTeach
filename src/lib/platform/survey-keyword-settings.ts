import { prisma } from "@/lib/db/client";

export type SurveyKeywordMode = "local" | "llm";
export type SurveyKeywordSettings = { mode: SurveyKeywordMode };

const PROVIDER = "survey-keywords";
const NAME = "analysis";

function settingsKey(ownerId: string) {
  if (!ownerId) throw new Error("问卷分析设置缺少教师身份。");
  return { ownerId, provider: PROVIDER, name: NAME };
}

export async function getSurveyKeywordSettings(ownerId: string): Promise<SurveyKeywordSettings> {
  const row = await prisma.providerCredential.findUnique({
    where: { ownerId_provider_name: settingsKey(ownerId) },
    select: { config: true },
  });
  const config = row?.config;
  return { mode: config && typeof config === "object" && !Array.isArray(config) && config.mode === "llm" ? "llm" : "local" };
}

export async function saveSurveyKeywordSettings(ownerId: string, mode: SurveyKeywordMode): Promise<SurveyKeywordSettings> {
  if (mode !== "local" && mode !== "llm") throw new Error("问卷分析方式无效。");
  const key = settingsKey(ownerId);
  const settings = { mode };
  await prisma.providerCredential.upsert({
    where: { ownerId_provider_name: key },
    create: { ...key, secret: "", config: settings, status: "ACTIVE" },
    update: { config: settings, status: "ACTIVE" },
  });
  return settings;
}

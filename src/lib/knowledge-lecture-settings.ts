import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { Prisma } from "@prisma/client";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";

export type KnowledgeLectureTutorSettings = {
  modelString?: string;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
};

const SECTION = "knowledge-lecture";
const PROVIDER_ID = "tutor";
const FALLBACK_PATH = path.join(/* turbopackIgnore: true */ process.cwd(), ".openpbl-knowledge-lecture.json");

function sanitize(value: unknown): KnowledgeLectureTutorSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const optionalText = (key: string, max = 240) =>
    typeof record[key] === "string" && record[key].trim() ? record[key].trim().slice(0, max) : undefined;
  const speed = Number(record.ttsSpeed);
  return {
    modelString: optionalText("modelString"),
    ttsProviderId: optionalText("ttsProviderId", 80),
    ttsModelId: optionalText("ttsModelId"),
    ttsVoice: optionalText("ttsVoice"),
    ttsSpeed: Number.isFinite(speed) ? Math.max(0.7, Math.min(1.3, speed)) : 1,
  };
}

export async function getKnowledgeLectureTutorSettings(): Promise<KnowledgeLectureTutorSettings> {
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
    return { ttsSpeed: 1 };
  }
}

export async function saveKnowledgeLectureTutorSettings(
  input: KnowledgeLectureTutorSettings,
): Promise<KnowledgeLectureTutorSettings> {
  const settings = sanitize(input);
  if (isDatabaseConfigured()) {
    await runMutationTransaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${SECTION}:${PROVIDER_ID}`}, 0))::text`;
      const existing = await tx.providerCredential.findFirst({ where: { ownerId: null, name: SECTION, provider: PROVIDER_ID } });
      if (existing) await tx.providerCredential.update({ where: { id: existing.id }, data: { config: settings as Prisma.InputJsonValue } });
      else await tx.providerCredential.create({ data: { ownerId: null, name: SECTION, provider: PROVIDER_ID, secret: "", config: settings as Prisma.InputJsonValue } });
    });
  } else {
    await writeFile(FALLBACK_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return settings;
}

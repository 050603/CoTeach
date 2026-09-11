// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { providerCredential: mocks } }));

import { getSurveyKeywordSettings, saveSurveyKeywordSettings } from "./survey-keyword-settings";

beforeEach(() => vi.resetAllMocks());

describe("teacher survey keyword settings", () => {
  it("defaults missing or invalid preferences to local without writing", async () => {
    for (const config of [undefined, null, {}, [], { mode: "unknown" }]) {
      mocks.findUnique.mockResolvedValue(config === undefined ? null : { config });
      await expect(getSurveyKeywordSettings("teacher-1")).resolves.toEqual({ mode: "local" });
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists a teacher preference without changing another teacher's mode", async () => {
    const rows = new Map<string, { config: { mode: string } }>();
    mocks.findUnique.mockImplementation(({ where }) => rows.get(where.ownerId_provider_name.ownerId) ?? null);
    mocks.upsert.mockImplementation(({ where, create, update }) => {
      const ownerId = where.ownerId_provider_name.ownerId;
      rows.set(ownerId, { config: rows.has(ownerId) ? update.config : create.config });
    });
    await expect(saveSurveyKeywordSettings("teacher-1", "llm")).resolves.toEqual({ mode: "llm" });
    await expect(getSurveyKeywordSettings("teacher-1")).resolves.toEqual({ mode: "llm" });
    await expect(getSurveyKeywordSettings("teacher-2")).resolves.toEqual({ mode: "local" });
    await expect(saveSurveyKeywordSettings("teacher-1", "local")).resolves.toEqual({ mode: "local" });
    await expect(getSurveyKeywordSettings("teacher-1")).resolves.toEqual({ mode: "local" });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { ownerId_provider_name: { ownerId: "teacher-1", provider: "survey-keywords", name: "analysis" } },
      create: { ownerId: "teacher-1", provider: "survey-keywords", name: "analysis", secret: "", config: { mode: "llm" }, status: "ACTIVE" },
      update: { config: { mode: "llm" }, status: "ACTIVE" },
    });
  });

  it("does not treat a failed database read as a saved local preference", async () => {
    mocks.findUnique.mockRejectedValue(new Error("database unavailable"));
    await expect(getSurveyKeywordSettings("teacher-1")).rejects.toThrow("database unavailable");
  });

  it("rejects missing ownership instead of storing a global preference", async () => {
    await expect(getSurveyKeywordSettings("")).rejects.toThrow();
    await expect(saveSurveyKeywordSettings("", "llm")).rejects.toThrow();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

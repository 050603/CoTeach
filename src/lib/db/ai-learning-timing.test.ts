import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { loadAiLearningTiming } from "./ai-learning-timing";

describe("complete AI learning timing projection", () => {
  it("uses the complete database aggregate even when more than 10,000 events exist", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ durationRows: [
        { studentId: "student-a", effectiveDurationMs: String(10_001 * 10_000), eventCount: "10001" },
        { studentId: "student-b", effectiveDurationMs: "0", eventCount: "1" },
      ], sceneRows: [
        { studentId: "student-a", expectedDurationSec: "120", ttsDurationSec: "140", plannedStudentActivitySec: "30" },
      ] }]);
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const timing = await loadAiLearningTiming("instance-1", ["student-a", "student-b", "student-c"], db);

    expect(timing).toEqual({
      "student-a": { effectiveDurationMs: 100_010_000, expectedDurationMs: 264_000, hasEvidence: true },
      "student-b": { effectiveDurationMs: 0, expectedDurationMs: 0, hasEvidence: true },
      "student-c": { effectiveDurationMs: 0, expectedDurationMs: 0, hasEvidence: false },
    });
    const durationSql = (query.mock.calls[0][0] as TemplateStringsArray).join("?");
    const scenesSql = durationSql;
    expect(query).toHaveBeenCalledTimes(1);
    expect(durationSql).toContain("WITH scoped AS MATERIALIZED");
    expect(durationSql).toContain('e."classroomInstanceId" = ?');
    expect(durationSql).toContain('e."userId" IN (?)');
    expect(query.mock.calls[0][2].values).toEqual(["student-a", "student-b", "student-c"]);
    expect(durationSql).toContain('DISTINCT ON ("userId", "logicalKey")');
    expect(durationSql).toContain('"durationMs" BETWEEN 1 AND 300000');
    expect(durationSql).toContain("payload->>'visible' IS DISTINCT FROM 'false'");
    expect(durationSql).not.toMatch(/\bLIMIT\b/i);
    expect(scenesSql).toContain("DISTINCT ON (\"userId\", payload->>'sceneId')");
    expect(scenesSql).not.toMatch(/\bLIMIT\b/i);
  });

  it("binds only the requested student and excludes other students even from unexpected aggregate rows", async () => {
    const query = vi.fn().mockResolvedValue([{ durationRows: [
      { studentId: "student-a", effectiveDurationMs: "10000", eventCount: "1" },
      { studentId: "student-b", effectiveDurationMs: "20000", eventCount: "2" },
    ], sceneRows: [{ studentId: "student-b", expectedDurationSec: "100" }] }]);
    const timing = await loadAiLearningTiming("instance", ["student-a"], { $queryRaw: query } as unknown as Prisma.TransactionClient);
    expect(Object.keys(timing)).toEqual(["student-a"]);
    expect(timing["student-a"]).toEqual({ effectiveDurationMs: 10000, expectedDurationMs: 0, hasEvidence: true });
    expect(query.mock.calls[0][2].values).toEqual(["student-a"]);
  });

  it("does not query event history for an empty classroom", async () => {
    const query = vi.fn();
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    expect(await loadAiLearningTiming("instance-1", [], db)).toEqual({});
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unsafe aggregate instead of showing a misleading duration", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ durationRows: [
      { studentId: "student-a", effectiveDurationMs: String(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)), eventCount: "1" },
    ], sceneRows: [] }]);
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(loadAiLearningTiming("instance-1", ["student-a"], db)).rejects.toThrow("Invalid aggregate learning duration");
  });
});

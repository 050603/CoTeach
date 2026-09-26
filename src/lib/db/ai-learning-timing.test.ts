import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { loadAiLearningTiming } from "./ai-learning-timing";

describe("complete AI learning timing projection", () => {
  it("uses the complete database aggregate even when more than 10,000 events exist", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([
        { studentId: "student-a", effectiveDurationMs: BigInt(10_001 * 10_000), eventCount: BigInt(10_001) },
        { studentId: "student-b", effectiveDurationMs: BigInt(0), eventCount: BigInt(1) },
      ])
      .mockResolvedValueOnce([
        { studentId: "student-a", expectedDurationSec: "120", ttsDurationSec: "140", plannedStudentActivitySec: "30" },
      ]);
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const timing = await loadAiLearningTiming("instance-1", ["student-a", "student-b", "student-c"], db);

    expect(timing).toEqual({
      "student-a": { effectiveDurationMs: 100_010_000, expectedDurationMs: 264_000, hasEvidence: true },
      "student-b": { effectiveDurationMs: 0, expectedDurationMs: 0, hasEvidence: true },
      "student-c": { effectiveDurationMs: 0, expectedDurationMs: 0, hasEvidence: false },
    });
    const durationSql = (query.mock.calls[0][0] as TemplateStringsArray).join("?");
    const scenesSql = (query.mock.calls[1][0] as TemplateStringsArray).join("?");
    expect(durationSql).toContain('e."classroomInstanceId" = ?');
    expect(durationSql).toContain('DISTINCT ON ("userId", "logicalKey")');
    expect(durationSql).toContain('"durationMs" BETWEEN 1 AND 300000');
    expect(durationSql).toContain("payload->>'visible' IS DISTINCT FROM 'false'");
    expect(durationSql).not.toMatch(/\bLIMIT\b/i);
    expect(scenesSql).toContain("DISTINCT ON (\"userId\", payload->>'sceneId')");
    expect(scenesSql).not.toMatch(/\bLIMIT\b/i);
  });

  it("does not query event history for an empty classroom", async () => {
    const query = vi.fn();
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    expect(await loadAiLearningTiming("instance-1", [], db)).toEqual({});
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unsafe aggregate instead of showing a misleading duration", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      { studentId: "student-a", effectiveDurationMs: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), eventCount: BigInt(1) },
    ]).mockResolvedValueOnce([]);
    const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(loadAiLearningTiming("instance-1", ["student-a"], db)).rejects.toThrow("Invalid aggregate learning duration");
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { loadStudentPrivateRows } from "./student-private-read-bundle";

const scope = { courseId: "course", offeringId: "offering", studentId: "student", participationIds: ["own", "peer"], ownParticipationIds: ["own"], studentGroupIds: ["group-view"] };
describe("student private read bundle", () => {
  it("preserves native dates, JSON strings/nulls and newest-first event order across interleaved UNION rows", async () => {
    const createdAt = new Date("2026-09-01T01:02:03.123Z"), updatedAt = new Date("2026-09-02T02:03:04.456Z");
    const json = { literalDate: "2026-09-01T01:02:03.123Z", count: 2, nested: [null, { active: false }] };
    const base = { id: "row", participationId: "own", createdAt, updatedAt, status: null, stageKey: null, content: null, value: json, ordinal: null };
    const query = vi.fn().mockResolvedValue([
      { ...base, kind: "event", value: { id: "old" }, ordinal: 2 },
      { ...base, kind: "submission", status: "DRAFT", stageKey: "make" },
      { ...base, kind: "workspace", value: { aiLearningProgress: { completedScenes: ["scene"], ...json } } },
      { ...base, kind: "reflection", content: "真实反思" },
      { ...base, kind: "signal", value: null },
      { ...base, kind: "event", value: { id: "new" }, ordinal: 1 },
      { ...base, kind: "support" },
    ]);
    const result = await loadStudentPrivateRows({ $queryRaw: query } as unknown as Prisma.TransactionClient, scope);
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.submissions[0].createdAt).toBe(createdAt);
    expect(result.reflections[0].updatedAt).toBe(updatedAt);
    expect(result.reflections[0].content).toBe("真实反思");
    expect(result.submissions[0].payload).toBe(json);
    expect(result.signals).toEqual([{ payload: null }]);
    expect(result.supports).toEqual([{ structuredPayload: json }]);
    expect(result.workspaces[0].projectState).toEqual({ aiLearningProgress: { completedScenes: ["scene"], ...json } });
    expect(result.events).toEqual([{ metadata: { id: "new" } }, { metadata: { id: "old" } }]);
  });

  it("parameterizes identities and retains typed JSON predicates plus course-visible collections", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const studentId = "student' OR TRUE --";
    await loadStudentPrivateRows({ $queryRaw: query } as unknown as Prisma.TransactionClient, { ...scope, studentId });
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).not.toContain(studentId);
    expect(sql.values).toContain(studentId);
    expect(sql.text).toContain("#> '{view,studentId}' = to_jsonb(");
    expect(sql.text).toContain("#> '{view,groupId}' = to_jsonb(");
    expect(sql.text).toContain("'\"learningEvidence\"'::jsonb, '\"artifactSnapshots\"'::jsonb");
    expect(sql.text).toContain("'\"aiAssessmentSuggestions\"'::jsonb");
    expect(sql.text).toContain('ORDER BY e."receivedAt" DESC LIMIT 10000');
    expect(sql.text).not.toContain("to_jsonb(s)");
    expect(sql.text).toContain(`jsonb_build_object('aiLearningProgress', w."projectState"->'aiLearningProgress')`);
    expect((sql.text.match(/UNION ALL/g) ?? [])).toHaveLength(5);
  });

  it("does not turn empty participation/group sets into unscoped reads", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const result = await loadStudentPrivateRows({ $queryRaw: query } as unknown as Prisma.TransactionClient, {
      ...scope, participationIds: [], ownParticipationIds: [], studentGroupIds: [],
    });
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).not.toMatch(/IN\s*\(\s*\)/);
    expect(sql.text).toContain("WHERE FALSE AND (");
    expect(sql.text).toContain('"Reflection" r WHERE FALSE');
    expect(sql.text).toContain('"LearningSignal" l WHERE FALSE');
    expect(sql.text).toContain('"StudentProjectWorkspace" w WHERE FALSE');
    expect(result).toEqual({ submissions: [], reflections: [], supports: [], signals: [], events: [], workspaces: [] });
  });

  it.each([null, false, "", [], { completedScenes: ["scene"], nested: [null, ""] }])("preserves projected progress JSON %j", async progress => {
    const query = vi.fn().mockResolvedValue([{ kind: "workspace", participationId: "own", value: { aiLearningProgress: progress } }]);
    const result = await loadStudentPrivateRows({ $queryRaw: query } as unknown as Prisma.TransactionClient, scope);
    expect(result.workspaces).toEqual([{ participationId: "own", projectState: { aiLearningProgress: progress } }]);
  });

  it("propagates database failure without returning a partial successful snapshot", async () => {
    const query = vi.fn().mockRejectedValue(new Error("cancelled"));
    await expect(loadStudentPrivateRows({ $queryRaw: query } as unknown as Prisma.TransactionClient, scope)).rejects.toThrow("cancelled");
  });
});

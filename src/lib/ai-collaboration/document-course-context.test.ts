import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthoritativeCourseContext } from "./document-policy";

const mocks = vi.hoisted(() => ({
  instance: vi.fn(), groups: vi.fn(), evaluations: vi.fn(), directives: vi.fn(), evidence: vi.fn(), workspaces: vi.fn(),
  configured: vi.fn(), fallback: vi.fn(), template: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: {
  classroomInstance: { findUnique: mocks.instance }, projectGroup: { findMany: mocks.groups },
  evaluation: { findMany: mocks.evaluations }, teacherAgentDirective: { findMany: mocks.directives },
  classroomSubmission: { findMany: mocks.evidence }, studentProjectWorkspace: { findMany: mocks.workspaces },
} }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.fallback }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.template }));
import { getDocumentCourseContext, loadDocumentCourseContext } from "./document-course-context";

const time = new Date("2026-09-27T00:00:00.000Z");
function instance() {
  return {
    id: "course", status: "TEACHING", runtimeConfig: { version: 9, currentStageIndex: 1, makeArtifactMode: "other" }, createdAt: time, updatedAt: time,
    activity: { title: "实例标题", chapter: { offeringId: "offering" } },
    templateVersion: { snapshot: { schemaVersion: 2, kind: "pbl-course", design: {
      name: "旧模板标题", grade: "七年级", stages: [{ key: "proposal", label: "方案" }, { key: "make", label: "制作", description: "对比节能结果" }],
      pblConfig: { makeArtifactMode: "document" }, content: { knowledgePoints: [{ id: "kp", name: "控制变量" }] },
    } } },
    participations: ["self", "peer"].map(id => ({ id: `p-${id}`, firstEnteredAt: null, lastEnteredAt: time, stageProgress: { progress: { make: 10 } },
      enrollment: { userId: id, joinedAt: time, user: { displayName: id } },
    })),
  };
}

describe("document AI course context", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.configured.mockReturnValue(true); mocks.instance.mockResolvedValue(instance());
    for (const fn of [mocks.groups, mocks.evaluations, mocks.directives, mocks.evidence, mocks.workspaces]) fn.mockResolvedValue([]);
  });

  it("keeps frozen design, runtime overrides and live student identity without unrelated projections", async () => {
    const result = await getDocumentCourseContext("course", "self");
    expect(result).toMatchObject({ name: "实例标题", grade: "七年级", version: 9, status: "teaching", currentStageIndex: 1, pblConfig: { makeArtifactMode: "other" } });
    expect(result?.students).toEqual(["self", "peer"].map(id => ({ id, name: id, joinedAt: time.toISOString(), lastSeenAt: time.toISOString(), stageProgress: { make: 10 } })));
    expect(result?.content.knowledgePoints).toEqual([{ id: "kp", name: "控制变量" }]);
    for (const key of ["learningEvents", "companionThreads", "showcasePresentations", "projectDocumentVersions", "aiLearningTimingByStudent"]) expect(result).not.toHaveProperty(key);
    expect(mocks.workspaces).toHaveBeenCalledWith({ where: { participationId: { in: ["p-self"] } }, select: { participationId: true, projectState: true } });
    expect(mocks.fallback).not.toHaveBeenCalled(); expect(mocks.template).not.toHaveBeenCalled();
  });

  it("deduplicates before target filtering and preserves last value at the first position", async () => {
    mocks.groups.mockResolvedValue([{ id: "offering:grp-self", name: "个人项目", board: { snapshot: { proposal: { topic: "节能", goal: "控制条件", selectedForms: ["报告"] }, nodes: ["unused"] } },
      members: [{ userId: "self", role: "MEMBER", user: { displayName: "本人" } }], createdAt: time, updatedAt: time }]);
    const feedback = (id: string, targetId: string, content: string) => ({ metadata: { collection: "feedback", view: { id, stageKey: "make", targetType: "student", targetId, content } } });
    mocks.evaluations.mockResolvedValue([feedback("duplicate", "self", "应被覆盖"), feedback("second", "grp-self", "组内反馈"), feedback("duplicate", "peer", "别人的更新"),
      { metadata: { collection: "feedback", view: { id: "whole", stageKey: "make", targetType: "course", targetId: "course", content: "全班要求" } } }]);
    const evidence = (id: string, studentId: string, summary: string) => ({ payload: { collection: "learningEvidence", view: { id, stageKey: "make", studentId, title: id, summary } } });
    mocks.evidence.mockResolvedValue([evidence("same", "self", "旧证据"), evidence("kept", "self", "本人证据"), evidence("same", "peer", "其他学生证据")]);
    mocks.directives.mockResolvedValue([{ payload: { view: { status: "active", stageKey: "make", targetScope: "course", targetStudentIds: [], goal: "测量", instruction: "同一时间段" } } }]);
    const progress = { knowledgeLectureAttempts: [{ questions: [{ correct: false, knowledgePointIds: ["kp"], prompt: "方法", feedback: "控制条件" }] }] };
    mocks.workspaces.mockResolvedValue([{ participationId: "p-self", projectState: { aiLearningProgress: progress, largeDraft: "unused" } }]);
    const result = (await loadDocumentCourseContext("course", "self"))!;
    expect(result.feedback?.map(item => item.id)).toEqual(["duplicate", "second", "whole"]);
    expect(result.learningEvidence?.map(item => item.id)).toEqual(["same", "kept"]);
    expect(result.aiLearningProgress).toEqual({ self: progress });
    const text = buildAuthoritativeCourseContext(result, "self", "make");
    for (const value of ["组内反馈", "全班要求", "本人证据", "控制条件", "同一时间段", "报告"]) expect(text).toContain(value);
    for (const value of ["应被覆盖", "别人的更新", "旧证据", "其他学生证据"]) expect(text).not.toContain(value);
    expect(mocks.evidence).toHaveBeenCalledWith({ where: { participationId: { in: ["p-self", "p-peer"] }, payload: { path: ["collection"], equals: "learningEvidence" } }, select: { payload: true } });
    expect(mocks.directives.mock.calls[0][0].where.OR).toEqual([{ participationId: { in: ["p-self", "p-peer"] } }, { payload: { path: ["instanceId"], equals: "course" } }]);
  });

  it("does not reuse settled runtime, group or feedback results", async () => {
    await loadDocumentCourseContext("course", "self");
    const changed = instance(); changed.runtimeConfig = { version: 10, currentStageIndex: 0, makeArtifactMode: "document" };
    changed.status = "FINISHED"; mocks.instance.mockResolvedValue(changed);
    expect(await loadDocumentCourseContext("course", "self")).toMatchObject({ version: 10, currentStageIndex: 0, status: "finished", pblConfig: { makeArtifactMode: "document" } });
    expect(mocks.instance).toHaveBeenCalledTimes(2); expect(mocks.groups).toHaveBeenCalledTimes(2);
  });

  it("shares only simultaneous common reads and keeps each student's workspace separate", async () => {
    mocks.workspaces.mockImplementation(({ where }: { where: { participationId: { in: string[] } } }) => Promise.resolve([
      { participationId: where.participationId.in[0], projectState: { aiLearningProgress: { owner: where.participationId.in[0] } } },
    ]));
    const [self, peer] = await Promise.all([loadDocumentCourseContext("course", "self"), loadDocumentCourseContext("course", "peer")]);
    expect(mocks.instance).toHaveBeenCalledTimes(1); expect(mocks.groups).toHaveBeenCalledTimes(1);
    expect(mocks.workspaces).toHaveBeenCalledTimes(2);
    expect(self?.aiLearningProgress).toEqual({ self: { owner: "p-self" } });
    expect(peer?.aiLearningProgress).toEqual({ peer: { owner: "p-peer" } });
  });

  it("stops missing-instance reads and retains the original template namespace fallback", async () => {
    mocks.instance.mockResolvedValue(null); mocks.template.mockResolvedValue({ id: "template" });
    expect(await getDocumentCourseContext("missing", "self")).toEqual({ id: "template" });
    expect(mocks.groups).not.toHaveBeenCalled(); expect(mocks.template).toHaveBeenCalledWith("missing");
  });

  it("retains the original non-database fallback", async () => {
    mocks.configured.mockReturnValue(false); mocks.fallback.mockResolvedValue({ id: "demo" });
    expect(await getDocumentCourseContext("demo", "self")).toEqual({ id: "demo" });
    expect(mocks.fallback).toHaveBeenCalledWith("demo", { studentId: "self" }); expect(mocks.instance).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { Course } from "@/lib/session/types";
import { applySessionAction, initialSessionState, normalizeCourse } from "@/lib/session/actions";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
vi.mock("@/lib/companion/server-store", () => ({ loadCompanionState: vi.fn(async () => ({})), persistCompanionState: vi.fn(async () => undefined) }));
import { assertImmutableClassroomDesign, persistInstanceCourse, projectStoredCourseResource } from "./v2-course-projection";
function fixture() {
  const course = createPblTemplateCourse("instance", { name: "Project" }); course.status = "teaching"; course.version = 1;
  course.students = ["a", "b"].map(id => ({ id, name: id, joinedAt: "2026-09-01T00:00:00Z", stageProgress: {} }));
  course.groups = [{ id: "group", name: "Team", topic: "Topic", keywords: [], selectedForms: [], members: [{ studentId: "a", name: "Alex" }, { studentId: "b", name: "Alex" }], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }];
  return course;
}
const teacher = { id: "teacher-2", role: "teacher" };
let delegates: Record<string, { findUnique: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }>;
let db: Prisma.TransactionClient;
beforeEach(() => {
  delegates = Object.fromEntries(["classroomInstance", "classroomParticipation", "studentProjectWorkspace", "classroomSubmission", "reflection", "evaluation", "aiSupportRecord", "intervention", "projectGroup", "groupBoard", "groupMember", "announcement", "announcementReply", "todo", "todoCompletion", "resource", "workPlanItem", "domainEvent", "learningSignal", "teacherAgentDirective", "fileAsset"].map(name => [name, { findUnique: vi.fn(async () => null), findUniqueOrThrow: vi.fn(), update: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() }]));
  delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ id: "instance", activityId: "activity", status: "TEACHING", startedAt: new Date(), runtimeConfig: {}, activity: { chapter: { offeringId: "offering", offering: { status: "OPEN", teachers: [{ userId: "teacher-1" }, { userId: "teacher-2" }] } } }, participations: ["a", "b"].map(id => ({ id: `p-${id}`, enrollmentId: `e-${id}`, enrollment: { userId: id, offeringId: "offering", status: "ACTIVE" } })) });
  db = delegates as unknown as Prisma.TransactionClient;
});
describe("V2 classroom projection writes", () => {
  it("restores the canonical upload URL for a classroom video", () => {
    expect(projectStoredCourseResource({
      id: "video-resource",
      title: "课堂示范.mp4",
      type: "MP4",
      description: null,
      metadata: { stageKey: "launch", url: "https://stale.example/video.mp4" },
      fileAsset: {
        id: "video-asset",
        size: BigInt(65_770_721),
        deletedAt: null,
      },
    })).toMatchObject({
      id: "video-resource",
      title: "课堂示范.mp4",
      type: "MP4",
      stageKey: "launch",
      size: "65770721",
      url: "/api/uploads/video-asset",
      downloadedBy: [],
    });
  });

  it("completes participations and records the shared lifecycle event when ending", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, status: "finished" }, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FINISHED", endedAt: expect.any(Date) }) }));
    expect(delegates.classroomParticipation.updateMany).toHaveBeenCalledWith({ where: { instanceId: "instance", completedAt: null }, data: { completedAt: expect.any(Date) } });
    expect(delegates.domainEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "classroom:instance:finish" }, create: expect.objectContaining({ eventType: "classroom_finished", actorId: "teacher-2" }) }));
  });
  it("starts a scheduled instance without changing its snapshot", async () => {
    const before = fixture(); before.status = "ready";
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, status: "SCHEDULED", startedAt: null });
    await persistInstanceCourse(db, before, { ...before, status: "teaching" }, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "TEACHING", startedAt: expect.any(Date) }) }));
    expect(delegates.domainEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "classroom:instance:start" }, create: expect.objectContaining({ eventType: "classroom_started" }) }));
    expect(delegates.classroomParticipation.updateMany).not.toHaveBeenCalled();
  });
  it("persists the artifact mode as a runtime override while keeping other design immutable", async () => {
    const before = normalizeCourse(fixture());
    const after = { ...before, pblConfig: { ...before.pblConfig!, makeArtifactMode: "python" as const } };
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runtimeConfig: expect.objectContaining({ makeArtifactMode: "python" }) }) }));
    expect(() => assertImmutableClassroomDesign(before, { ...after, name: "Changed" })).toThrow();
  });
  it("rejects a queued student write when the classroom closes before its transaction", async () => {
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: "instance" } });
    delegates.classroomInstance.findUniqueOrThrow.mockResolvedValue({ ...instance, status: "FINISHED" });
    const before = fixture();
    await expect(persistInstanceCourse(db, before, before, { id: "a", role: "student" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
  });
  it("rejects published design changes before writing and permits runtime summaries", async () => {
    const before = fixture();
    expect(() => assertImmutableClassroomDesign(before, { ...before, name: "Changed" })).toThrow("课堂已固定发布教案");
    await expect(persistInstanceCourse(db, before, { ...before, stages: [] }, teacher)).rejects.toMatchObject({ code: "CLASSROOM_DESIGN_IMMUTABLE" });
    expect(delegates.classroomInstance.update).not.toHaveBeenCalled();
    const after = { ...before, content: { ...before.content, courseSummaryPresentation: { slides: [] } as unknown as Course["content"]["courseSummaryPresentation"] } };
    await expect(persistInstanceCourse(db, before, after, teacher)).resolves.toBeUndefined();
  });
  it("accepts reducer design defaults without permitting content edits", () => {
    const before = fixture(); const normalized = normalizeCourse(before);
    expect(() => assertImmutableClassroomDesign(before, normalized)).not.toThrow();
    expect(() => assertImmutableClassroomDesign(before, { ...normalized, content: { ...normalized.content, pblOutline: "Changed" } })).toThrow();
  });
  it("starts an authored generated course after reducer normalization", () => {
    const before = fixture();
    before.status = "ready";
    before.stages = before.stages.map((stage, index) => ({
      ...stage,
      description: `生成课程的第 ${index + 1} 阶段说明`,
    }));
    const after = applySessionAction(
      { ...initialSessionState(), hydrated: true, courses: [before] },
      {
        type: "START_TEACHING",
        payload: {
          id: before.id,
          classConfig: before.classConfig!,
          inviteCode: "ABC123",
        },
      },
    ).courses[0]!;

    expect(() => assertImmutableClassroomDesign(before, after)).not.toThrow();
  });
  it("namespaces legacy personal group IDs by offering", async () => {
    const before = fixture(); before.groups = []; const after = normalizeCourse(before);
    await persistInstanceCourse(db, before, after, teacher);
    expect(delegates.projectGroup.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ id: "offering:grp-a", offeringId: "offering" }) }));
    expect(delegates.groupMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ groupId: "offering:grp-a", userId: "a" }) }));
  });
  it("keeps finished classrooms closed", async () => {
    const before = fixture(); before.status = "finished";
    await expect(persistInstanceCourse(db, before, { ...before, status: "teaching" }, teacher)).rejects.toMatchObject({ code: "CLASSROOM_STATE_CONFLICT" });
  });
  it("does not guess a student's ID from an ambiguous display name", async () => {
    const before = fixture();
    const after = { ...before, workPlan: [{ id: "task", groupId: "group", memberName: "Alex", role: "researcher", task: "Investigate", progress: 0 }] };
    await expect(persistInstanceCourse(db, before, after, teacher)).rejects.toMatchObject({ code: "AMBIGUOUS_ASSIGNEE" });
    expect(delegates.workPlanItem.upsert).not.toHaveBeenCalled();
  });
  it("retains an existing unambiguous ID binding when classmates have the same name", async () => {
    const before = fixture();
    delegates.workPlanItem.findUnique.mockResolvedValue({ id: "task", groupId: "group", assigneeId: "b" });
    await persistInstanceCourse(db, before, { ...before, workPlan: [{ id: "task", groupId: "group", memberName: "Alex", role: "researcher", task: "Investigate", progress: 50 }] }, teacher);
    expect(delegates.workPlanItem.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ assigneeId: "b" }) }));
  });
  it("attributes new teacher records to the actual actor, never the first course teacher", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, announcements: [{ id: "notice", title: "Note", content: "Read", replies: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] }, teacher);
    expect(delegates.announcement.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ createdById: "teacher-2" }) }));
  });
  it("refuses to invent a teacher identity for system-authored notices", async () => {
    const before = fixture();
    await expect(persistInstanceCourse(db, before, { ...before, announcements: [{ id: "notice", title: "Note", content: "Read", replies: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] })).rejects.toMatchObject({ code: "CLASSROOM_ACTOR_REQUIRED" });
  });
  it("stores group contributions only against group members' participations", async () => {
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, teamContributions: [{ id: "contribution", courseId: "instance", groupId: "group", studentName: "Team", percent: 100, updatedAt: "2026-09-01T00:00:00Z" }] }, teacher);
    expect(delegates.classroomSubmission.upsert.mock.calls.map(([args]) => args.create.participationId)).toEqual(["p-a", "p-b"]);
    expect(delegates.evaluation.upsert).not.toHaveBeenCalled();
  });
  it("rejects unknown group targets instead of broadcasting to the class", async () => {
    const before = fixture();
    await expect(persistInstanceCourse(db, before, { ...before, feedback: [{ id: "feedback", courseId: "instance", targetType: "group", targetId: "foreign", stageKey: "make", kind: "comment", content: "Feedback", createdAt: "2026-09-01T00:00:00Z" }] }, teacher)).rejects.toMatchObject({ code: "GROUP_SCOPE_MISMATCH" });
    expect(delegates.evaluation.upsert).not.toHaveBeenCalled();
  });
  it("canonicalizes upload references from the owned FileAsset", async () => {
    delegates.fileAsset.findUnique.mockResolvedValue({ id: "asset", offeringId: "offering", uploadedById: "a", originalName: "actual.pdf", mimeType: "application/pdf", size: BigInt(12), deletedAt: null });
    const before = fixture();
    await persistInstanceCourse(db, before, { ...before, uploads: [{ id: "asset", courseId: "instance", studentId: "a", stageKey: "make", category: "artifact", title: "File", fileName: "forged", fileType: "HTML", size: "wrong", url: "https://foreign.example/file", createdAt: "2026-09-01T00:00:00Z" }] }, { id: "a", role: "student" });
    expect(delegates.classroomSubmission.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ payload: expect.objectContaining({ view: expect.objectContaining({ fileName: "actual.pdf", fileType: "application/pdf", url: "/api/uploads/asset", size: "12" }) }) }) }));
  });
});

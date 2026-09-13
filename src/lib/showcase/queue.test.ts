import { describe, expect, it } from "vitest";
import { buildShowcaseQueue, defaultShowcaseQueueOrder, normalizeMinutesPerStudent, preserveShowcaseQueueLockedPositions, showcaseRemainingSeconds } from "./queue";
import type { FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";

const artifact = (studentId: string, submittedAt: string, kind: "document" | "pdf" = "document"): FinalArtifactSummary => ({
  kind,
  versionId: `${studentId}-artifact`,
  title: `${studentId} 的成果`,
  sequence: 1,
  submittedAt,
  displayModes: kind === "pdf" ? ["continuous", "slides"] : ["continuous"],
});

const presentation = (studentId: string, status: ShowcasePresentationSnapshot["status"], updatedAt = "2026-09-05T10:00:00.000Z"): ShowcasePresentationSnapshot => ({
  id: `${studentId}-presentation`,
  courseId: "course-1",
  groupId: `${studentId}-group`,
  studentId,
  artifactKind: "document",
  artifactVersionId: `${studentId}-artifact`,
  artifactTitle: `${studentId} 的成果`,
  displayMode: "continuous",
  status,
  revision: 1,
  requestedAt: updatedAt,
  updatedAt,
});

describe("showcase queue", () => {
  it("sorts students by the first presentable submission and puts unready students last", () => {
    const students = [
      { studentId: "s3", name: "丙", artifacts: [] },
      { studentId: "s1", name: "甲", artifacts: [artifact("s1", "2026-09-05T09:03:00.000Z")] },
      { studentId: "s2", name: "乙", artifacts: [artifact("s2", "2026-09-05T09:01:00.000Z")] },
    ];
    expect(defaultShowcaseQueueOrder(students)).toEqual(["s2", "s1", "s3"]);
  });

  it("keeps the original readiness time when a student later replaces the artifact", () => {
    const students = [
      { studentId: "updated", name: "后提交但早就绪", firstPresentableSubmissionAt: "2026-09-05T09:01:00.000Z", artifacts: [artifact("updated", "2026-09-05T10:00:00.000Z")] },
      { studentId: "first", name: "首次提交", artifacts: [artifact("first", "2026-09-05T09:30:00.000Z")] },
    ];
    expect(defaultShowcaseQueueOrder(students)).toEqual(["updated", "first"]);
  });

  it("derives the classroom lifecycle and skips unready students for the next presenter", () => {
    const students = [
      { studentId: "s1", name: "甲", groupId: "g1", artifacts: [artifact("s1", "2026-09-05T09:01:00.000Z")] },
      { studentId: "s2", name: "乙", groupId: "g2", artifacts: [] },
      { studentId: "s3", name: "丙", groupId: "g3", artifacts: [artifact("s3", "2026-09-05T09:02:00.000Z")] },
    ];
    const active = { ...presentation("s1", "active", "2026-09-05T09:59:00.000Z"), startedAt: "2026-09-05T09:59:00.000Z" };
    const result = buildShowcaseQueue(students, [active], "s1", { orderedStudentIds: ["s1", "s2", "s3"], minutesPerStudent: 5 }, Date.parse("2026-09-05T10:01:00.000Z"));
    expect(result.items.map((item) => item.status)).toEqual(["presenting", "not-ready", "waiting"]);
    expect(result.current?.studentId).toBe("s1");
    expect(result.next?.studentId).toBe("s3");
    expect(result.next?.estimatedWaitMinutes).toBe(3);
  });

  it("marks evaluation and completion distinctly and normalizes the duration", () => {
    const students = [{ studentId: "s1", name: "甲", groupId: "g1", artifacts: [artifact("s1", "2026-09-05T09:01:00.000Z")] }];
    expect(normalizeMinutesPerStudent(100)).toBe(60);
    expect(buildShowcaseQueue(students, [presentation("s1", "evaluating")], "s1").current?.status).toBe("evaluating");
    expect(buildShowcaseQueue(students, [presentation("s1", "ended")], null).items[0]?.status).toBe("completed");
  });

  it("preserves started and completed slots while resetting the remaining order", () => {
    expect(preserveShowcaseQueueLockedPositions(
      ["started", "movable-a", "completed", "movable-b"],
      ["movable-b", "completed", "movable-a", "started"],
      new Set(["started", "completed"]),
    )).toEqual(["started", "movable-b", "completed", "movable-a"]);
  });

  it("only queues explicitly selected students and an empty selection stays empty", () => {
    const students = ["s1", "s2", "s3"].map((id) => ({ studentId: id, name: id, artifacts: [artifact(id, "2026-09-05T09:01:00.000Z")] }));
    const config = { schemaVersion: 2 as const, selectionMode: "teacher-selected" as const, selectedStudentIds: ["s2"], orderedStudentIds: ["s1", "s2"], presentationSec: 80, discussionSec: 25, transitionSec: 10 };
    const result = buildShowcaseQueue(students, [], null, config);
    expect(result.items.map((item) => item.studentId)).toEqual(["s2"]);
    expect(result.minutesPerStudent).toBe(115 / 60);
    expect(buildShowcaseQueue(students, [], null, { ...config, selectedStudentIds: [] }).items).toEqual([]);
  });

  it("preserves existing presentation history when restoring a selected queue", () => {
    const students = ["s1", "s2"].map((id) => ({ studentId: id, name: id, artifacts: [artifact(id, "2026-09-05T09:01:00.000Z")] }));
    const result = buildShowcaseQueue(students, [presentation("s1", "ended")], null, { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: [] });
    expect(result.items.map((item) => [item.studentId, item.status])).toEqual([["s1", "completed"]]);
    expect(result.next).toBeNull();
  });

  it("keeps discussion and transition time after presentation overruns and counts elapsed discussion", () => {
    const students = ["s1", "s2"].map((id) => ({ studentId: id, name: id, artifacts: [artifact(id, "2026-09-05T09:01:00.000Z")] }));
    const config = { schemaVersion: 2 as const, selectionMode: "teacher-selected" as const, selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"], presentationSec: 80, discussionSec: 60, transitionSec: 15 };
    const now = Date.parse("2026-09-05T10:02:00Z");
    const active = { ...presentation("s1", "active"), startedAt: "2026-09-05T10:00:00Z" };
    const presenting = buildShowcaseQueue(students, [active], "s1", config, now);
    expect(showcaseRemainingSeconds(presenting.current!, config, now)).toBe(75);
    const evaluating = buildShowcaseQueue(students, [{ ...active, status: "evaluating", endedAt: "2026-09-05T10:01:30Z" }], "s1", config, now);
    expect(showcaseRemainingSeconds(evaluating.current!, config, now)).toBe(45);
    expect(evaluating.next?.estimatedWaitMinutes).toBe(1);
    const restored = buildShowcaseQueue([{ ...students[0], artifacts: [] }], [presentation("s1", "ended")], null, { ...config, selectedStudentIds: [] });
    expect(restored.items[0]?.status).toBe("completed");
  });
});

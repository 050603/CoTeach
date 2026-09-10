import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ teacher: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));

import { createStudentRecordsArchive } from "./student-record-export";

const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const at = new Date("2026-09-10T08:00:00.000Z");
const offering = {
  id: "offering", name: "设计/思维", term: "秋季", status: "OPEN",
  chapters: [{
    id: "chapter", title: "第一章", position: 1, isOpen: true, opensAt: null, archivedAt: null,
    activities: [{ id: "activity", title: "问卷", type: "FORM", position: 1, isOpen: true, opensAt: null, archivedAt: null }],
  }],
  enrollments: [{
    id: "enrollment", status: "ACTIVE", joinedAt: at,
    user: { id: "student", username: "=formula", displayName: "小林" },
    activityProgress: [], submissions: [{ submittedAt: at }], participations: [],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
});

describe("student record export archive", () => {
  it("creates only the selected data files with a manifest and analysis-friendly JSON", async () => {
    const database = {
      courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
      courseOffering: { findUnique: vi.fn().mockResolvedValue(offering) },
      activityProgress: { findMany: vi.fn().mockResolvedValue([]) },
      activitySubmission: { findMany: vi.fn().mockResolvedValue([{ id: "attempt", enrollmentId: "enrollment", activityId: "activity", activityVersion: 2, activitySnapshot: { config: { questions: [{ id: "q" }] } }, payload: { answers: { q: "a" } }, submittedAt: at }]) },
    } as never;
    const archive = await createStudentRecordsArchive(claims, "offering", ["enrollment"], ["summary", "activity_progress", "activity_submissions", "summary_csv"], database, at);
    expect(archive.fileName).toBe("设计-思维-学生学习记录.zip");
    const zip = await JSZip.loadAsync(archive.bytes);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining([
      "README.txt", "manifest.json", "data/students.json", "data/activity-progress.json",
      "data/activity-submissions.json", "data/students-summary.csv", "reference/activity-catalog.json",
    ]));
    expect(zip.file("data/evaluations.json")).toBeNull();
    const progress = JSON.parse(await zip.file("data/activity-progress.json")!.async("string"));
    expect(progress.records).toEqual([expect.objectContaining({ enrollmentId: "enrollment", activityId: "activity", id: null, status: "not_started" })]);
    const submissions = JSON.parse(await zip.file("data/activity-submissions.json")!.async("string"));
    expect(submissions.records[0]).toMatchObject({ activitySnapshot: { config: { questions: [{ id: "q" }] } }, payload: { answers: { q: "a" } } });
    const csv = await zip.file("data/students-summary.csv")!.async("string");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("'=formula");
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest).toMatchObject({ archiveVersion: 1, studentCount: 1, selectedSections: ["summary", "activity_progress", "activity_submissions", "summary_csv"] });
  });

  it("rejects enrollment identifiers outside the active class list", async () => {
    const database = {
      courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
      courseOffering: { findUnique: vi.fn().mockResolvedValue(offering) },
    } as never;
    await expect(createStudentRecordsArchive(claims, "offering", ["foreign"], ["summary"], database, at)).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
  });
});

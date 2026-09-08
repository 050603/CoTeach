import { describe, expect, it, vi } from "vitest";
import {
  applySessionAction,
  initialSessionState,
  normalizeCourse,
  type SessionState,
} from "./actions";
import type {
  Course,
  CourseUpload,
  GroupBoard,
  ReflectionSurveyResponseV1,
  Student,
} from "./types";
import { DEFAULT_STAGES } from "./types";
import { DEFAULT_PBL_COURSE_CONFIG } from "@/lib/pbl-course-config";

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1",
    name: "测试课程",
    subject: "科学",
    grade: "六年级",
    hours: 8,
    summary: "测试摘要",
    drivingQuestion: "如何节能？",
    status: "teaching",
    stages: DEFAULT_STAGES,
    currentStageIndex: 0,
    content: {
      pblOutline: "大纲",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    students: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStudent(id: string, name: string): Student {
  return { id, name, joinedAt: "2024-01-01T00:00:00.000Z", stageProgress: {} };
}

function stateWithCourses(...courses: Course[]): SessionState {
  return { ...initialSessionState(), courses, hydrated: true };
}

describe("normalizeCourse — current five-stage system", () => {
  it("normalizes persisted courses into the supported stages", () => {
    const normalized = normalizeCourse(makeCourse({ currentStageIndex: 2 }));
    expect(normalized.stages.map((stage) => stage.key)).toEqual([
      "launch", "ai-learning", "make", "showcase", "reflection",
    ]);
    expect(normalized.stages[normalized.currentStageIndex]?.key).toBe("make");
    expect(normalized.pblConfig?.generationTemplate).toBe("new-ai-learning-only");
  });
});

describe("applySessionAction — reflection survey", () => {
  it("reuses the student's current structured record instead of creating duplicates", () => {
    const survey: ReflectionSurveyResponseV1 = {
      schemaVersion: 1,
      learningReflection: "新的收获",
      systemReflection: "新的体验",
      aiHelpfulness: 4,
      systemUsability: 5,
      reuseIntention: 4,
    };
    const existing = {
      id: "reflection-existing",
      courseId: "course-1",
      studentId: "student-1",
      studentName: "小林",
      content: "旧的结构化反思",
      survey,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:10:00.000Z",
    };
    const next = applySessionAction(stateWithCourses(makeCourse({
      students: [makeStudent("student-1", "小林")],
      reflections: [existing],
    })), {
      type: "UPSERT_REFLECTION",
      payload: {
        courseId: "course-1",
        reflection: {
          ...existing,
          id: "reflection-new-request",
          survey: { ...survey, learningReflection: "更新后的收获" },
          content: "更新后的结构化反思",
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      },
    });
    const valid = (next.courses[0]?.reflections ?? []).filter((item) => item.studentId === "student-1" && item.survey);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({
      id: "reflection-existing",
      createdAt: "2026-08-01T00:00:00.000Z",
      content: "更新后的结构化反思",
    });
  });
});

describe("applySessionAction — showcase presentation", () => {
  it("records presentation switching in the authorized canonical action", () => {
    const course = makeCourse({
      students: [makeStudent("s1", "林同学")],
      groups: [{
        id: "grp-s1",
        name: "林同学的项目",
        topic: "节能方案",
        keywords: [],
        selectedForms: [],
        members: [{ studentId: "s1", name: "林同学", role: "负责人" }],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }],
    });

    const next = applySessionAction(stateWithCourses(course), {
      type: "SET_PRESENTING_GROUP",
      payload: { courseId: course.id, groupId: "grp-s1" },
    });

    expect(next.courses[0].presentingGroupId).toBe("grp-s1");
    expect(next.courses[0].activityLog?.[0]).toMatchObject({
      actor: "教师",
      action: "切换当前个人汇报",
      detail: "林同学的个人项目",
    });
  });
});

describe("applySessionAction — classroom timing", () => {
  it("persists an absolute stage clock across start, stage changes, and finish", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-28T01:00:00.000Z"));
      const course = makeCourse({ status: "ready", hours: 1 });
      const started = applySessionAction(stateWithCourses(course), {
        type: "START_TEACHING",
        payload: {
          id: course.id,
          classConfig: { groupMode: "solo", totalStudents: 30 },
          inviteCode: "123456",
        },
      });
      const startedTiming = started.courses[0]!.uiState?.classroomTiming;
      expect(startedTiming).toMatchObject({
        status: "running",
        activeStageKey: "launch",
        sessionStartedAt: "2026-07-28T01:00:00.000Z",
      });
      expect(
        startedTiming?.stages.reduce(
          (sum, stage) => sum + stage.basePlannedSec + stage.adjustmentSec,
          0,
        ),
      ).toBe(3_600);

      vi.setSystemTime(new Date("2026-07-28T01:02:00.000Z"));
      const advanced = applySessionAction(started, {
        type: "SET_STAGE",
        payload: { id: course.id, index: 1 },
      });
      const advancedTiming = advanced.courses[0]!.uiState?.classroomTiming;
      expect(advancedTiming?.activeStageKey).toBe("ai-learning");
      expect(advancedTiming?.stages[0]).toMatchObject({
        stageKey: "launch",
        status: "completed",
        elapsedSec: 120,
      });
      expect(advancedTiming?.stages[1]).toMatchObject({
        stageKey: "ai-learning",
        status: "active",
      });

      vi.setSystemTime(new Date("2026-07-28T01:05:00.000Z"));
      const finished = applySessionAction(advanced, {
        type: "END_TEACHING",
        payload: { id: course.id },
      });
      const finishedTiming = finished.courses[0]!.uiState?.classroomTiming;
      expect(finishedTiming).toMatchObject({
        status: "completed",
        sessionEndedAt: "2026-07-28T01:05:00.000Z",
      });
      expect(finishedTiming?.stages[0]).toMatchObject({ elapsedSec: 120 });
      expect(finishedTiming?.stages[1]).toMatchObject({
        elapsedSec: 180,
        status: "completed",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applySessionAction — SET_STUDENT_TODO_COMPLETION", () => {
  it("changes only the requesting student's completion entry", () => {
    const course = makeCourse({
      students: [
        makeStudent("student-1", "张三"),
        makeStudent("student-2", "李四"),
      ],
      todos: [
        {
          id: "todo-1",
          title: "阅读项目说明",
          description: "",
          completedBy: ["student-2"],
        },
      ],
    });

    const completed = applySessionAction(stateWithCourses(course), {
      type: "SET_STUDENT_TODO_COMPLETION",
      payload: {
        courseId: course.id,
        todoId: "todo-1",
        studentId: "student-1",
        completed: true,
      },
    });
    expect(completed.courses[0].todos?.[0].completedBy).toEqual([
      "student-2",
      "student-1",
    ]);
    expect(
      completed.courses[0].students.find((student) => student.id === "student-1")
        ?.stageProgress,
    ).toEqual({});
    expect(
      completed.courses[0].students.find((student) => student.id === "student-2")
        ?.stageProgress["project-launch"],
    ).toBeUndefined();

    const reopened = applySessionAction(completed, {
      type: "SET_STUDENT_TODO_COMPLETION",
      payload: {
        courseId: course.id,
        todoId: "todo-1",
        studentId: "student-1",
        completed: false,
      },
    });
    expect(reopened.courses[0].todos?.[0].completedBy).toEqual(["student-2"]);
    expect(
      reopened.courses[0].students.find((student) => student.id === "student-1")
        ?.stageProgress,
    ).toEqual({});
  });

  it("keeps todo completion as an operational record without changing learning readiness", () => {
    const student = makeStudent("student-1", "张三");
    const course = makeCourse({
      students: [student],
      todos: [
        { id: "todo-1", title: "一", description: "", completedBy: [] },
        { id: "todo-2", title: "二", description: "", completedBy: [] },
        {
          id: "later",
          title: "后续任务",
          description: "",
          stageKey: "proposal",
          completedBy: [],
        },
      ],
    });

    const next = applySessionAction(stateWithCourses(course), {
      type: "SET_STUDENT_TODO_COMPLETION",
      payload: {
        courseId: course.id,
        todoId: "todo-1",
        studentId: student.id,
        completed: true,
      },
    });

    expect(next.courses[0].todos?.[0].completedBy).toEqual(["student-1"]);
    expect(next.courses[0].students[0].stageProgress).toEqual({});
  });
});

describe("applySessionAction — JOIN_CLASS", () => {
  it("adds the student to the course and sets joinedCourseId/studentId/studentName", () => {
    const course = makeCourse();
    const state = stateWithCourses(course);
    const student = makeStudent("s1", "张三");

    const next = applySessionAction(state, {
      type: "JOIN_CLASS",
      payload: { courseId: course.id, student },
    });

    expect(next.joinedCourseId).toBe(course.id);
    expect(next.studentId).toBe("s1");
    expect(next.studentName).toBe("张三");
    expect(next.courses[0].students).toHaveLength(1);
    expect(next.courses[0].students[0].name).toBe("张三");
    expect(next.courses[0].groups).toHaveLength(1);
    expect(next.courses[0].groups?.[0]).toMatchObject({
      id: "grp-s1",
      name: "张三的个人项目",
      members: [{ studentId: "s1", name: "张三", role: "项目负责人" }],
    });
  });

  it("does not duplicate the student if they already joined", () => {
    const student = makeStudent("s1", "张三");
    const course = makeCourse({ students: [student] });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "JOIN_CLASS",
      payload: { courseId: course.id, student },
    });

    expect(next.courses[0].students).toHaveLength(1);
  });

  it("adds an activity log entry", () => {
    const course = makeCourse();
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "JOIN_CLASS",
      payload: { courseId: course.id, student: makeStudent("s1", "张三") },
    });

    expect(next.courses[0].activityLog).toBeDefined();
    expect(next.courses[0].activityLog!.length).toBeGreaterThan(0);
    expect(next.courses[0].activityLog![0].actor).toBe("张三");
    expect(next.courses[0].activityLog![0].action).toBe("加入课堂");
  });
});

describe("applySessionAction — LEAVE_CLASS", () => {
  it("removes the student and their personal project space", () => {
    const student = makeStudent("s1", "张三");
    const course = makeCourse({
      students: [student],
      groups: [
        {
          id: "g1",
          name: "第1组",
          topic: "待确定选题方向",
          keywords: [],
          selectedForms: [],
          members: [{ studentId: "s1", name: "张三", role: "成员" }],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "LEAVE_CLASS",
      payload: { courseId: course.id, studentId: "s1" },
    });

    expect(next.courses[0].students).toHaveLength(0);
    expect(next.courses[0].groups).toHaveLength(0);
  });

  it("clears joinedCourseId/studentId when the leaving student is the current user", () => {
    const student = makeStudent("s1", "张三");
    const course = makeCourse({ students: [student] });
    const state: SessionState = {
      ...stateWithCourses(course),
      joinedCourseId: course.id,
      studentId: "s1",
      studentName: "张三",
    };

    const next = applySessionAction(state, {
      type: "LEAVE_CLASS",
      payload: { courseId: course.id, studentId: "s1" },
    });

    expect(next.joinedCourseId).toBeUndefined();
    expect(next.studentId).toBeUndefined();
    expect(next.studentName).toBeUndefined();
  });
});

describe("applySessionAction — UPDATE_STUDENT_PROGRESS", () => {
  it("updates the stage progress for the specified student", () => {
    const student = makeStudent("s1", "张三");
    const course = makeCourse({ students: [student] });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "UPDATE_STUDENT_PROGRESS",
      payload: { courseId: course.id, studentId: "s1", stageKey: "showcase", value: 85 },
    });

    expect(next.courses[0].students[0].stageProgress.showcase).toBe(85);
  });

  it("does not change currentStageIndex", () => {
    const student = makeStudent("s1", "张三");
    const course = makeCourse({ students: [student], currentStageIndex: 3 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "UPDATE_STUDENT_PROGRESS",
      payload: { courseId: course.id, studentId: "s1", stageKey: "make", value: 100 },
    });

    expect(next.courses[0].currentStageIndex).toBe(3);
  });

  it("preserves other students' progress", () => {
    const s1 = makeStudent("s1", "张三");
    const s2 = makeStudent("s2", "李四");
    const course = makeCourse({ students: [s1, s2] });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "UPDATE_STUDENT_PROGRESS",
      payload: { courseId: course.id, studentId: "s1", stageKey: "make", value: 50 },
    });

    expect(next.courses[0].students[0].stageProgress.make).toBe(50);
    expect(next.courses[0].students[1].stageProgress.make).toBeUndefined();
  });
});

describe("applySessionAction — ADVANCE_STAGE", () => {
  it("advances the stage index by 1", () => {
    const course = makeCourse({ currentStageIndex: 2 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "ADVANCE_STAGE",
      payload: { id: course.id, direction: 1 },
    });

    expect(next.courses[0].currentStageIndex).toBe(3);
  });

  it("does not advance past the last stage", () => {
    const course = makeCourse({ currentStageIndex: DEFAULT_STAGES.length - 1 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "ADVANCE_STAGE",
      payload: { id: course.id, direction: 1 },
    });

    expect(next.courses[0].currentStageIndex).toBe(DEFAULT_STAGES.length - 1);
  });

  it("does not go below stage 0", () => {
    const course = makeCourse({ currentStageIndex: 0 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "ADVANCE_STAGE",
      payload: { id: course.id, direction: -1 },
    });

    expect(next.courses[0].currentStageIndex).toBe(0);
  });

  it("stops teacher resource projection when the stage changes", () => {
    const course = makeCourse({
      uiState: {
        teacherResourceProjection: {
          classroomId: "teacher-classroom",
          sceneId: "scene-1",
          stageKey: "launch",
          title: "课程引入",
          sceneType: "slide",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      },
    });

    const next = applySessionAction(stateWithCourses(course), {
      type: "ADVANCE_STAGE",
      payload: { id: course.id, direction: 1 },
    });

    expect(next.courses[0].uiState?.teacherResourceProjection).toBeNull();
  });

  it("automatically selects the only teacher-authored inquiry question", () => {
    const course = makeCourse({
      pblConfig: {
        ...DEFAULT_PBL_COURSE_CONFIG,
        inquiryQuestions: ["我们如何减少校园用水浪费？"],
      },
    });

    const next = applySessionAction(stateWithCourses(course), {
      type: "JOIN_CLASS",
      payload: { courseId: course.id, student: makeStudent("s1", "张三") },
    });

    expect(next.courses[0].groups?.[0].topic).toBe("我们如何减少校园用水浪费？");
  });
});

describe("applySessionAction — UPSERT_UPLOAD", () => {
  it("adds a new upload to the course", () => {
    const course = makeCourse();
    const state = stateWithCourses(course);
    const upload: CourseUpload = {
      id: "u1",
      courseId: course.id,
      groupId: "g1",
      stageKey: "showcase",
      category: "artifact",
      title: "研究报告",
      fileName: "report.pdf",
      fileType: "PDF",
      size: "1.2 MB",
      url: "/api/uploads?file=report.pdf",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    const next = applySessionAction(state, {
      type: "UPSERT_UPLOAD",
      payload: { courseId: course.id, upload },
    });

    expect(next.courses[0].uploads).toHaveLength(1);
    expect(next.courses[0].uploads![0].fileName).toBe("report.pdf");
  });

  it("updates an existing upload with the same id", () => {
    const existing: CourseUpload = {
      id: "u1",
      courseId: "course-1",
      stageKey: "showcase",
      category: "artifact",
      title: "旧标题",
      fileName: "old.pdf",
      fileType: "PDF",
      size: "1 MB",
      url: "/api/uploads?file=old.pdf",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const course = makeCourse({ uploads: [existing] });
    const state = stateWithCourses(course);

    const updated: CourseUpload = { ...existing, title: "新标题", fileName: "new.pdf" };
    const next = applySessionAction(state, {
      type: "UPSERT_UPLOAD",
      payload: { courseId: course.id, upload: updated },
    });

    expect(next.courses[0].uploads).toHaveLength(1);
    expect(next.courses[0].uploads![0].title).toBe("新标题");
    expect(next.courses[0].uploads![0].fileName).toBe("new.pdf");
  });
});

describe("applySessionAction — UPSERT_GROUP_BOARD", () => {
  it("creates a new board when none exists for the group", () => {
    const course = makeCourse();
    const state = stateWithCourses(course);
    const board: GroupBoard = {
      groupId: "g1",
      snapshot: { schema: {} },
      updatedAt: "2024-01-01T00:00:00.000Z",
      mode: "mindmap",
    };

    const next = applySessionAction(state, {
      type: "UPSERT_GROUP_BOARD",
      payload: { courseId: course.id, board },
    });

    expect(next.courses[0].boards).toHaveLength(1);
    expect(next.courses[0].boards![0].groupId).toBe("g1");
    expect(next.courses[0].boards![0].mode).toBe("mindmap");
  });

  it("replaces an existing board for the same group", () => {
    const existing: GroupBoard = {
      groupId: "g1",
      snapshot: { old: true },
      updatedAt: "2024-01-01T00:00:00.000Z",
      mode: "mindmap",
    };
    const course = makeCourse({ boards: [existing] });
    const state = stateWithCourses(course);

    const updated: GroupBoard = {
      groupId: "g1",
      snapshot: { new: true },
      updatedAt: "2024-01-02T00:00:00.000Z",
      mode: "whiteboard",
    };
    const next = applySessionAction(state, {
      type: "UPSERT_GROUP_BOARD",
      payload: { courseId: course.id, board: updated },
    });

    expect(next.courses[0].boards).toHaveLength(1);
    expect(next.courses[0].boards![0].mode).toBe("whiteboard");
    expect(next.courses[0].boards![0].updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });
});

describe("applySessionAction — HYDRATE", () => {
  it("replaces the entire state with the payload", () => {
    const oldState = stateWithCourses(makeCourse());
    const newCourse = makeCourse({ id: "course-2", name: "新课程" });
    const newState: SessionState = {
      ...initialSessionState(),
      courses: [newCourse],
      hydrated: true,
      updatedAt: "2024-06-01T00:00:00.000Z",
    };

    const next = applySessionAction(oldState, {
      type: "HYDRATE",
      payload: newState,
    });

    expect(next.courses).toHaveLength(1);
    expect(next.courses[0].id).toBe("course-2");
    expect(next.courses[0].name).toBe("新课程");
  });
});

describe("applySessionAction — SET_PREVIEW_UPLOAD", () => {
  it("sets previewUploadId in uiState", () => {
    const course = makeCourse();
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "SET_PREVIEW_UPLOAD",
      payload: { courseId: course.id, uploadId: "u1" },
    });

    expect(next.courses[0].uiState?.previewUploadId).toBe("u1");
  });

  it("can clear previewUploadId by passing undefined", () => {
    const course = makeCourse({ uiState: { previewUploadId: "u1" } });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "SET_PREVIEW_UPLOAD",
      payload: { courseId: course.id, uploadId: undefined },
    });

    expect(next.courses[0].uiState?.previewUploadId).toBeUndefined();
  });
});

describe("applySessionAction — SET_STAGE", () => {
  it("sets the currentStageIndex to the specified value", () => {
    const course = makeCourse({ currentStageIndex: 0 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "SET_STAGE",
      payload: { id: course.id, index: 4 },
    });

    expect(next.courses[0].currentStageIndex).toBe(4);
  });

  it("clamps the index to valid range", () => {
    const course = makeCourse({ currentStageIndex: 0 });
    const state = stateWithCourses(course);

    const next = applySessionAction(state, {
      type: "SET_STAGE",
      payload: { id: course.id, index: 999 },
    });

    expect(next.courses[0].currentStageIndex).toBe(DEFAULT_STAGES.length - 1);
  });
});

describe("applySessionAction — evidence-driven classroom records", () => {
  it("stores a student help request as an operational signal, not learning evidence", () => {
    const course = makeCourse({ students: [makeStudent("student-1", "张三")] });
    const detectedAt = new Date().toISOString();
    const signal = {
      id: "help-1",
      courseId: course.id,
      studentId: "student-1",
      stageKey: "make",
      kind: "student-help-request" as const,
      severity: "warning" as const,
      status: "open" as const,
      title: "学生主动请求帮助",
      summary: "需要教师查看当前任务",
      normalizedIssueKey: "student-help-request:student-1:make",
      evidenceEventIds: [],
      aiInterventionAttempts: 0,
      firstDetectedAt: detectedAt,
      lastDetectedAt: detectedAt,
    };

    const next = applySessionAction(stateWithCourses(course), {
      type: "REQUEST_TEACHER_HELP",
      payload: { courseId: course.id, signal },
    });

    expect(next.courses[0].learningSignals).toEqual([signal]);
    expect(next.courses[0].learningEvidence).toEqual([]);
  });

  it("upserts and teacher-calibrates learning evidence", () => {
    const course = makeCourse({ students: [makeStudent("student-1", "张三")] });
    const evidence = {
      id: "evidence-intent",
      schemaVersion: 1 as const,
      courseId: course.id,
      studentId: "student-1",
      stageKey: "launch",
      kind: "project-intent" as const,
      title: "项目立意",
      summary: "校园节水",
      payload: {
        concern: "浪费水",
        affectedPeople: "全校",
        importance: "减少浪费",
        successIndicator: "用水量下降",
        personalQuestion: "如何减少浪费？",
      },
      status: "submitted" as const,
      source: "student" as const,
      countsTowardReadiness: true,
      evidenceRefs: [],
      artifactSnapshotIds: [],
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };

    const saved = applySessionAction(stateWithCourses(course), {
      type: "UPSERT_LEARNING_EVIDENCE",
      payload: { courseId: course.id, evidence },
    });
    const reviewed = applySessionAction(saved, {
      type: "REVIEW_LEARNING_EVIDENCE",
      payload: {
        courseId: course.id,
        evidenceId: evidence.id,
        status: "teacher-confirmed",
        feedback: "范围清楚",
        reviewedAt: "2026-07-31T00:05:00.000Z",
      },
    });

    expect(reviewed.courses[0].learningEvidence?.[0]).toMatchObject({
      id: evidence.id,
      status: "teacher-confirmed",
      teacherFeedback: "范围清楚",
      confirmedAt: "2026-07-31T00:05:00.000Z",
    });
  });

  it("records a student AI decision and closes the contribution", () => {
    const course = makeCourse({
      aiContributions: [{
        id: "contribution-1",
        courseId: "course-1",
        studentId: "student-1",
        stageKey: "proposal",
        companionId: "planner",
        impact: "high",
        request: "检查我的方案",
        suggestion: "缩小测试范围",
        sourceEvidenceIds: ["evidence-plan"],
        status: "pending-decision",
        createdAt: "2026-07-31T00:00:00.000Z",
      }],
    });
    const next = applySessionAction(stateWithCourses(course), {
      type: "RECORD_STUDENT_AI_DECISION",
      payload: {
        courseId: course.id,
        decision: {
          id: "decision-1",
          courseId: course.id,
          studentId: "student-1",
          stageKey: "proposal",
          contributionId: "contribution-1",
          decision: "modified",
          reason: "保留真实测试对象",
          appliedChangeSummary: "把样本改为两个班级",
          resultingEvidenceIds: ["evidence-plan-v2"],
          decidedAt: "2026-07-31T00:10:00.000Z",
        },
      },
    });
    expect(next.courses[0].studentAiDecisions).toHaveLength(1);
    expect(next.courses[0].aiContributions?.[0].status).toBe("decided");
  });

  it("rolls operational learning signals after 30 days without deleting learning evidence", () => {
    const now = Date.now();
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const normalized = normalizeCourse(makeCourse({
      learningEvents: [
        { id: "old", idempotencyKey: "old", courseId: "course-1", studentId: "s1", stageKey: "make", type: "heartbeat", occurredAt: old },
        { id: "recent", idempotencyKey: "recent", courseId: "course-1", studentId: "s1", stageKey: "make", type: "heartbeat", occurredAt: recent },
      ],
      learningEvidence: [{
        id: "permanent-evidence",
        schemaVersion: 1,
        courseId: "course-1",
        studentId: "s1",
        stageKey: "make",
        kind: "test-result",
        title: "真实测试",
        summary: "保留",
        payload: {
          iterationId: "iteration-1",
          method: "观察",
          target: "样机",
          observation: "有变化",
          result: "有效",
        },
        status: "submitted",
        source: "student",
        countsTowardReadiness: true,
        evidenceRefs: [],
        artifactSnapshotIds: [],
        createdAt: old,
        updatedAt: old,
      }],
    }));
    expect(normalized.learningEvents?.map((item) => item.id)).toEqual(["recent"]);
    expect(normalized.learningEvidence?.map((item) => item.id)).toEqual([
      "permanent-evidence",
    ]);
  });
});

describe("normalizeCourse — evidence-driven full upgrade", () => {
  it("normalizes pre-upgrade stage structures onto the current five-stage model", () => {
    const legacyStages = [
      ...DEFAULT_STAGES.slice(0, 2),
      { key: "group", label: "小组构思", view: "group" as const, description: "组队" },
      { key: "review", label: "方案汇报与纠偏", view: "workspace" as const, description: "汇报" },
      ...DEFAULT_STAGES.slice(3),
    ];
    const legacy = makeCourse({
      stages: legacyStages,
      currentStageIndex: 3,
      classConfig: { groupMode: "free", totalStudents: 36, perGroup: 6 },
      content: {
        ...makeCourse().content,
        evaluationPlan: {
          dimensions: [],
          overallRubric: "旧评价方案",
          flows: [
            { id: "legacy-ai", sourceRole: "ai", name: "AI", weight: 30, evidenceRequirements: [], enabled: true },
            { id: "legacy-teacher", sourceRole: "teacher", name: "教师", weight: 50, evidenceRequirements: [], enabled: true },
            { id: "legacy-peer", sourceRole: "peer", name: "同伴", weight: 10, evidenceRequirements: [], enabled: true },
            { id: "legacy-self", sourceRole: "self", name: "自评", weight: 10, evidenceRequirements: [], enabled: true },
          ],
        },
      },
      feedback: [{ id: "f1", courseId: "course-1", targetType: "group", targetId: "g1", stageKey: "review", kind: "comment", content: "请补充证据", createdAt: "2024-01-01T00:00:00.000Z" }],
    });
    const result = normalizeCourse(legacy);
    expect(result.stages.map((stage) => stage.key)).toEqual(["launch", "ai-learning", "make", "showcase", "reflection"]);
    expect(result.stages[result.currentStageIndex].key).toBe("make");
    expect(result.classConfig).toMatchObject({ groupMode: "solo", perGroup: 1, crossClass: false });
    expect(result.feedback?.[0]).toMatchObject({ sourceRole: "teacher", status: "open", evidence: [] });
    expect(result.content.evaluationPlan.flows).toEqual([
      expect.objectContaining({ sourceRole: "ai", weight: 40, scored: true }),
      expect.objectContaining({ sourceRole: "teacher", weight: 60, scored: true }),
      expect.objectContaining({ sourceRole: "self", weight: 0, scored: false }),
    ]);
    expect(result.content.evaluationPlan.flows?.some((flow) => flow.sourceRole === "peer")).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.learningEvents).toEqual([]);
    expect(result.companionThreads).toEqual([]);
    expect(result.learningSignals).toEqual([]);
    expect(result.classCommonIssues).toEqual([]);
    expect(result.teacherAgentDirectives).toEqual([]);
    expect(result.offlineInterventions).toEqual([]);
    expect(result.dynamicFacilitationScaffolds).toEqual([]);
  });
});

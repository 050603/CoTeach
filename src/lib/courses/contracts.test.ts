import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "./contracts";

const requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b";

describe("ActionEnvelopeSchema", () => {
  it("accepts a bounded, valid progress update", () => {
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPDATE_STUDENT_PROGRESS",
        payload: {
          courseId: "course-1",
          studentId: "student-1",
          stageKey: "research",
          value: 75,
        },
      },
    }).success).toBe(true);
  });

  it("accepts a student code artifact submission", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_SUBMISSION",
        payload: {
          courseId: "course-1",
          submission: {
            id: "submission-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            stageKey: "make",
            type: "code",
            title: "Python 项目代码",
            content: JSON.stringify({ version: 1, language: "python", activeFileId: "main", files: [] }),
            status: "draft",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(true);
  });

  it("accepts the structured five-stage reflection response", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_REFLECTION",
        payload: {
          courseId: "course-1",
          reflection: {
            id: "reflection-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            content: "【课程收获】\n完成了一次迭代",
            survey: {
              schemaVersion: 1,
              learningReflection: "完成了一次迭代",
              systemReflection: "AI 提问有帮助",
              aiHelpfulness: 4,
              systemUsability: 5,
              reuseIntention: 4,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(true);
  });

  it("rejects invalid progress, unknown actions, and non-UUID request IDs", () => {
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPDATE_STUDENT_PROGRESS",
        payload: {
          courseId: "course-1",
          studentId: "student-1",
          stageKey: "research",
          value: 101,
        },
      },
    }).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: { type: "UNSAFE_ACTION", payload: {} },
    }).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({
      requestId: "not-a-uuid",
      action: { type: "SET_UI_STATE", payload: {} },
    }).success).toBe(false);
  });

  it("validates the bounded projection control payload", () => {
    const valid = ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "SET_UI_STATE",
        payload: {
          courseId: "course-1",
          patch: { resourceProjection: null },
        },
      },
    });
    const invalid = ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "SET_UI_STATE",
        payload: {
          courseId: "course-1",
          patch: {
            resourceProjection: {
              resourceId: "resource-1",
              stageKey: "launch",
              title: "视频",
              startedAt: "not-a-date",
            },
          },
        },
      },
    });
    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it("rejects incomplete survey scores or answers", () => {
    const now = new Date().toISOString();
    expect(ActionEnvelopeSchema.safeParse({
      requestId,
      action: {
        type: "UPSERT_REFLECTION",
        payload: {
          courseId: "course-1",
          reflection: {
            id: "reflection-1",
            courseId: "course-1",
            studentId: "student-1",
            studentName: "学生",
            content: "内容",
            survey: {
              schemaVersion: 1,
              learningReflection: "",
              systemReflection: "体验",
              aiHelpfulness: 4,
              systemUsability: 5,
              reuseIntention: 4,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    }).success).toBe(false);
  });
});

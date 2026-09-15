import { describe, expect, it } from "vitest";
import {
  createCourseMediaGenerationIncompleteError,
  createManagedCourseGenerationRecoveryRequest,
  deserializeCourseGenerationFailure,
  formatCourseGenerationErrorForTeacher,
  formatPersistedCourseGenerationErrorForTeacher,
  serializeCourseGenerationFailure,
} from "./failure-policy";

const inferenceAbort = new Error(
  "An error occurred in model serving, error message is: [Inference engine abort. Finish reason: [UNKNOWN].]",
);

describe("managed classroom-generation recovery", () => {
  it("does not layer job recovery over exhausted request retries", () => {
    expect(createManagedCourseGenerationRecoveryRequest(
      { courseId: "course-1" },
      inferenceAbort,
    )).toBeNull();
  });

  it("keeps old whiteboard quality failures terminal", () => {
    const legacyFailure = serializeCourseGenerationFailure(new Error(
      'Scene 3/12 "PBL与探究式教学" failed: 白板仍存在布局或内容问题：文字过小或超出文本框',
    ));

    expect(deserializeCourseGenerationFailure(legacyFailure)).toMatchObject({ isRetryable: false });
    expect(createManagedCourseGenerationRecoveryRequest({}, deserializeCourseGenerationFailure(legacyFailure)))
      .toBeNull();
  });

  it("does not create an unbounded recovery loop", () => {
    expect(createManagedCourseGenerationRecoveryRequest(
      { courseId: "course-1", managedRecoveryCount: 2 },
      inferenceAbort,
    )).toBeNull();
  });

  it("does not restart generation before the first checkpoint", () => {
    expect(createManagedCourseGenerationRecoveryRequest(
      { courseId: "course-1" },
      inferenceAbort,
    )).toBeNull();
  });

  it("preserves retry classification across persistence without exposing diagnostics", () => {
    const persisted = serializeCourseGenerationFailure(inferenceAbort);

    expect(persisted).toContain("OPENPBL_COURSE_GENERATION_FAILURE_V1");
    expect(deserializeCourseGenerationFailure(persisted)).toMatchObject({
      isRetryable: false,
    });
    const teacherMessage = formatPersistedCourseGenerationErrorForTeacher(persisted);
    expect(teacherMessage).toContain("已经生成的页面均已保留");
    expect(teacherMessage).not.toContain("Inference engine");
  });

  it("keeps legacy transient failure rows recoverable", () => {
    const legacy = "AI 页面生成服务连续多次未能完成最后的课堂页面；已经生成的页面均已保留，请稍后继续。";
    expect(deserializeCourseGenerationFailure(legacy)).toMatchObject({
      isRetryable: true,
    });
  });

  it("keeps teaching-tool omissions terminal", () => {
    const persisted = serializeCourseGenerationFailure(new Error(
      'Scene "节末小测" is missing required teaching tools after correction: whiteboard',
    ));

    expect(deserializeCourseGenerationFailure(persisted)).toMatchObject({
      isRetryable: false,
    });
  });

  it("redacts common credentials from persisted diagnostics", () => {
    const persisted = serializeCourseGenerationFailure(new Error(
      "Authorization: Bearer live-token-123; api_key=sk-example-secret; password=hunter2",
    ));

    expect(persisted).not.toContain("live-token-123");
    expect(persisted).not.toContain("sk-example-secret");
    expect(persisted).not.toContain("hunter2");
    expect(persisted).toContain("[REDACTED]");
  });

  it("does not expose raw model-serving diagnostics to teachers", () => {
    const message = formatCourseGenerationErrorForTeacher(inferenceAbort);
    expect(message).toContain("已经生成的页面均已保留");
    expect(message).not.toContain("Inference engine");
  });

  it("does not restart the entire classroom when optional media repair is exhausted", () => {
    const error = createCourseMediaGenerationIncompleteError({ imageCount: 3, videoCount: 0 });
    const persisted = serializeCourseGenerationFailure(error);

    expect(deserializeCourseGenerationFailure(persisted)).toMatchObject({
      code: "COURSE_MEDIA_GENERATION_INCOMPLETE",
      isRetryable: false,
    });
    expect(formatPersistedCourseGenerationErrorForTeacher(persisted)).toContain("3 张课程图片");
    expect(createManagedCourseGenerationRecoveryRequest({}, error)).toBeNull();
  });

  it("shows an actionable configuration error when image generation was enabled without a provider", () => {
    const error = Object.assign(new Error(
      "课程已开启图片生成，但服务器没有可用的图片生成服务。请先完成图像生成配置。",
    ), { code: "IMAGE_PROVIDER_NOT_CONFIGURED", isRetryable: false });

    expect(formatPersistedCourseGenerationErrorForTeacher(
      serializeCourseGenerationFailure(error),
    )).toContain("请先完成图像生成配置");
  });
});

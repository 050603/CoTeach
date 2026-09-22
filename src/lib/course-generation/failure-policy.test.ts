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
  it.each([true, false])('explains persisted socket disconnections with retryable=%s', (retryable) => {
    const persisted = 'OPENPBL_COURSE_GENERATION_FAILURE_V1:' + JSON.stringify({
      version: 1, retryable, name: 'Error',
      message: 'Scene 20/22 failed: Cannot connect to API: other side closed',
    });
    expect(deserializeCourseGenerationFailure(persisted)).toMatchObject({ isRetryable: retryable });
    const message = formatPersistedCourseGenerationErrorForTeacher(persisted);
    expect(message).toContain('网络连接中断');
    expect(message).toContain('请点击继续生成');
    expect(message).not.toContain('无法继续的系统错误');
    expect(message).not.toContain('连续多次');
  });

  it('preserves SDK socket retryability through scene context and persistence', () => {
    const error = new Error('Scene 20/22 failed: Cannot connect to API: other side closed', {
      cause: Object.assign(new Error('Cannot connect to API: other side closed'), {
        isRetryable: true, cause: { code: 'UND_ERR_SOCKET' },
      }),
    });
    expect(deserializeCourseGenerationFailure(serializeCourseGenerationFailure(error)))
      .toMatchObject({ isRetryable: true });
  });

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
    expect(teacherMessage).toContain("已经完成的阶段结果均已保留");
    expect(teacherMessage).not.toContain("Inference engine");
  });

  it("keeps legacy transient failure rows recoverable", () => {
    const legacy = "AI 页面生成服务连续多次未能完成最后的课堂页面；已经生成的页面均已保留，请稍后继续。";
    expect(deserializeCourseGenerationFailure(legacy)).toMatchObject({
      isRetryable: true,
    });
  });

  it("describes a single long model timeout without claiming multiple retries", () => {
    const timeout = new DOMException("Course model request timed out", "TimeoutError");
    const message = formatPersistedCourseGenerationErrorForTeacher(
      serializeCourseGenerationFailure(timeout),
    );

    expect(message).toContain("等待模型完整输出时超时");
    expect(message).toContain("可从断点继续生成");
    expect(message).not.toContain("连续多次");
  });

  it("reports a teaching-design transport failure at its real stage", () => {
    const error = new Error(
      "教学增强未完整生成，未进入页面制作：教学增强小节生成失败（Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9999）",
    );
    const message = formatPersistedCourseGenerationErrorForTeacher(
      serializeCourseGenerationFailure(error),
    );

    expect(message).toContain("分小节教学设计阶段");
    expect(message).toContain("尚未进入 PPT 页面制作");
    expect(message).toContain("请点击继续生成");
    expect(message).not.toContain("最后的课堂页面");
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
    expect(message).toContain("已经完成的阶段结果均已保留");
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

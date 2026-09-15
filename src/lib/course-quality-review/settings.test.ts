import { describe, expect, it } from "vitest";
import {
  CourseQualityReviewSettingsError,
  validateCourseQualityReviewModel,
} from "./settings";

describe("course quality review model settings", () => {
  const configured = {
    deepseek: {
      models: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      defaultModel: "deepseek-v4-flash",
    },
  };

  it("accepts a configured model whose catalog metadata declares vision", () => {
    expect(() => validateCourseQualityReviewModel(
      "deepseek:deepseek-v4-flash-vision-exp",
      configured,
    )).not.toThrow();
  });

  it("rejects a text-only model and an unconfigured model", () => {
    expect(() => validateCourseQualityReviewModel(
      "deepseek:deepseek-v4-flash",
      configured,
    )).toThrow(CourseQualityReviewSettingsError);
    expect(() => validateCourseQualityReviewModel(
      "deepseek:deepseek-v4-pro",
      configured,
    )).toThrow("不在该服务商当前启用的模型列表");
    expect(() => validateCourseQualityReviewModel("not-a-qualified-model", configured))
      .toThrow(CourseQualityReviewSettingsError);
  });
});

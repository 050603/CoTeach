import { describe, expect, it } from "vitest";
import { parseQuizGradeResponse } from "./grade-response";

describe("quiz grade response", () => {
  it("preserves valid numeric scores, including zero", () => {
    expect(parseQuizGradeResponse('{"score":0,"comment":"未作答"}', 6)).toEqual({ score: 0, comment: "未作答" });
    expect(parseQuizGradeResponse('{"score":2.5,"comment":"部分正确"}', 6)).toEqual({ score: 2.5, comment: "部分正确" });
  });

  it("rejects malformed or out-of-range scores instead of granting partial marks", () => {
    for (const value of ["暂时无法评分", '{"score":"3","comment":"好"}', '{"score":-1}', '{"score":9}']) {
      expect(() => parseQuizGradeResponse(value, 6)).toThrow();
    }
  });
});

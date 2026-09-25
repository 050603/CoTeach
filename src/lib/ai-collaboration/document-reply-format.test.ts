import { describe, expect, it } from "vitest";
import { formatDocumentReplyForDisplay } from "./document-reply-format";

describe("formatDocumentReplyForDisplay", () => {
  it("turns inline numbered steps into a readable list", () => {
    expect(formatDocumentReplyForDisplay("建议这样做：1. 先记录数据；2. 再比较结果；3. 最后说明取舍。"))
      .toBe("建议这样做：\n\n1. 先记录数据；\n2. 再比较结果；\n3. 最后说明取舍。");
    expect(formatDocumentReplyForDisplay("一、先记录。二、再比较。"))
      .toBe("1. 先记录。\n2. 再比较。");
  });

  it("keeps ordinary numbers, existing lists, and code intact", () => {
    const content = "结果是 1.5 倍。\n\n1. 已记录。\n2. 已比较。\n\n```text\n1. a 2. b\n```";
    expect(formatDocumentReplyForDisplay(content)).toBe(content);
  });
});

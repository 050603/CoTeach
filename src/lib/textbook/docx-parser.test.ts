import { existsSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseTextbookDocx, splitTextbookHeading } from "./docx-parser";
import { extractTextbookKnowledge } from "./extraction";
import { buildRetrievalChunks, chineseSearchTokens } from "./text";

const attachment = "/home/lkj/.codex/attachments/796afab8-6aea-49a9-bbcd-c8070b110445/人工智能学科教师素养提升-第三章.docx";

async function fixtureDocx() {
  const zip = new JSZip();
  zip.file("docProps/core.xml", '<cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>测试教材</dc:title><dc:creator>教师</dc:creator></cp:coreProperties>');
  zip.file("word/styles.xml", '<w:styles xmlns:w="urn:w"><w:style w:type="paragraph" w:styleId="toc"><w:name w:val="toc 1"/></w:style><w:style w:type="paragraph" w:styleId="h"><w:name w:val="heading 1"/><w:outlineLvl w:val="0"/></w:style></w:styles>');
  zip.file("word/document.xml", '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="toc"/></w:pPr><w:r><w:t>不存在的章节99</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="h"/></w:pPr><w:r><w:t>第一章 正文</w:t></w:r></w:p><w:p><w:r><w:t>这是实际正文。例如，可以用分类游戏理解模型。</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("textbook DOCX parsing", () => {
  it("keeps TOC entries out of sections and retrieval chunks", async () => {
    const parsed = parseTextbookDocx(await fixtureDocx());
    expect(parsed.sections.map((section) => section.title)).toEqual(["正文"]);
    expect(parsed.blocks.find((block) => block.type === "TITLE")).toMatchObject({
      content: "正文",
      metadata: { headingMarker: "第一章", rawHeading: "第一章 正文" },
    });
    expect(parsed.blocks.find((block) => block.content.includes("不存在的章节"))?.metadata.isDirectory).toBe(true);
    expect(buildRetrievalChunks(parsed.blocks, parsed.sections).map((chunk) => chunk.content).join("\n")).not.toContain("不存在的章节");
  });

  it.each([
    ["第七章 人工智能教师能力提升", "人工智能教师能力提升", "第七章"],
    ["第一节 中小学人工智能教育", "中小学人工智能教育", "第一节"],
    ["一、人工智能意识", "人工智能意识", "一、"],
    ["（一）课程定位模糊", "课程定位模糊", "(一)"],
    ["1.2.3 模型训练", "模型训练", "1.2.3"],
    ["一带一路", "一带一路", null],
    ["第一性原理", "第一性原理", null],
    ["3D 打印", "3D 打印", null],
  ])("separates heading markers from %s", (value, title, marker) => {
    expect(splitTextbookHeading(value)).toEqual({ title, marker });
  });

  it("segments Chinese search text into stable bigrams", () => {
    expect(chineseSearchTokens("具身认知 AI-101")).toEqual(expect.arrayContaining(["具身", "身认", "认知", "ai-101"]));
  });

  const realIt = existsSync(attachment) ? it : it.skip;
  realIt("parses the supplied third chapter, its real hierarchy, examples and three figures", () => {
    const parsed = parseTextbookDocx(readFileSync(attachment));
    const knowledge = extractTextbookKnowledge(parsed);
    expect(parsed.title).toBe("人工智能学科教师素养提升");
    expect(parsed.sections.find((section) => section.kind === "CHAPTER")?.title).toBe("中小学人工智能教育的教学理论与方法");
    expect(parsed.sections.some((section) => section.title.startsWith("第一章智能时代"))).toBe(false);
    expect(parsed.figures).toHaveLength(3);
    expect(parsed.figures.map((figure) => figure.caption)).toEqual([
      expect.stringContaining("具身认知理论"),
      expect.stringContaining("项目式教学模式"),
      expect.stringContaining("教学支架"),
    ]);
    expect(knowledge.examples.some((example) => example.content.includes("分类游戏") && example.content.includes("机器学习"))).toBe(true);
    expect(knowledge.concepts.some((concept) => concept.name === "支架式教学法")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import {
  buildCodeCollaborationPrompts,
  buildCodeTaskStarterPrompts,
  detectProtectedCodeWorkRequest,
  normalizeCodeCollaborationResponse,
  normalizeCodeTaskStarters,
} from "@/lib/ai-collaboration/code-policy";
import type { Course } from "@/lib/session/types";

const course = {
  id: "course-1",
  name: "校园新闻广播",
  drivingQuestion: "如何制作可信、清楚的校园新闻节目？",
  learningObjectives: ["学生能够选择并核验新闻主题", "学生能够设计信息组织方式"],
  expectedOutcome: "一个可运行的新闻辅助程序",
  stages: [{ key: "make", label: "项目实践", description: "实现并测试项目成果" }],
  currentStageIndex: 0,
  students: [{ id: "student-1", name: "小林" }],
  content: {},
} as unknown as Course;

describe("code collaboration policy", () => {
  it("keeps project requirements, source files and real run evidence in the prompt", () => {
    const artifact = createCodeArtifact("python");
    const prompts = buildCodeCollaborationPrompts({
      course,
      studentId: "student-1",
      studentName: "小林",
      stageKey: "make",
      intent: "review",
      request: "为什么没有输出？",
      artifact,
      run: { status: "failed", phase: "run", exitCode: 1, stderr: "NameError: name is not defined" },
    });

    expect(prompts.user).toContain("校园新闻广播");
    expect(prompts.user).toContain("main.py");
    expect(prompts.user).toContain("NameError");
    expect(prompts.system).toContain("不得虚构已经运行");
  });

  it("normalizes a multi-file proposal without losing code indentation", () => {
    const artifact = createCodeArtifact("python");
    const result = normalizeCodeCollaborationResponse({
      artifact,
      intent: "delegate",
      raw: {
        kind: "change-proposal",
        message: "我补了一组边界测试。",
        focus: "辅助测试",
        findings: [],
        changeSet: {
          title: "补充边界测试",
          summary: "只增加测试，不改核心算法。",
          changes: [{
            filePath: "test_main.py",
            operation: "create",
            proposedContent: "def test_empty():\n    assert True\n",
            reason: "覆盖空输入。",
          }],
        },
      },
    });

    expect(result.kind).toBe("change-proposal");
    expect(result.changeSet?.changes[0].proposedContent).toBe("def test_empty():\n    assert True\n");
  });

  it("removes full-file Markdown fences and normalizes line endings before diff preview", () => {
    const artifact = createCodeArtifact("python");
    const result = normalizeCodeCollaborationResponse({
      artifact,
      intent: "edit",
      raw: {
        kind: "change-proposal",
        message: "我只调整了输出内容。",
        focus: "局部修改",
        findings: [],
        changeSet: {
          title: "调整输出",
          summary: "保持其他代码不变。",
          changes: [{
            filePath: "main.py",
            operation: "modify",
            proposedContent: "```python\r\n# 在这里开始你的项目\r\n\r\n\r\ndef main():\r\n    print(\"你好！\")\r\n\r\n\r\nif __name__ == \"__main__\":\r\n    main()\r\n```",
            reason: "缩短问候语。",
          }],
        },
      },
    });

    expect(result.changeSet?.changes[0].proposedContent).not.toContain("```");
    expect(result.changeSet?.changes[0].proposedContent).not.toContain("\r");
    expect(result.changeSet?.changes[0].proposedContent).toContain('print("你好！")');
  });

  it("returns all precise proactive findings while clamping invalid line ranges", () => {
    const artifact = createCodeArtifact("c");
    const result = normalizeCodeCollaborationResponse({
      artifact,
      intent: "proactive-review",
      raw: {
        kind: "review",
        message: "我注意到两处值得现在处理的问题。",
        findings: [
          { filePath: "main.c", startLine: 3, endLine: 3, severity: "warning", title: "未检查返回值", message: "输入失败时变量没有可靠值。", quotedCode: "scanf(...)" },
          { filePath: "main.c", startLine: 999, endLine: 1000, severity: "notice", title: "输出含义不清", message: "可以让输出更容易核对。", quotedCode: "printf(...)" },
        ],
      },
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings[1].startLine).toBeLessThanOrEqual(
      artifact.files[0].content.split("\n").length,
    );
  });

  it("relocates a proactive finding from its exact quoted source", () => {
    const artifact = createCodeArtifact("python");
    const result = normalizeCodeCollaborationResponse({
      artifact,
      intent: "proactive-review",
      raw: {
        kind: "review",
        message: "这里有一处可以确定的问题。",
        findings: [{
          filePath: "main.py",
          startLine: 1,
          endLine: 1,
          severity: "error",
          title: "错误定位",
          message: "引用内容应决定实际行号。",
          quotedCode: 'print("你好，CoTeach！")',
        }],
      },
    });

    expect(result.findings[0].startLine).toBe(5);
    expect(result.findings[0].endLine).toBe(5);
  });

  it("builds and normalizes project-aware starter suggestions", () => {
    const artifact = createCodeArtifact("python");
    const prompts = buildCodeTaskStarterPrompts({
      course,
      studentId: "student-1",
      stageKey: "make",
      artifact,
      run: { status: "success", phase: "run", stdout: "你好" },
      mode: "task",
    });
    expect(prompts.user).toContain("main.py");
    expect(prompts.user).toContain("你好");
    expect(prompts.system).toContain("安排工作");
    expect(normalizeCodeTaskStarters({ starters: ["补 main.py 的空输入测试", "补 main.py 的空输入测试", "检查输出格式"] }))
      .toEqual(["补 main.py 的空输入测试", "检查输出格式"]);
  });

  it("detects requests that hand the project's core implementation to AI", () => {
    expect(detectProtectedCodeWorkRequest("请你直接帮我完成整个项目的全部代码和核心算法"))
      .toBe("项目核心算法或完整代码");
  });
});

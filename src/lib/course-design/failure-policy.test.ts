import { describe, expect, it } from "vitest";
import {
  classifyCourseDesignFailure,
  createManagedRecoveryRequest,
  createTransientInfrastructureRecoveryRequest,
  formatFatalCourseDesignError,
  transientInfrastructureRetryDelayMs,
} from "./failure-policy";

describe("course design failure policy", () => {
  it("does not turn model structure or quality failures into a whole-course rewrite", () => {
    const error = new Error("主课脚本代理无法生成结构完整的数据：缺少知识点覆盖");
    expect(classifyCourseDesignFailure(error)).toBe("recoverable-generation");
    expect(createManagedRecoveryRequest({ courseId: "c", teacherBrief: "b" }, error))
      .toBeNull();
  });

  it("recovers malformed model JSON even when wrapped as a cause", () => {
    const error = new Error("个性化学习路径生成失败", { cause: new SyntaxError("Unexpected token") });
    expect(classifyCourseDesignFailure(error)).toBe("recoverable-generation");
  });

  it("does not restart the whole course after local knowledge-graph edits are exhausted", () => {
    const error = new Error(
      "目标与知识结构无法通过独立审校：边缘关系 edge-2 必要性不足，建议降级为 supports/helpful",
    );

    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    expect(createManagedRecoveryRequest({ courseId: "c", teacherBrief: "b" }, error)).toBeNull();
    expect(formatFatalCourseDesignError(error)).toContain("不会整项重跑");
  });

  it("does not duplicate an already formatted terminal-quality message", () => {
    const original = new Error("目标与知识结构无法通过独立审校：关系字段不完整");
    const once = formatFatalCourseDesignError(original);
    const twice = formatFatalCourseDesignError(new Error(once));

    expect(twice.match(/当前课程阶段未返回可保存的完整结构/g)).toHaveLength(1);
    expect(twice).toContain("关系字段不完整");
  });

  it("does not restart the whole course after the entry-package editor exhausts its local loop", () => {
    const cause = new Error("课程入口学习包无法通过发布校验：前测题选项重复");
    const error = new Error("个性化学习路径生成失败，未写入空白降级方案", { cause });

    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    expect(createManagedRecoveryRequest({ courseId: "c", teacherBrief: "b" }, error)).toBeNull();
    expect(formatFatalCourseDesignError(error)).toContain("不会整项重跑");
    expect(formatFatalCourseDesignError(error)).toContain("前测题选项重复");
  });

  it("reports exhausted blueprint repair as a quality failure with its actionable detail", () => {
    const error = new Error("教学蓝图缺少可用结构: 第 2 节核心概念缺少 term/concept 解释节点");

    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    const formatted = formatFatalCourseDesignError(error);
    expect(formatted).toContain("不会整项重跑");
    expect(formatted).toContain("第 2 节核心概念缺少");
    expect(formatFatalCourseDesignError(new Error(formatted))).toBe(formatted);
  });

  it("reports exhausted blueprint JSON repair without mislabeling it as infrastructure", () => {
    const error = new Error("教学蓝图 JSON 无法解析: Unexpected end of JSON input");

    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    expect(formatFatalCourseDesignError(error)).toContain("JSON 无法解析");
  });

  it("reports an unbound mandatory textbook figure as a concrete design failure", () => {
    const error = new Error("必用教材原图 figure-1 没有可绑定的首次知识讲解页。");
    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    expect(formatFatalCourseDesignError(error)).toContain("figure-1 没有可绑定的首次知识讲解页");
  });

  it("reports exhausted invalid model output as a concrete structure failure", () => {
    const error = Object.assign(new Error("知识结构存在必要依赖循环: kp-a、kp-b"), {
      generationFailureKind: "invalid-generated-output",
      isRetryable: true,
    });

    expect(classifyCourseDesignFailure(error)).toBe("terminal-quality");
    expect(formatFatalCourseDesignError(error)).toContain("知识结构存在必要依赖循环");
    expect(formatFatalCourseDesignError(error)).not.toContain("系统错误");
  });

  it("recovers transient network failures without treating credential errors as retryable", () => {
    const network = new Error("fetch failed: ECONNRESET");
    expect(classifyCourseDesignFailure(network)).toBe("transient-infrastructure");
    expect(createTransientInfrastructureRecoveryRequest({
      courseId: "c",
      teacherBrief: "b",
    }, network)).toMatchObject({ transientRecoveryCount: 1 });
    expect(classifyCourseDesignFailure(new Error("LLM 调用失败：401 unauthorized")))
      .toBe("fatal-infrastructure");
    expect(formatFatalCourseDesignError(network)).toContain("网络或 AI 模型服务");
  });

  it("explains a terminated model stream and preserves credential failures as terminal", () => {
    const disconnected = new TypeError("terminated", { cause: new Error("closed") });
    const networkMessage = formatFatalCourseDesignError(disconnected);
    expect(networkMessage).toContain("流式连接中断");
    expect(formatFatalCourseDesignError(new Error(networkMessage))).toBe(networkMessage);
    const credentialMessage = formatFatalCourseDesignError(new TypeError("terminated", {
      cause: new Error("401 unauthorized"),
    }));
    expect(credentialMessage).toContain("访问权限异常");
    expect(formatFatalCourseDesignError(new Error(credentialMessage))).toBe(credentialMessage);
  });

  it("uses bounded durable backoff and stops after the infrastructure retry budget", () => {
    const network = new Error("fetch failed: ECONNREFUSED");
    expect(transientInfrastructureRetryDelayMs(1)).toBe(15_000);
    expect(transientInfrastructureRetryDelayMs(2)).toBe(45_000);
    expect(transientInfrastructureRetryDelayMs(3)).toBe(120_000);
    expect(createTransientInfrastructureRecoveryRequest({
      courseId: "c",
      teacherBrief: "b",
      transientRecoveryCount: 3,
    }, network)).toBeNull();
  });

  it("keeps the legacy managed-recovery export disabled", () => {
    const error = new Error("课程设计代理未能补齐必要结构");
    expect(createManagedRecoveryRequest({
      courseId: "c",
      teacherBrief: "b",
    }, error)).toBeNull();
    expect(formatFatalCourseDesignError(error)).not.toContain("必要结构");
  });
});

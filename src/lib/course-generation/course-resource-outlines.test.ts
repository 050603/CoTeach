import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("./job-storage", () => ({ contentGenerationJobs: { findUnique: vi.fn(async () => ({ id: "job" })) } }));
vi.mock("./checkpoint-storage", () => ({ loadGenerationCheckpoints: findUnique }));

import { resolveDurableCourseSceneOutlines } from "./course-resource-outlines";

describe("durable course resource outlines", () => {
  beforeEach(() => findUnique.mockReset());

  it("restores the exact persisted media plan without replacing current outline metadata", async () => {
    findUnique.mockResolvedValue({
      preparedOutlines: [{
        id: "outline-1",
        title: "旧标题",
        mediaGenerations: [{ type: "image", elementId: "gen_img_real", prompt: "原始真实提示词" }],
      }],
    });

    const result = await resolveDurableCourseSceneOutlines("course-1", [{
      id: "outline-1",
      title: "教师确认后的标题",
    }]);

    expect(result[0]?.title).toBe("教师确认后的标题");
    expect(result[0]?.mediaGenerations).toEqual([
      { type: "image", elementId: "gen_img_real", prompt: "原始真实提示词" },
    ]);
  });

  it("does not invent a plan when no durable checkpoint exists", async () => {
    findUnique.mockResolvedValue({ preparedOutlines: null });
    const current = [{ id: "outline-1", title: "课程导入" }];

    await expect(resolveDurableCourseSceneOutlines("course-1", current)).resolves.toEqual(current);
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  updateCourse: vi.fn(),
  requestCourseCoverImage: vi.fn(() => new Promise<string | null>(() => undefined)),
  uploadCourseCoverImage: vi.fn(() => new Promise<string | null>(() => undefined)),
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({ updateCourse: mocks.updateCourse }),
}));

vi.mock("@/lib/course-cover", () => ({
  requestCourseCoverImage: mocks.requestCourseCoverImage,
  uploadCourseCoverImage: mocks.uploadCourseCoverImage,
}));

import { ProjectCoverImage } from "./visuals";

const course = {
  id: "course-1",
  name: "人工智能基础",
  subject: "人工智能通识课程",
  grade: "八年级",
  hours: 2,
  summary: "",
  drivingQuestion: "",
  status: "draft",
  stages: [],
  currentStageIndex: 0,
  content: {
    pblOutline: "",
    knowledgePoints: [],
    lessonOutline: [],
    evaluationPlan: { dimensions: [], overallRubric: "" },
  },
  students: [],
  coverImageUrl: "/cover.webp",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
} satisfies Course;

describe("ProjectCoverImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the current cover visible with a blurred regeneration status", async () => {
    render(<ProjectCoverImage allowGenerate course={course} />);

    fireEvent.click(screen.getByRole("button", { name: "重新生成封面" }));

    expect(await screen.findByText("正在重新生成")).toBeTruthy();
    expect(screen.getByRole("img", { name: "人工智能基础" }).className).toContain("blur-[7px]");
    expect((screen.getByRole("button", { name: "重新生成封面" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a teacher upload action and sends the selected image", async () => {
    mocks.uploadCourseCoverImage.mockResolvedValueOnce("/uploaded-cover.webp");
    const { container } = render(<ProjectCoverImage allowGenerate course={course} />);
    const file = new File(["image"], "cover.jpg", { type: "image/jpeg" });

    fireEvent.click(screen.getByRole("button", { name: "上传封面图片" }));
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await waitFor(() => expect(mocks.uploadCourseCoverImage).toHaveBeenCalledWith(
      "course-1",
      file,
      expect.any(AbortSignal),
    ));
    expect(await screen.findByRole("img", { name: "人工智能基础" })).toHaveAttribute(
      "src",
      expect.stringMatching(/\/uploaded-cover\.webp$/),
    );
  });

  it("keeps cover upload available after the saved image fails and recovers with the uploaded URL", async () => {
    mocks.uploadCourseCoverImage.mockResolvedValueOnce("/replacement.webp");
    const { container } = render(<ProjectCoverImage allowGenerate course={course} />);
    fireEvent.error(screen.getByRole("img", { name: "人工智能基础" }));
    expect(screen.getByRole("img", { name: "人工智能基础（图片暂不可用）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "上传封面图片" })).toBeEnabled();
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "replacement.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(screen.getByRole("img", { name: "人工智能基础" })).toHaveAttribute("src", expect.stringMatching(/\/replacement\.webp$/)));
  });
});

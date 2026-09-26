import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { KnowledgeLectureAnalytics } from "./knowledge-lecture-analytics";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const course = {
  stages: [{ key: "ai-learning" }],
  students: [{ id: "student" }],
  content: {
    knowledgePoints: [],
    knowledgeLectureSections: [0, 1].map((index) => ({
      id: `section-${index}`, title: `知识讲授第${index + 1}节`, order: index,
      knowledgePointIds: [], sceneOutlineIds: [], quizOutlineId: `quiz-${index}`,
    })),
  },
  aiLearningProgress: {
    student: {
      knowledgeLectureAttempts: [0, 1].map((index) => ({
        id: `attempt-${index}`, sectionId: `section-${index}`, quizOutlineId: `quiz-${index}`,
        submittedAt: "2026-09-25T00:00:00Z", gradingSource: "server", knowledgePointIds: [],
        questions: [{ questionId: `question-${index}`, prompt: "请选择正确解释", knowledgePointIds: [], gradingStatus: "graded", points: 10, earned: index ? 8 : 6, correct: false, feedback: "核对证据" }],
      })),
    },
  },
} as unknown as Course;

it("renders both real Recharts series and recovers when a hidden chart becomes visible or resizes", async () => {
  let width = 0;
  const rect = () => ({ width, height: width ? 224 : 0, top: 0, left: 0, right: width, bottom: 224, x: 0, y: 0, toJSON() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rect);
  const observers = new Set<() => void>();
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.callback = () => callback([{ contentRect: rect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() { observers.add(this.callback); }
    unobserve() { observers.delete(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
  const { container, unmount } = render(<KnowledgeLectureAnalytics course={course} />);
  expect(screen.getByRole("heading", { name: "各小节完成率与均分" })).toBeInTheDocument();
  expect(container.querySelector(".recharts-surface")).toBeNull();

  for (const nextWidth of [680, 1280, 860]) {
    act(() => { width = nextWidth; observers.forEach((notify) => notify()); });
    await waitFor(() => expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2));
    expect(container.querySelector(".recharts-surface")).toHaveAttribute("width", String(nextWidth));
    for (const curve of container.querySelectorAll(".recharts-line-curve")) {
      expect(curve.getAttribute("d")).toMatch(/^M/);
      expect(curve.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    }
  }
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("均分60分"));
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("均分80分"));
  unmount();
  expect(observers.size).toBe(0);
});

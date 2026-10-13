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

it("shows the teacher's cumulative points without per-section normalization", () => {
  const weighted = structuredClone(course);
  weighted.stages = [];
  const attempts = weighted.aiLearningProgress!.student.knowledgeLectureAttempts!;
  attempts[0].questions[0].points = 35;
  attempts[0].questions[0].earned = 35;
  attempts[1].questions[0].points = 45;
  attempts[1].questions[0].earned = 0;
  render(<KnowledgeLectureAnalytics course={weighted} showSectionSummaryChart={false} />);
  expect(screen.getByText("班级均分 35分")).toBeInTheDocument();
});

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
  const { container, rerender, unmount } = render(<KnowledgeLectureAnalytics course={course} />);
  expect(screen.getByRole("heading", { name: "各小节完成率与均分" })).toBeInTheDocument();
  expect(container.querySelector(".recharts-surface")).toBeNull();

  // A 320px phone leaves 210px inside this card after layout and chart padding.
  for (const nextWidth of [210, 280, 680, 1280, 860, 210, 320, 860]) {
    act(() => { width = nextWidth; observers.forEach((notify) => notify()); });
    await waitFor(() => expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2));
    expect(container.querySelector(".recharts-surface")).toHaveAttribute("width", String(nextWidth));
    for (const curve of container.querySelectorAll(".recharts-line-curve")) {
      expect(curve.getAttribute("d")).toMatch(/^M/);
      expect(curve.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    }
    await waitFor(() => expect([...container.querySelectorAll(".recharts-surface .cursor-help text")].map((tick) => tick.getAttribute("text-anchor"))).toEqual(["start", "end"]));
    const completionMaximum = [...container.querySelectorAll(".recharts-yAxis-tick-labels text")].find((tick) => tick.textContent === "100%")!;
    // The actual bundled font needs 26px for 100%, plus room at the SVG edge.
    expect(Number(completionMaximum.getAttribute("x"))).toBeGreaterThanOrEqual(28);
    const ticks = [...container.querySelectorAll(".recharts-surface .cursor-help")];
    for (const [index, tick] of ticks.entries()) {
      const fullTitle = course.content.knowledgeLectureSections![index].title;
      expect(tick.querySelector("title")).toHaveTextContent(fullTitle);
      const visibleTitle = tick.querySelectorAll("tspan")[1].textContent!;
      if (nextWidth === 210) {
        expect(visibleTitle).toMatch(/…$/);
        expect(visibleTitle.length).toBeLessThanOrEqual(5);
      } else {
        expect(visibleTitle).toBe(fullTitle);
      }
    }
  }
  expect(screen.getByRole("img").firstElementChild).toHaveStyle({ minWidth: "0" });
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("均分6/10分"));
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("均分8/10分"));
  const sections = course.content.knowledgeLectureSections!;
  const longTitle = "社区生态调查证据分析与实践方案评价";
  rerender(<KnowledgeLectureAnalytics course={{ ...course, content: { ...course.content, knowledgeLectureSections: [...sections, { ...sections[1], id: "section-2", title: longTitle, order: 2 }] } }} />);
  await waitFor(() => expect(container.querySelectorAll(".recharts-surface .cursor-help text")).toHaveLength(3));
  expect([...container.querySelectorAll(".recharts-surface .cursor-help text")].map((tick) => tick.getAttribute("text-anchor"))).toEqual(["start", "middle", "end"]);
  const lastTick = [...container.querySelectorAll(".recharts-surface .cursor-help")].at(-1)!;
  expect(lastTick.querySelector("title")).toHaveTextContent(longTitle);
  expect(lastTick.querySelector("text")).toHaveTextContent(`${longTitle.slice(0, 8)}…`);
  rerender(<KnowledgeLectureAnalytics course={{ ...course, content: { ...course.content, knowledgeLectureSections: [sections[0]] } }} />);
  await waitFor(() => expect(container.querySelectorAll(".recharts-surface .cursor-help text")).toHaveLength(1));
  expect(container.querySelector(".recharts-surface .cursor-help text")).toHaveAttribute("text-anchor", "middle");
  unmount();
  expect(observers.size).toBe(0);
});

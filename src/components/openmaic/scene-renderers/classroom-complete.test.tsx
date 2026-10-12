import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Scene } from "@openmaic/lib/types/stage";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { ClassroomCompletePage } from "./classroom-complete";

const scene = { id: "complete-weighted-quiz", type: "quiz", content: { type: "quiz", questions: [
  { id: "choice", type: "single", points: 15 },
  { id: "blank", type: "short_answer", format: "fill_blank", points: 10 },
] } } as Scene;
afterEach(() => {
  localStorage.removeItem(`quizAnswers:${scene.id}`);
  localStorage.removeItem(`quizResults:${scene.id}`);
});
describe("classroom completion grade", () => {
  it("displays a perfect percentage including AI-graded answers and keeps the raw points", () => {
    localStorage.setItem(`quizAnswers:${scene.id}`, JSON.stringify({ choice: "A", blank: "答案" }));
    localStorage.setItem(`quizResults:${scene.id}`, JSON.stringify([
      { questionId: "choice", status: "correct", earned: 15 },
      { questionId: "blank", status: "graded", earned: 10 },
    ]));
    render(<I18nProvider><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(screen.getByText(/Quiz score 100 \/ 100|小测总成绩 100 \/ 100 分/)).toBeInTheDocument();
    expect(screen.getByText(/Raw points 25 \/ 25|原始得分 25 \/ 25 分/)).toBeInTheDocument();
  });
  it("shows pending grading rather than dropping the unanswered fill blank", () => {
    localStorage.setItem(`quizAnswers:${scene.id}`, JSON.stringify({ choice: "A", blank: "答案" }));
    localStorage.setItem(`quizResults:${scene.id}`, JSON.stringify([
      { questionId: "choice", status: "correct", earned: 15 },
      { questionId: "blank", status: "pending", earned: 0 },
    ]));
    render(<I18nProvider><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(screen.getByText(/Quiz score awaiting completed grading|小测总成绩待完成批阅/)).toBeInTheDocument();
    expect(screen.queryByText(/Quiz score 100 \/ 100|小测总成绩 100 \/ 100 分/)).toBeNull();
  });
});

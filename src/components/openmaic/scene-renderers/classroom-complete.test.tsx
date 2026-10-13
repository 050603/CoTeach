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
  it("displays the actual total including AI-graded answers in a single score", () => {
    localStorage.setItem(`quizAnswers:${scene.id}`, JSON.stringify({ choice: "A", blank: "答案" }));
    localStorage.setItem(`quizResults:${scene.id}`, JSON.stringify([
      { questionId: "choice", status: "correct", earned: 15 },
      { questionId: "blank", status: "graded", earned: 10 },
    ]));
    render(<I18nProvider><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(screen.getByText(/Quiz score 25 \/ 25|小测总成绩 25 \/ 25 分/)).toBeInTheDocument();
    expect(screen.queryByText(/Raw points|原始得分/)).toBeNull();
  });
  it("shows pending grading rather than dropping the unanswered fill blank", () => {
    localStorage.setItem(`quizAnswers:${scene.id}`, JSON.stringify({ choice: "A", blank: "答案" }));
    localStorage.setItem(`quizResults:${scene.id}`, JSON.stringify([
      { questionId: "choice", status: "correct", earned: 15 },
      { questionId: "blank", status: "pending", earned: 0 },
    ]));
    render(<I18nProvider><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(screen.getByText(/Quiz score awaiting completed grading|小测总成绩待完成批阅/)).toBeInTheDocument();
    expect(screen.queryByText(/Quiz score 25 \/ 25|小测总成绩 25 \/ 25 分/)).toBeNull();
  });
});

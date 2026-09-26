import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReflectionWordCloud } from "./reflection-word-cloud";

const mocks = vi.hoisted(() => ({
  layout: vi.fn(),
}));

vi.mock("@visx/wordcloud", () => ({
  useWordcloud: mocks.layout,
}));

describe("ReflectionWordCloud", () => {
  beforeEach(() => {
    mocks.layout.mockReset();
    mocks.layout.mockImplementation(({ words }) => words.map((word: { text: string }) => ({ ...word, x: 0, y: 0, size: 20, rotate: 0 })));
  });
  it("opens a term from keyboard activation with its student count", () => {
    const onSelect = vi.fn();
    render(<ReflectionWordCloud onSelect={onSelect} terms={[{ label: "证据", value: 3 }]} />);

    const word = screen.getByRole("button", { name: "证据，涉及 3 名学生" });
    fireEvent.keyDown(word, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ label: "证据", value: 3 });
  });

  it("keeps layout inputs stable when an equivalent terms array is passed again", () => {
    const { rerender } = render(
      <ReflectionWordCloud onSelect={vi.fn()} seed="gains" terms={[{ label: "证据", value: 3 }]} />,
    );
    const first = mocks.layout.mock.lastCall?.[0];

    rerender(<ReflectionWordCloud onSelect={vi.fn()} seed="gains" terms={[{ label: "证据", value: 3 }]} />);
    const second = mocks.layout.mock.lastCall?.[0];

    expect(second.words).toBe(first.words);
    expect(second.fontSize).toBe(first.fontSize);
    expect(second.random).toBe(first.random);
  });

  it.each([0, 1])("keeps all terms selectable when the layout only fits %s words", (count) => {
    mocks.layout.mockImplementation(({ words }) => words.slice(0, count));
    const onSelect = vi.fn();
    render(<ReflectionWordCloud onSelect={onSelect} terms={[{ label: "证据", value: 3 }, { label: "过长而无法在狭窄面板排下的关键词", value: 2 }]} />);
    expect(screen.getByLabelText("完整反思关键词列表")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "过长而无法在狭窄面板排下的关键词，涉及 2 名学生" }));
    expect(onSelect).toHaveBeenCalledWith({ label: "过长而无法在狭窄面板排下的关键词", value: 2 });
  });
});

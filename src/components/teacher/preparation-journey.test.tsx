import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PREPARATION_FLOW_STEPS } from "@/lib/teacher/preparation-flow";
import { PreparationJourney } from "./preparation-journey";

describe("PreparationJourney compact navigation", () => {
  it("provides every preparation step and preserves the selected step when navigating", () => {
    const onSelect = vi.fn();
    const first = PREPARATION_FLOW_STEPS[0];
    const target = PREPARATION_FLOW_STEPS.at(-1)!;
    render(<PreparationJourney backHref="/teacher" completedKeys={[first.key]} currentKey={first.key} onSelect={onSelect} />);

    const picker = screen.getByRole("combobox", { name: "切换备课步骤" });
    expect(screen.getAllByRole("option")).toHaveLength(PREPARATION_FLOW_STEPS.length);
    expect(picker).toHaveProperty("value", first.key);
    fireEvent.change(picker, { target: { value: target.key } });
    expect(onSelect).toHaveBeenCalledWith(target.key);
  });
});

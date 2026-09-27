import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudentExperimentAssessmentEntry } from "./student-experiment-assessment-entry";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("./student-experiment-assessment", () => ({
  StudentExperimentAssessment: ({ onSubmitted, phase }: { onSubmitted: () => void; phase: string }) =>
    <button onClick={onSubmitted} type="button">提交{phase}</button>,
}));

describe("standalone experiment assessment navigation", () => {
  it.each(["pretest", "posttest"] as const)("returns to the activity only after %s confirms submission", (phase) => {
    replace.mockClear();
    render(<StudentExperimentAssessmentEntry activityId="classroom/1" instanceId="instance-1" phase={phase} />);
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `提交${phase}` }));
    expect(replace).toHaveBeenCalledWith("/student/activities/classroom%2F1");
  });
});

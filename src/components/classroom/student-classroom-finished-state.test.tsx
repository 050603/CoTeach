import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StudentClassroomFinishedState } from "./student-classroom-finished-state";

afterEach(cleanup);

describe("student classroom finished state", () => {
  it("links a platform classroom back to its activity for the posttest", () => {
    render(<StudentClassroomFinishedState course={{ name: "观察课堂", platformContext: { activityId: "activity-1" } }} />);
    expect(screen.getByRole("heading", { name: "课堂已结束" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回课堂活动完成后测" })).toHaveAttribute("href", "/student/activities/activity-1");
  });

  it("keeps a standalone classroom's finished state without a platform activity link", () => {
    render(<StudentClassroomFinishedState course={{ name: "独立课堂" }} />);
    expect(screen.getByRole("heading", { name: "课堂已结束" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "返回课堂活动完成后测" })).toBeNull();
  });
});

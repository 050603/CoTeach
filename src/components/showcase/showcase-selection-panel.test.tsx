import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShowcaseData } from "@/lib/showcase/types";
import { ShowcaseSelectionPanel } from "./showcase-selection-panel";

describe("teacher presenter selection", () => {
  it("restores locked history, leaves other submissions unselected and saves exact seconds", () => {
    const save = vi.fn(async () => undefined);
    const data = {
      courseId: "course", queueConfig: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: [], presentationSec: 80, discussionSec: 25, transitionSec: 10 },
      students: [{ studentId: "s1", name: "甲", artifacts: [] }, { studentId: "s2", name: "乙", artifacts: [] }],
      queue: [{ studentId: "s1", status: "completed" }], budget: { stageRemainingSec: 130, plannedRemainingSec: 0, overrunSec: 0 },
    } as unknown as ShowcaseData;
    render(<ShowcaseSelectionPanel data={data} busy={false} save={save} />);
    expect(screen.getByLabelText("选择甲现场汇报")).toBeChecked();
    expect(screen.getByLabelText("选择甲现场汇报")).toBeDisabled();
    expect(screen.getByLabelText("选择乙现场汇报")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("选择乙现场汇报"));
    fireEvent.click(screen.getByRole("button", { name: "保存汇报名单与时间" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ selectedStudentIds: ["s1", "s2"], orderedStudentIds: ["s1", "s2"], presentationSec: 80, discussionSec: 25, transitionSec: 10 }));
  });
});

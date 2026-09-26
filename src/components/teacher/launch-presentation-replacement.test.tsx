import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { LaunchPresentationReplacement } from "./launch-presentation-replacement";

const course = {
  id: "course-1", version: 7, resources: [
    { id: "old-ppt", title: "原启动课件", type: "PPTX", stageKey: "launch", size: "1 MB", url: "/api/uploads/old-ppt", downloadedBy: [] },
  ],
  content: { resourcePackage: { launchResourceId: "old-ppt" } },
} as unknown as Course;

afterEach(() => vi.unstubAllGlobals());

describe("launch presentation replacement", () => {
  it("uploads a PPTX from the resource-package card and links it to the current course version", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "new-ppt" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ course: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdated = vi.fn(async () => {});
    render(<LaunchPresentationReplacement course={course} disabled={false} onUpdated={onUpdated} />);
    expect(screen.getByText("原启动课件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "替换资源包中的 PPT" }));
    fireEvent.change(screen.getByLabelText("上传新的 PPTX 文件"), { target: { files: [new File(["pptx"], "新版.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })] } });
    fireEvent.click(screen.getByRole("button", { name: "上传并替换" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/uploads");
    expect(fetchMock.mock.calls[0][1].body.get("purpose")).toBe("launch-presentation-replacement");
    expect(fetchMock.mock.calls[0][1].body.get("courseId")).toBe("course-1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/courses/course-1/launch-presentation");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ uploadId: "new-ppt", expectedVersion: 7 });
    expect(screen.getByRole("status")).toHaveTextContent("新版.pptx");
  });

  it("requires the current edits to be saved before replacement", () => {
    render(<LaunchPresentationReplacement course={course} disabled onUpdated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "替换资源包中的 PPT" })).toBeDisabled();
    expect(screen.getByText(/请先保存左侧/)).toBeInTheDocument();
  });
});

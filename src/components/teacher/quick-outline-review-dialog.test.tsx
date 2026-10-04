import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TeachingBlueprint } from "@/lib/session/types";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

vi.mock("@/components/openmaic/generation/outlines-editor", async () => {
  const { useI18n } = await import("@/lib/openmaic/hooks/use-i18n");
  return {
    OutlinesEditor: ({ hideFooter, readOnly, outlines, onChange }: { hideFooter: boolean; readOnly?: boolean; outlines: SceneOutline[]; onChange: (outlines: SceneOutline[]) => void }) => {
      useI18n();
      return <div>
        大纲编辑器已加载
        <span data-testid="editor-footer-state">{hideFooter ? "footer-hidden" : "footer-visible"}</span>
        <span data-testid="editor-page-titles">{outlines.map((outline) => outline.title).join("、")}</span>
        <button disabled={readOnly} onClick={() => onChange([{ id: "page-1", title: "" } as SceneOutline])} type="button">清空标题</button>
      </div>;
    },
  };
});

import { QuickOutlineReviewDialog } from "./quick-outline-review-dialog";

describe("QuickOutlineReviewDialog", () => {
  it("can reopen saved outlines without offering a confirmation or test selection", () => {
    const onClose = vi.fn();
    const outline = { id: "page-1", title: "课程导入" } as SceneOutline;
    const { rerender } = render(<QuickOutlineReviewDialog initialOutlines={[outline]} readOnly testMode onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "查看课程大纲与教学蓝图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "清空标题" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "生成所选小节" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("快速生成已暂停")).toBeNull();
    rerender(<QuickOutlineReviewDialog initialOutlines={[{ ...outline, title: "最新页面安排" }]} readOnly onClose={onClose} />);
    expect(screen.getByTestId("editor-page-titles")).toHaveTextContent("最新页面安排");
    fireEvent.click(screen.getByRole("button", { name: "教学蓝图" }));
    expect(screen.getByText(/教学蓝图尚未生成/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reads spoken preview paragraphs from canonical references rather than compatibility copies", () => {
    const outline = { id: "page-1", title: "课程导入", type: "slide", lectureSectionId: "section",
      teachingBrief: { manuscript: { sectionId: "section", segmentIds: ["second", "first"] },
        teachingPlan: { newContent: "过时的正文副本" } },
    } as SceneOutline;
    const blueprint = { sections: [{ id: "section", contentMode: "spoken", units: [{ explanationNodes: [
      { id: "first", content: "第一个原始段落。" }, { id: "second", content: "教师调整到前面的段落。" },
    ] }] }] } as TeachingBlueprint;
    render(<QuickOutlineReviewDialog initialOutlines={[outline]} blueprint={blueprint} readOnly onClose={vi.fn()} />);
    expect(screen.queryByText("过时的正文副本")).toBeNull();
    const paragraphs = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(paragraphs.slice(0, 2)).toEqual(["教师调整到前面的段落。", "第一个原始段落。"]);
  });

  it("provides OpenMAIC i18n context while expanding the outline editor", () => {
    expect(() => render(
      <QuickOutlineReviewDialog initialOutlines={[]} onClose={vi.fn()} onConfirm={vi.fn()} />,
    )).not.toThrow();
    expect(screen.getByText("大纲编辑器已加载")).toBeTruthy();
  });

  it("keeps confirmation outside the scroll area and reports save failures for retry", async () => {
    const outline = { id: "page-1", title: "课程导入" } as SceneOutline;
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error("保存失败，请重试"))
      .mockResolvedValueOnce(undefined);
    render(<QuickOutlineReviewDialog initialOutlines={[outline]} onClose={vi.fn()} onConfirm={onConfirm} />);

    const button = screen.getByRole("button", { name: "确认大纲并继续生成" });
    expect(screen.getByTestId("outline-review-scroll-area").contains(button)).toBe(false);
    expect(screen.getByTestId("editor-footer-state").textContent).toBe("footer-hidden");
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，请重试");
    expect(onConfirm).toHaveBeenCalledWith([outline]);

    fireEvent.click(button);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("keeps confirmation disabled when a page has no title", () => {
    const onConfirm = vi.fn();
    render(<QuickOutlineReviewDialog initialOutlines={[{ id: "page-1", title: "课程导入" } as SceneOutline]} onClose={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "清空标题" }));
    expect(screen.getByRole("button", { name: "1 个页面缺少标题，点击定位" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "确认大纲并继续生成" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("waits for the teacher to choose exactly one complete test section", async () => {
    const outlines = [
      { id: "a-slide", title: "训练数据", lectureSectionId: "a", lectureSectionTitle: "训练数据", type: "slide", targetDurationSec: 120 },
      { id: "a-quiz", title: "训练数据检测", lectureSectionId: "a", lectureSectionTitle: "训练数据", type: "quiz", targetDurationSec: 60 },
      { id: "b-slide", title: "模型评估", lectureSectionId: "b", lectureSectionTitle: "模型评估", type: "slide", targetDurationSec: 120 },
      { id: "b-quiz", title: "模型评估检测", lectureSectionId: "b", lectureSectionTitle: "模型评估", type: "quiz", targetDurationSec: 60 },
    ] as SceneOutline[];
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<QuickOutlineReviewDialog initialOutlines={outlines} testMode onClose={vi.fn()} onConfirm={onConfirm} />);

    const confirm = screen.getByRole("button", { name: "生成所选小节" });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请先选择");

    fireEvent.click(screen.getByRole("radio", { name: "模型评估" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(outlines, "b"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

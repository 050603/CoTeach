import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

vi.mock("@/components/openmaic/generation/outlines-editor", async () => {
  const { useI18n } = await import("@/lib/openmaic/hooks/use-i18n");
  return {
    OutlinesEditor: ({ hideFooter, onChange }: { hideFooter: boolean; onChange: (outlines: SceneOutline[]) => void }) => {
      useI18n();
      return <div>
        大纲编辑器已加载
        <span data-testid="editor-footer-state">{hideFooter ? "footer-hidden" : "footer-visible"}</span>
        <button onClick={() => onChange([{ id: "page-1", title: "" } as SceneOutline])} type="button">清空标题</button>
      </div>;
    },
  };
});

import { QuickOutlineReviewDialog } from "./quick-outline-review-dialog";

describe("QuickOutlineReviewDialog", () => {
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

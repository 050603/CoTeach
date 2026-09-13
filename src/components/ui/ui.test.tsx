import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { FormField, Input } from "./form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./overlays";
import { FlowActionBar, SaveStatus } from "./states";

describe("CoTeach shared UI", () => {
  it("disables a loading primary action", () => {
    render(<Button loading>正在保存</Button>);
    expect((screen.getByRole("button", { name: "正在保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("connects form errors to the control", () => {
    render(<FormField error="课程名称不能为空" label="课程名称">{({ id, describedBy, invalid }) => <Input aria-describedby={describedBy} aria-invalid={invalid} id={id} />}</FormField>);
    const input = screen.getByLabelText("课程名称");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe("课程名称不能为空");
  });

  it("returns focus to the trigger when a dialog closes with Escape", async () => {
    render(<Dialog><DialogTrigger asChild><button type="button">编辑课程</button></DialogTrigger><DialogContent><DialogTitle>课程设置</DialogTitle><DialogDescription>修改课程信息</DialogDescription></DialogContent></Dialog>);
    const trigger = screen.getByRole("button", { name: "编辑课程" });
    fireEvent.click(trigger);
    expect(document.body.contains(screen.getByRole("dialog"))).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps destructive confirmation actions visible and reachable", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>删除课程？</AlertDialogTitle>
          <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction>永久删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.getByRole("alertdialog").className).toContain("overflow-y-auto");
    expect(screen.getByRole("button", { name: "永久删除" }).className).toContain("bg-destructive");
  });

  it("announces save failures and supports retry", () => {
    const retry = vi.fn();
    render(<SaveStatus onRetry={retry} state="error" />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("保存失败").closest("div")?.getAttribute("aria-live")).toBe("polite");
    expect(retry).toHaveBeenCalledOnce();
  });

  it("supports a fixed full-width action bar without reserving blank space", () => {
    const { container } = render(
      <FlowActionBar persistent reserveSpace={false}><button type="button">继续</button></FlowActionBar>,
    );
    const bar = screen.getByRole("button", { name: "继续" }).closest<HTMLElement>(".pbl-safe-bottom");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("fixed");
    expect(bar?.className).toContain("inset-x-0");
    expect(bar?.firstElementChild?.className).toContain("max-w-[96rem]");
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

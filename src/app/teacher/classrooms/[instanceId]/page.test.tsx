import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClassroomMonitor from "./page";
vi.mock("next/navigation", () => ({ useParams: () => ({ instanceId: "instance-1" }), usePathname: () => "/teacher/classrooms/instance-1" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function classroom(status: string, kind = "pbl-course") {
  return { instance: { id: "instance-1", title: "城市探索", offeringId: "course-1", status, snapshot: { kind }, coverImageUrl: "/generated/city-cover.png" }, participants: [] };
}
describe("课堂学习记录入口", () => {
  it.each([
    ["scheduled", "pbl-course", "进入课堂", "/teacher/teach/instance-1/setup"],
    ["teaching", "pbl-course", "继续授课", "/teacher/teach/instance-1/classroom"],
    ["teaching", "lesson", "继续授课", "/teacher/teach/instance-1/setup?enter=1"],
    ["finished", "pbl-course", "返回教学工作台", "/teacher/teach/instance-1/setup"],
  ])("routes %s %s to its supported workspace", async (status, kind, label, href) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => classroom(status, kind) }));
    render(<ClassroomMonitor/>);
    expect(await screen.findByRole("img", { name: "城市探索课堂封面" })).toBeTruthy();
    expect((await screen.findByRole("link", { name: label })).getAttribute("href")).toBe(href);
    expect(screen.queryByRole("button", { name: "开始课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束课堂" })).toBeNull();
    expect(screen.getByText("等待第一份学习记录")).toBeTruthy();
  });
  it("recovers from a failed load and clears its error", async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ user: { role: "teacher", displayName: "李老师", username: "teacher.li" } }) };
      attempts += 1;
      return attempts === 1
        ? { ok: false, json: async () => ({ message: "读取暂时失败" }) }
        : { ok: true, json: async () => classroom("scheduled") };
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ClassroomMonitor/>);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("等待第一份学习记录")).toBeTruthy();
  });
});

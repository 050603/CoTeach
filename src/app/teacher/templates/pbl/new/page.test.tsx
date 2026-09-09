import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ push: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => "/teacher/templates/pbl/new" }));
import NewPblTemplatePage from "./page";
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => vi.unstubAllGlobals());
describe("full PBL preparation entry", () => {
  it("opens the existing detailed editor after the template is durably created", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ templateId: "template" }) });
    render(<NewPblTemplatePage />);
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "校园节水" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入备课" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/teacher/prepare/template/verify"));
    expect(mocks.fetch).toHaveBeenCalledWith("/api/platform/templates/pbl", expect.objectContaining({ method: "POST", body: expect.stringContaining("校园节水") }));
  });
  it("keeps the form available for retry when persistence fails", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ message: "请重试" }) });
    render(<NewPblTemplatePage />); fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "项目" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入备课" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请重试");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

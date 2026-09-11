import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/platform/client", () => ({ teacherPlatformFetch: mocks.fetch }));

import { SurveyKeywordSettings } from "./survey-keyword-settings";

const response = (mode: string) => Response.json({ mode });
const localButton = () => screen.getByRole("button", { name: /本地分词/ });
const llmButton = () => screen.getByRole("button", { name: /大模型分析/ });

beforeEach(() => vi.resetAllMocks());

describe("survey keyword settings controls", () => {
  it("loads the saved mode and saves another mode only when clicked", async () => {
    mocks.fetch.mockResolvedValueOnce(response("llm")).mockResolvedValueOnce(response("local"));
    render(<SurveyKeywordSettings />);
    expect(localButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取分析设置");
    await waitFor(() => expect(llmButton()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(llmButton());
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    fireEvent.click(localButton());
    await waitFor(() => expect(localButton()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("已保存：本地分词");
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/platform/survey-settings", expect.objectContaining({
      method: "POST", body: JSON.stringify({ mode: "local" }), cache: "no-store",
    }));
    expect(screen.getByText(/仅对当前教师查看问卷时生效/)).toBeInTheDocument();
  });

  it("keeps the saved selection and prevents additional writes while saving", async () => {
    let resolveSave!: (value: Response) => void;
    mocks.fetch.mockResolvedValueOnce(response("local")).mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSave = resolve; }));
    render(<SurveyKeywordSettings />);
    await waitFor(() => expect(localButton()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(llmButton());
    expect(screen.getByRole("status")).toHaveTextContent("正在保存分析方式");
    expect(localButton()).toBeDisabled();
    expect(llmButton()).toBeDisabled();
    expect(localButton()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(llmButton());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => resolveSave(response("llm")));
    expect(llmButton()).toHaveAttribute("aria-pressed", "true");
  });

  it("allows a failed initial load to be retried without overwriting an unknown preference", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("加载失败")).mockResolvedValueOnce(response("llm"));
    render(<SurveyKeywordSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
    expect(localButton()).toBeDisabled();
    expect(llmButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(llmButton()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing mode on save failure and retries the requested mode", async () => {
    mocks.fetch.mockResolvedValueOnce(response("local"))
      .mockResolvedValueOnce(Response.json({ message: "保存失败，请重试" }, { status: 503 }))
      .mockResolvedValueOnce(response("llm"));
    render(<SurveyKeywordSettings />);
    await waitFor(() => expect(localButton()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(llmButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，请重试");
    expect(localButton()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).not.toHaveTextContent("已保存");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(llmButton()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已保存：大模型分析");
  });
});

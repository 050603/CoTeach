import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformHeader: () => <div data-testid="platform-header" />,
  TeacherPlatformPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("./teacher-profile-panel", () => ({
  TeacherProfilePanel: () => <div>账号设置内容</div>,
}));

vi.mock("@/components/platform/survey-keyword-settings", () => ({
  SurveyKeywordSettings: () => <div>教学偏好内容</div>,
}));

vi.mock("@openmaic/components/server-providers-init", () => ({
  ServerProvidersInit: () => null,
}));

vi.mock("@openmaic/lib/hooks/use-i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@openmaic/lib/hooks/use-theme", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

import TeacherSettingsPage from "./page";

describe("TeacherSettingsPage navigation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ providers: {} }));
  });

  it("shows one settings category at a time", () => {
    render(<TeacherSettingsPage />);

    expect(screen.getByRole("heading", { name: "个人中心" })).toBeInTheDocument();
    expect(screen.getByText("账号设置内容")).toBeInTheDocument();
    expect(screen.queryByText("教学偏好内容")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /账号与安全/ })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: /教学偏好/ }));

    expect(screen.queryByText("账号设置内容")).not.toBeInTheDocument();
    expect(screen.getByText("教学偏好内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /教学偏好/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "教学偏好" })).toBeInTheDocument();
  });

  it("starts AI settings with a grouped overview and drills into one service", async () => {
    render(<TeacherSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: /^AI 服务/ }));

    expect(await screen.findByRole("heading", { name: "配置概览" })).toBeInTheDocument();
    expect(screen.getByText("直接查看当前服务商、模型和默认策略")).toBeInTheDocument();
    expect(await screen.findByText("系统默认模型 · 浏览器默认语音")).toBeInTheDocument();
    expect(screen.getByText("使用每门课程锁定的生成模型")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "课程设计与质量" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "语音与智能体" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "素材与信息处理" })).toBeInTheDocument();
    expect(screen.queryByText("选择接入服务")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /AI 大模型/ }));

    expect(await screen.findByRole("button", { name: "返回服务总览" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 大模型" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI 服务设置" })).not.toBeInTheDocument();
    expect(screen.getByText("关联功能")).toBeInTheDocument();
    expect(screen.getByText("选择接入服务")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "OpenAI 配置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "连接认证" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型配置" })).toBeInTheDocument();
    expect(screen.getByText("应用场景思考深度")).toBeInTheDocument();
    expect(screen.queryByText("配置工作台")).not.toBeInTheDocument();
  });
});

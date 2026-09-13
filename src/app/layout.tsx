import type { Metadata, Viewport } from "next";
import "@fontsource/noto-sans-sc/chinese-simplified-400.css";
import "@fontsource/noto-sans-sc/chinese-simplified-500.css";
import "@fontsource/noto-sans-sc/chinese-simplified-600.css";
import "@fontsource/noto-sans-sc/chinese-simplified-700.css";
import "@fontsource/noto-serif-sc/chinese-simplified-600.css";
import "@fontsource/noto-serif-sc/chinese-simplified-700.css";
import "./globals.css";
import { PlatformSessionBoundary } from "@/components/platform/platform-session-boundary";
import { AppToaster } from "@/components/ui/feedback";
import { ChunkLoadRecovery } from "@/lib/runtime/chunk-load-recovery";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  applicationName: "CoTeach",
  title: "CoTeach - 与 AI 协同教学，让学习真正发生",
  description:
    "CoTeach 是面向项目式学习的 AI 协同教学平台，贯通教师备课、课堂协作、项目创作、成果评价与学习反思。",
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "CoTeach",
    title: "CoTeach - 与 AI 协同教学，让学习真正发生",
    description:
      "连接教师、学生与 AI 的项目式学习平台，让备课、课堂、创作、评价与反思在同一条教学链路中协同发生。",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" data-scroll-behavior="smooth">
      <body className="min-h-full">
        <div className="pbl-desktop-ui min-h-full">
          <ChunkLoadRecovery />
          <PlatformSessionBoundary>{children}</PlatformSessionBoundary>
          <AppToaster />
        </div>
      </body>
    </html>
  );
}

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
  title: "CoTeach｜AI 协同教学平台",
  description: "CoTeach 是 AI 协同教学平台，支持教师与 AI 协同备课、开展讲授与答疑，以及学生的学习协作、实践与评价。",
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "CoTeach",
    title: "CoTeach｜AI 协同教学平台",
    description: "CoTeach 是 AI 协同教学平台，支持教师与 AI 协同备课、开展讲授与答疑，以及学生的学习协作、实践与评价。",
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

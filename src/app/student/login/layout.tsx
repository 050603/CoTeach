import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "学生登录｜CoTeach",
};

export default function StudentLoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

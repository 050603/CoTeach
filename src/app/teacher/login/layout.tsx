import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "教师登录｜CoTeach",
};

export default function TeacherLoginLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "创建教师账号｜CoTeach",
};

export default function TeacherRegisterLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

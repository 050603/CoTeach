import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "创建学生账号｜CoTeach",
};

export default function StudentRegisterLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

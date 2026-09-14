import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "设置新密码｜CoTeach",
};

export default function StudentResetPasswordLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

import type { ReactNode } from "react";
import { AuthShell } from "./auth-shell";

export function TeacherAuthShell({
  children,
  description,
  mode,
  title,
}: {
  children: ReactNode;
  description: string;
  mode?: "login" | "register";
  title: string;
}) {
  return (
    <AuthShell description={description} mode={mode} role="teacher" title={title}>
      {children}
    </AuthShell>
  );
}

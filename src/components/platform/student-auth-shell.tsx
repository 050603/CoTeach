import type { ReactNode } from "react";
import { AuthShell } from "./auth-shell";

export function StudentAuthShell({ title, description, children, mode }: {
  title: string; description?: string; children: ReactNode; mode?: "login" | "register";
}) {
  return (
    <AuthShell description={description} mode={mode} role="student" title={title}>
      {children}
    </AuthShell>
  );
}

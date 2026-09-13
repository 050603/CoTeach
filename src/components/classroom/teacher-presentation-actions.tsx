"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ActionsTarget = createContext<HTMLElement | null>(null);

export function TeacherPresentationActionsProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <ActionsTarget.Provider value={target}>{children}</ActionsTarget.Provider>;
}

/** Keep stage actions with their existing controller and local state. */
export function TeacherPresentationActions({ children }: { children: ReactNode }) {
  const target = useContext(ActionsTarget);
  return target ? createPortal(children, target) : null;
}

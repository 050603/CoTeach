"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function restoreFocus(previous: HTMLElement | null) {
  window.requestAnimationFrame(() => {
    const target = previous?.isConnected ? previous : [...document.querySelectorAll<HTMLElement>("[data-teacher-presentation-trigger]")].find((element) => element.getClientRects().length);
    target?.focus();
  });
}

/** Browser fullscreen is optional: the presentation layout also works without it. */
export function useTeacherPresentation() {
  const [active, setActive] = useState(false);
  const ownsFullscreen = useRef(false);
  const generation = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  const exit = useCallback(async () => {
    generation.current += 1;
    if (ownsFullscreen.current && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Keep the exit control available if the browser rejects the request.
        return;
      }
    }
    ownsFullscreen.current = false;
    setActive(false);
    restoreFocus(returnFocus.current);
  }, []);

  const enter = useCallback(async () => {
    const request = ++generation.current;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActive(true);
    if (!document.documentElement.requestFullscreen || document.fullscreenElement) return;
    try {
      await document.documentElement.requestFullscreen();
      if (request !== generation.current) {
        if (document.fullscreenElement === document.documentElement) await document.exitFullscreen();
        return;
      }
      ownsFullscreen.current = true;
    } catch {
      // Unsupported/denied fullscreen keeps the viewport-filling layout usable.
    }
  }, []);

  useEffect(() => {
    const synchronize = () => {
      if (ownsFullscreen.current && !document.fullscreenElement) {
        ownsFullscreen.current = false;
        generation.current += 1;
        setActive(false);
        restoreFocus(returnFocus.current);
      }
    };
    document.addEventListener("fullscreenchange", synchronize);
    return () => {
      generation.current += 1;
      document.removeEventListener("fullscreenchange", synchronize);
      if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      ownsFullscreen.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.fullscreenElement) return;
      // Let an open dialog handle Escape before leaving the fallback layout.
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((node) => node.getClientRects().length)) return;
      void exit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, exit]);

  return { active, enter, exit };
}

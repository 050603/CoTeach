"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
import { browseSearch, browseStorageKey, normalizeBrowseState, parseBrowseState, type BrowseState } from "@/lib/textbook/browse-model";

const initial: BrowseState = { view: "read", sectionId: "all", conceptId: null, blockId: null };
export function useTextbookBrowseState(payload: TextbookDetailPayload | null) {
  const [state, setState] = useState<BrowseState>(initial);
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const initialized = useRef("");
  const stateRef = useRef(state);
  const key = payload && userId ? browseStorageKey(userId, payload.textbook.id, payload.revision?.id || payload.textbook.currentRevision?.id || "pending") : "";
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        const subject = typeof data?.user?.sub === "string" && data.user.sub ? data.user.sub : data?.user?.id;
        if (!controller.signal.aborted) setUserId(typeof subject === "string" && subject ? subject : null);
      })
      .catch(() => { if (!controller.signal.aborted) setUserId(null); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!payload || userId === undefined) return;
    const identity = `${payload.textbook.id}:${payload.revision?.id || payload.textbook.currentRevision?.id || "pending"}:${userId}`;
    if (initialized.current === identity) return;
    initialized.current = identity;
    const params = new URLSearchParams(window.location.search);
    let input = parseBrowseState(window.location.search);
    if (!["view", "section", "concept", "block"].some(k => params.has(k)) && key) {
      try { input = JSON.parse(localStorage.getItem(key) || "null") || initial; } catch { /* storage may be blocked */ }
    }
    const restored = normalizeBrowseState(input, payload);
    stateRef.current = restored;
    setState(restored);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${browseSearch(restored)}`);
  }, [key, payload, userId]);
  const remember = useCallback((next: BrowseState) => {
    if (key) try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private browsing still supports navigation */ }
  }, [key]);
  const navigate = useCallback((patch: Partial<BrowseState>) => {
    if (!payload) return;
    const next = normalizeBrowseState({ ...stateRef.current, ...patch }, payload);
    stateRef.current = next;
    setState(next);
    const search = browseSearch(next);
    if (window.location.search !== search) window.history.pushState(window.history.state, "", `${window.location.pathname}${search}`);
    remember(next);
  }, [payload, remember]);
  useEffect(() => {
    const onPop = () => {
      if (!payload) return;
      const next = normalizeBrowseState(parseBrowseState(window.location.search), payload);
      stateRef.current = next; setState(next); remember(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [payload, remember]);
  const rememberBlock = useCallback((blockId: string) => remember({ ...stateRef.current, blockId }), [remember]);
  return { state, navigate, rememberBlock };
}

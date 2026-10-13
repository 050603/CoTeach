"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeDocumentDraft, documentDraftKey, readDocumentDrafts, writeDocumentDraft, type PendingDocumentDraft } from "@/lib/browser/document-draft";
import { clientUUID } from "@/lib/uuid";

type InitialDraft = { id?: string; version: number; content: string };
type SavedDraft = { id: string; version?: number };

/** The edit baseline belongs to this editor, never to a newer background session snapshot. */
export function useCodeDraft(input: {
  scope: string; content: string; initial: InitialDraft; enabled: boolean;
  restore: (content: string) => void;
  persist: (content: string, id: string, expectedVersion: number) => Promise<SavedDraft | undefined>;
}) {
  const latest = useRef(input);
  useEffect(() => { latest.current = input; }, [input]);
  const state = useRef<{ scope: string; key: string; id: string; version: number; saved: string } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const retain = useCallback((content: string, baseline = state.current): PendingDocumentDraft | null => {
    if (!baseline) return null;
    const draft = { key: baseline.key, scope: baseline.scope, submissionId: baseline.id,
      expectedVersion: baseline.version, content, updatedAt: Date.now() };
    try { writeDocumentDraft(draft); return draft; }
    catch { setError("浏览器无法保存本机代码草稿，请保持页面打开并保存到服务器。"); return null; }
  }, []);

  useEffect(() => {
    if (!input.enabled || state.current?.scope === input.scope) return;
    const drafts = readDocumentDrafts(input.scope);
    const recovered = drafts.find(draft => draft.expectedVersion >= input.initial.version && draft.content !== input.initial.content);
    state.current = { scope: input.scope, key: documentDraftKey(input.scope),
      id: recovered?.submissionId ?? input.initial.id ?? clientUUID(),
      version: recovered?.expectedVersion ?? input.initial.version, saved: input.initial.id ? input.initial.content : "" };
    const conflicts = drafts.some(draft => draft.expectedVersion < input.initial.version && draft.content !== input.initial.content);
    setError(conflicts ? "本机有与服务器版本冲突的代码草稿，请下载核对后再编辑。" : null);
    setStatus(recovered ? "unsaved" : "saved");
    if (recovered) input.restore(recovered.content);
  }, [input]);

  const save = useCallback((content = latest.current.content): Promise<boolean> => {
    const baseline = state.current;
    const persist = latest.current.persist;
    const perform = async () => {
      if (!baseline || state.current !== baseline || !latest.current.enabled) return false;
      if (content === baseline.saved) { setStatus("saved"); return true; }
      const draft = retain(content, baseline);
      setStatus("saving");
      try {
        const result = await persist(content, baseline.id, baseline.version);
        if (state.current !== baseline) return false;
        if (!result) throw new Error("代码尚未保存成功。请重试；若其他窗口已修改，请下载本机草稿并刷新核对。");
        baseline.id = result.id;
        baseline.version = result.version ?? baseline.version + 1;
        baseline.saved = content;
        if (draft) { try { acknowledgeDocumentDraft(draft); } catch { /* Safe to retain an acknowledged draft. */ } }
        if (latest.current.content !== content) retain(latest.current.content, baseline);
        setStatus(latest.current.content === content ? "saved" : "unsaved");
        setError(null);
        return true;
      } catch (cause) {
        if (state.current === baseline) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "代码尚未保存成功，请重试。");
        }
        return false;
      }
    };
    const result = chain.current.then(perform, perform);
    chain.current = result;
    return result;
  }, [retain]);

  useEffect(() => {
    const baseline = state.current;
    if (!input.enabled || !baseline || baseline.scope !== input.scope || input.content === baseline.saved) return;
    retain(input.content, baseline);
    setStatus(current => current === "saving" ? current : "unsaved");
    const timer = setTimeout(() => { void save(input.content); }, 900);
    return () => clearTimeout(timer);
  }, [input.content, input.enabled, input.scope, retain, retry, save]);

  useEffect(() => {
    const retrySave = () => setRetry(value => value + 1);
    window.addEventListener("online", retrySave);
    window.addEventListener("focus", retrySave);
    return () => { window.removeEventListener("online", retrySave); window.removeEventListener("focus", retrySave); };
  }, []);

  const download = useCallback(() => {
    const drafts = readDocumentDrafts(latest.current.scope);
    const url = URL.createObjectURL(new Blob([JSON.stringify(drafts, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "本机代码草稿.json"; anchor.click(); URL.revokeObjectURL(url);
  }, []);
  return { status, error, save, download };
}

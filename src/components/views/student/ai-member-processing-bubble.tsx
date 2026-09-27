"use client";

import { useEffect, useState } from "react";

const workingLabels = ["思考中…", "工作中…", "正在组织回答…"] as const;

export function AiMemberProcessingBubble({ recovering = false }: { recovering?: boolean }) {
  const [step, setStep] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (recovering || reducedMotion) return;
    const timer = window.setInterval(() => setStep((current) => (current + 1) % workingLabels.length), 3_000);
    return () => window.clearInterval(timer);
  }, [recovering, reducedMotion]);

  return <div aria-label="AI 组员正在处理" className="max-w-[94%] rounded-xl rounded-bl-sm border border-stone-200 bg-white px-3 py-2.5 text-xs text-stone-600" role="status">
    <span className="block text-[10px] font-semibold text-[var(--pbl-ai)]">AI 组员</span>
    <span className="mt-1 inline-flex items-center gap-2">
      <span>{recovering ? "正在恢复回答…" : reducedMotion ? "正在处理回答…" : workingLabels[step]}</span>
      {!reducedMotion ? <span aria-hidden="true" className="inline-flex items-end gap-0.5 motion-reduce:hidden">
        {[0, 1, 2].map((dot) => <i className="size-1 rounded-full bg-[var(--pbl-ai)] motion-safe:animate-pulse" key={dot} style={{ animationDelay: `${dot * 180}ms` }} />)}
      </span> : null}
    </span>
  </div>;
}

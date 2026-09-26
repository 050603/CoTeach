"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWordcloud } from "@visx/wordcloud";

export type ReflectionWordCloudTerm = {
  label: string;
  value: number;
};

type Props = {
  terms: ReflectionWordCloudTerm[];
  onSelect: (term: ReflectionWordCloudTerm) => void;
  seed?: string;
};

const COLORS = ["#2563eb", "#0f766e", "#7c3aed", "#c2410c", "#be123c", "#475569"];

function seededRandom(seed: string): () => number {
  let state = [...seed].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 2166136261);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function ReflectionWordCloud({ terms, onSelect, seed = "reflection" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const termsSignature = JSON.stringify(terms.map((term) => [term.label, term.value]));
  const stableTerms = useMemo<ReflectionWordCloudTerm[]>(
    () => (JSON.parse(termsSignature) as Array<[string, number]>).map(([label, value]) => ({ label, value })),
    [termsSignature],
  );
  const words = useMemo(() => stableTerms.map((term) => ({ text: term.label, value: term.value })), [stableTerms]);
  const termByLabel = useMemo(() => new Map(stableTerms.map((term) => [term.label, term])), [stableTerms]);
  const fontSize = useCallback(
    (word: { text: string }) => 14 + Math.min(22, Math.max(0, (termByLabel.get(word.text)?.value ?? 1) - 1) * 3),
    [termByLabel],
  );
  const layoutSeed = useMemo(
    () => `${seed}:${width}:${words.map((word) => `${word.text}:${word.value}`).join("|")}`,
    [seed, width, words],
  );
  const random = useMemo(() => seededRandom(layoutSeed), [layoutSeed]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(1, Math.floor(element.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative min-h-52 overflow-hidden rounded-xl bg-gradient-to-br from-slate-50 via-white to-blue-50/50" ref={containerRef}>
      {stableTerms.length ? (
        width ? (
          <ReflectionCloudLayout width={width} words={words} fontSize={fontSize} random={random} termByLabel={termByLabel} onSelect={onSelect} />
        ) : (
          <div className="grid h-52 place-items-center text-xs text-stone-400">词云排版中…</div>
        )
      ) : (
        <div className="grid h-52 place-items-center px-6 text-center text-xs leading-5 text-stone-400">当前反思中尚未形成明确共识</div>
      )}
    </div>
  );
}

function ReflectionCloudLayout({ width, words, fontSize, random, termByLabel, onSelect }: {
  width: number;
  words: Array<{ text: string; value: number }>;
  fontSize: (word: { text: string }) => number;
  random: () => number;
  termByLabel: Map<string, ReflectionWordCloudTerm>;
  onSelect: Props["onSelect"];
}) {
  const cloudWords = useWordcloud({
    font: "ui-sans-serif, system-ui, sans-serif", fontSize, fontWeight: 700,
    height: 208, padding: 3, random, rotate: 0, spiral: "archimedean", width, words,
  });
  // d3-cloud silently omits words that do not fit (especially long labels on
  // narrow desktop panes). Keep every term usable while it lays out or fails to fit.
  if (cloudWords.length < words.length) return (
    <div aria-label="完整反思关键词列表" className="flex h-52 flex-wrap content-start items-center justify-center gap-3 overflow-auto p-4">
      {words.map((word, index) => {
        const term = termByLabel.get(word.text)!;
        return <button
          key={term.label} type="button" aria-label={`${term.label}，涉及 ${term.value} 名学生`}
          className="min-h-11 max-w-full break-words text-center text-base font-bold"
          style={{ color: COLORS[index % COLORS.length] }} onClick={() => onSelect(term)}
        >{term.label}</button>;
      })}
    </div>
  );
  return <svg width={width} height={208} aria-label="反思词云画布">
    <g transform={`translate(${width / 2}, 104)`}>
      {cloudWords.map((word, index) => {
        const term = termByLabel.get(word.text ?? "");
        if (!term) return null;
        return <text
          key={term.label} aria-label={`${term.label}，涉及 ${term.value} 名学生`}
          className="outline-none transition-opacity hover:opacity-70 focus:opacity-70"
          fill={COLORS[index % COLORS.length]} fontFamily={word.font} fontSize={word.size} fontWeight={700}
          role="button" tabIndex={0} textAnchor="middle"
          transform={`translate(${word.x ?? 0}, ${word.y ?? 0}) rotate(${word.rotate ?? 0})`}
          onClick={() => onSelect(term)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(term);
            }
          }}
        >{word.text}</text>;
      })}
    </g>
  </svg>;
}

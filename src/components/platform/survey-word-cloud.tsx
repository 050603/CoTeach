"use client";

import { Wordcloud } from "@visx/wordcloud";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Term = { label: string; value: number };

const COLORS = ["#2563eb", "#0f766e", "#7c3aed", "#0891b2", "#c2410c", "#be185d", "#475569"];

function seededRandom(seed: string): () => number {
  let state = [...seed].reduce((hash, character) => ((hash * 33) ^ character.charCodeAt(0)) >>> 0, 5381);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function SurveyWordCloud({ terms, selected, onSelect, large = false }: { terms: Term[]; selected?: string | null; onSelect: (term: Term) => void; large?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const signature = JSON.stringify(terms.map((term) => [term.label, term.value]));
  const stableTerms = useMemo<Term[]>(() => (JSON.parse(signature) as Array<[string, number]>).map(([label, value]) => ({ label, value })), [signature]);
  const words = useMemo(() => stableTerms.map((term) => ({ text: term.label, value: term.value })), [stableTerms]);
  const maxValue = Math.max(1, ...stableTerms.map((term) => term.value));
  const termByLabel = useMemo(() => new Map(stableTerms.map((term) => [term.label, term])), [stableTerms]);
  const cloudScale = large && size.width && size.height
    ? Math.min(1.5, Math.max(0.86, Math.min(size.width / 1100, size.height / 500)))
    : 1;
  const fontSize = useCallback((word: { text: string }) => {
    const value = termByLabel.get(word.text)?.value ?? 1;
    const ratio = Math.sqrt(value / maxValue);
    return ((large ? 20 : 15) + ratio * (large ? 43 : 29)) * cloudScale;
  }, [cloudScale, large, maxValue, termByLabel]);
  const fontWeight = useCallback((word: { value: number }) => word.value === maxValue ? 800 : 650, [maxValue]);
  const random = useMemo(() => seededRandom(`${size.width}:${size.height}:${signature}`), [signature, size]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(280, Math.floor(rect.width));
      const height = Math.max(large ? 220 : 260, Math.floor(rect.height));
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [large]);

  return <div className={`survey-word-cloud relative overflow-hidden rounded-[24px] border border-white/80 bg-gradient-to-br from-white via-indigo-50/40 to-cyan-50/70 ${large ? "h-[36vh] min-h-[300px]" : "min-h-[360px]"}`} ref={containerRef}>
    <div aria-hidden="true" className="survey-word-cloud-orbit" />
    {stableTerms.length && size.width ? <Wordcloud font="Noto Sans SC" fontSize={fontSize} fontWeight={fontWeight} height={size.height} padding={large ? 7 : 6} random={random} rotate={0} spiral="archimedean" width={size.width} words={words}>
      {(cloudWords) => cloudWords.map((word, index) => {
        const term = termByLabel.get(word.text ?? "");
        if (!term) return null;
        const active = selected === term.label;
        return <text aria-label={`${term.label}，${term.value} 人提及`} className="survey-cloud-word cursor-pointer outline-none" fill={COLORS[index % COLORS.length]} fontFamily={word.font} fontSize={word.size} fontWeight={word.weight} opacity={selected && !active ? 0.34 : 1} role="button" tabIndex={0} textAnchor="middle" transform={`translate(${word.x ?? 0}, ${word.y ?? 0}) rotate(${word.rotate ?? 0}) scale(${active ? 1.08 : 1})`} onClick={() => onSelect(term)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(term); } }} key={`${term.label}-${index}`}>{word.text}</text>;
      })}
    </Wordcloud> : <div className="absolute inset-0 grid place-items-center px-8 text-center"><div><span className="mx-auto block size-12 rounded-full border border-dashed border-indigo-300" /><p className="mt-4 text-sm font-medium text-slate-500">等待学生写下更多想法</p><p className="mt-2 text-xs text-slate-400">收到简答后，关键词会在这里逐渐生长</p></div></div>}
  </div>;
}

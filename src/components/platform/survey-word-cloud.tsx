"use client";

import { useWordcloud } from "@visx/wordcloud";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { planSurveyCloud, type CloudTerm as Term } from "./survey-cloud-layout";

const COLORS = ["#2563eb", "#0f766e", "#7c3aed", "#0891b2", "#c2410c", "#be185d", "#475569"];

// Begin every word at the centre; the collision spiral packs an actual cluster.
const centeredRandom = () => 0.5;
const cloudFontSize = (word: { size: number }) => word.size;
const cloudRotate = (word: { rotate: number }) => word.rotate;
const cloudWordDelay = (index: number) => `${Math.min(index * 28, 620)}ms`;

function CloudLayout({ terms, width, height, large, selected, onSelect, pending, toolbar }: {
  terms: Term[]; width: number; height: number; large: boolean; selected?: string | null;
  onSelect: (term: Term) => void; pending: boolean; toolbar: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const previousSize = useRef({ width, height });
  useEffect(() => {
    if (previousSize.current.width === width && previousSize.current.height === height) return;
    previousSize.current = { width, height };
    // Preserve focused word nodes while recalculating a resized canvas.
    setAttempt(0);
  }, [width, height]);
  const glyphs = useRef<SVGGElement>(null);
  const inset = Math.min(24, width * 0.04, height * 0.08);
  const top = (pending ? 48 : inset) + (toolbar ? 48 : 0);
  const layoutWidth = Math.max(1, width - inset * 2);
  const layoutHeight = Math.max(1, height - top - (toolbar ? 52 : inset));
  const words = useMemo(() => planSurveyCloud(terms, layoutWidth, layoutHeight, large)
    .map((word) => ({ ...word, size: word.size * 0.85 ** attempt })), [terms, layoutWidth, layoutHeight, large, attempt]);
  const cloudWords = useWordcloud({ words, width: layoutWidth, height: layoutHeight, font: "Noto Sans SC",
    fontSize: cloudFontSize, fontWeight: 700, padding: 3, random: centeredRandom, rotate: cloudRotate, spiral: "archimedean" });
  const termByLabel = useMemo(() => new Map(terms.map((term) => [term.label, term])), [terms]);
  const readableList = words.some((word) => word.size < 12) || attempt >= 10 && cloudWords.length < terms.length;
  useEffect(() => {
    if (readableList || !terms.length || cloudWords.length || attempt >= 10) return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), 150);
    return () => clearTimeout(timer);
  }, [attempt, cloudWords.length, terms.length, readableList]);
  useLayoutEffect(() => {
    if (readableList) return;
    if (!cloudWords.length) return;
    if (cloudWords.length < terms.length && attempt < 10) {
      // d3-cloud can omit words that do not fit. Shrink the entire cloud equally and retry.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttempt((value) => value + 1);
      return;
    }
    const bounds = glyphs.current?.getBBox?.();
    if (bounds) setOffset({ x: -(bounds.x + bounds.width / 2), y: -(bounds.y + bounds.height / 2) });
  }, [cloudWords, terms.length, attempt, readableList]);
  if (readableList) return <div aria-label="完整关键词列表" className="absolute inset-x-4 overflow-auto" style={{ top, bottom: toolbar ? 52 : inset }}>
    <p className="mb-3 text-center text-xs text-slate-500">完整词条已换行显示，可滚动查看</p>
    <div className="flex min-h-[70%] flex-wrap content-center items-center justify-center gap-x-4 gap-y-2">
      {words.map((word, index) => {
        const term = termByLabel.get(word.text)!;
        const active = selected === term.label;
        return <button key={term.label} type="button" aria-label={`${term.label}，${term.value} 人提及`} aria-pressed={active} className="survey-cloud-term survey-cloud-term-enter min-h-11 max-w-full break-words px-1 text-center font-bold" style={{ "--survey-word-delay": cloudWordDelay(index), color: COLORS[index % COLORS.length], fontSize: Math.max(14, Math.min(large ? 32 : 26, word.size)), opacity: selected && !active ? 0.34 : 1 } as CSSProperties} onClick={() => onSelect(term)}>{term.label}</button>;
      })}
    </div>
  </div>;
  return <svg aria-label="词云画布" width={width} height={height}>
    <g transform={`translate(${width / 2}, ${top + layoutHeight / 2})`}>
      <g ref={glyphs} transform={`translate(${offset.x}, ${offset.y})`}>
        {cloudWords.map((word, index) => {
          const term = termByLabel.get(word.text ?? "");
          if (!term) return null;
          const active = selected === term.label;
          return <g className="survey-cloud-word-enter" style={{ "--survey-word-delay": cloudWordDelay(index) } as CSSProperties} key={term.label}>
            <text aria-label={`${term.label}，${term.value} 人提及`} aria-pressed={active} className="survey-cloud-word cursor-pointer outline-none" fill={COLORS[index % COLORS.length]} fontFamily={word.font} fontSize={word.size} fontWeight={word.weight} opacity={selected && !active ? 0.34 : 1} role="button" tabIndex={0} textAnchor="middle" transform={`translate(${word.x ?? 0}, ${word.y ?? 0}) rotate(${word.rotate ?? 0})`} onClick={() => onSelect(term)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(term); } }} >{word.text}</text>
          </g>;
        })}
      </g>
    </g>
  </svg>;
}

export function SurveyWordCloud({ terms, selected, onSelect, large = false, status, hasResponses = false }: { terms: Term[]; selected?: string | null; onSelect: (term: Term) => void; large?: boolean; status?: "processing" | "ready" | "unavailable"; hasResponses?: boolean; analyzedCount?: number; responseCount?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const signature = JSON.stringify(terms.map((term) => [term.label, term.value]));
  const stableTerms = useMemo<Term[]>(() => (JSON.parse(signature) as Array<[string, number]>).map(([label, value]) => ({ label, value })), [signature]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filteredTerms = useMemo(() => stableTerms.filter((term) => term.label.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .includes(query.normalize("NFKC").toLocaleLowerCase("zh-CN").trim())), [stableTerms, query]);
  const pageCount = Math.max(1, Math.ceil(filteredTerms.length / 48));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleTerms = useMemo(() => filteredTerms.slice(currentPage * 48, (currentPage + 1) * 48), [filteredTerms, currentPage]);
  const toolbar = stableTerms.length > 48;
  const [fontsReady, setFontsReady] = useState<boolean>(() => typeof document !== "undefined" && !document.fonts);
  useEffect(() => {
    let active = true;
    const ready = document.fonts?.load('700 32px "Noto Sans SC"') ?? Promise.resolve();
    void ready.catch(() => undefined).then(() => { if (active) setFontsReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [large]);

  return <div className={`survey-word-cloud survey-word-cloud-enter relative overflow-hidden rounded-[24px] border border-white/80 bg-gradient-to-br from-white via-indigo-50/40 to-cyan-50/70 ${large ? "h-[36vh] min-h-[300px]" : "min-h-[360px]"}`} ref={containerRef}>
    {stableTerms.length > 0 && (status === "processing" || status === "unavailable") ? <p role="status" className="pointer-events-none absolute inset-x-4 top-3 z-10 rounded-full bg-white/90 px-3 py-2 text-center text-xs text-slate-500">{status === "processing" ? "正在分析新增回答" : "新增回答分析暂时不可用"}</p> : null}
    {toolbar ? <div className={`absolute inset-x-4 z-10 ${status === "processing" || status === "unavailable" ? "top-14" : "top-3"}`}><input aria-label="查找关键词" className="h-11 w-full rounded-lg border border-slate-200 bg-white/90 px-3 text-sm" value={query} placeholder="查找关键词" onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></div> : null}
    {stableTerms.length && size.width ? <>
      {fontsReady ? <CloudLayout key={JSON.stringify(visibleTerms)} terms={visibleTerms} width={size.width} height={size.height} large={large} selected={selected} onSelect={onSelect} pending={status === "processing" || status === "unavailable"} toolbar={toolbar} /> : <svg aria-label="词云画布" width={size.width} height={size.height} />}
      {query && !visibleTerms.length ? <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">没有匹配的关键词，可查看全部回答</p> : null}
      {toolbar ? <div className="absolute inset-x-3 bottom-1 flex items-center justify-center gap-3 text-xs text-slate-500">
        <button aria-label="上一页关键词" type="button" className="min-h-11 px-2 disabled:opacity-40" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <span>第 {currentPage + 1}/{pageCount} 页</span>
        <button aria-label="下一页关键词" type="button" className="min-h-11 px-2 disabled:opacity-40" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div> : null}
    </> : <div className="absolute inset-0 grid place-items-center px-8 text-center"><div><span className="mx-auto block size-12 rounded-full border border-dashed border-indigo-300" /><p className="mt-4 text-sm font-medium text-slate-500">{status === "processing" ? "正在提取回答关键词" : status === "unavailable" ? "关键词分析暂时不可用" : hasResponses ? "暂无可提取的关键词" : "等待学生写下更多想法"}</p><p className="mt-2 text-xs text-slate-400">{status === "processing" ? "分析完成后自动显示，可先查看其他题目" : status === "unavailable" ? "回答已保留，稍后会自动重试" : hasResponses ? "后续回答有新内容时会自动更新" : "收到简答后，关键词会在这里逐渐生长"}</p></div></div>}
  </div>;
}

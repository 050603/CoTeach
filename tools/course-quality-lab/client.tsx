import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  ArtifactState,
  CourseQualityLabManifest,
  LabPair,
  LabPipelineModule,
  LabScriptSegment,
  LabSection,
  LabTokenUsageSource,
  LabVariantKey,
  LabVariantMetrics,
  LabVariantResult,
  PairReview,
  ReviewCollection,
  ReviewDimension,
  ReviewOutcome,
} from "./types";
import "./styles.css";

const VARIANTS: LabVariantKey[] = ["baseline", "enhanced"];
const DIMENSIONS: Array<{ key: ReviewDimension; label: string }> = [
  { key: "explanationDepth", label: "讲解深度" },
  { key: "examples", label: "案例" },
  { key: "teachingAssessmentAlignment", label: "讲练一致性" },
  { key: "visualExpression", label: "视觉表达" },
  { key: "listeningExperience", label: "听感" },
];
const OUTCOMES: Array<{ value: ReviewOutcome; label: string }> = [
  { value: "baseline", label: "基线更好" },
  { value: "enhanced", label: "本次优化更好" },
  { value: "tie", label: "相当" },
  { value: "undecided", label: "暂不判断" },
];
const STATUS_LABELS: Record<ArtifactState, string> = {
  pending: "等待中",
  running: "生成中",
  complete: "已完成",
  failed: "失败",
  missing: "缺失",
};
const MODULE_LABELS: Record<LabPipelineModule, string> = {
  planning: "教学规划",
  slide: "PPT",
  narration: "文稿",
  action: "动作",
  review: "审核",
  repair: "修复",
  quiz: "测验",
  tts: "音频",
};
const TOKEN_SOURCE_LABELS: Record<LabTokenUsageSource, string> = {
  "provider-reported": "供应商实报",
  estimated: "估算",
  mixed: "实报与估算混合",
  unknown: "来源未知",
};

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type View = "compare" | "summary";

function emptyReview(pairId: string): PairReview {
  return {
    pairId,
    outcome: "undecided",
    dimensions: {},
    pageNotes: {},
  };
}

function normalizeReviews(payload: ReviewCollection | PairReview[] | Record<string, PairReview>): Record<string, PairReview> {
  const list = Array.isArray(payload)
    ? payload
    : "reviews" in payload && Array.isArray(payload.reviews)
      ? payload.reviews
      : Object.values(payload);
  return Object.fromEntries(
    list
      .filter((review): review is PairReview => Boolean(review?.pairId))
      .map((review) => [review.pairId, { ...emptyReview(review.pairId), ...review }]),
  );
}

function formatTime(rawSeconds: number): string {
  const seconds = Number.isFinite(rawSeconds) ? Math.max(0, Math.round(rawSeconds)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function formatElapsed(rawMilliseconds: number): string {
  const seconds = Math.max(0, Math.round(rawMilliseconds / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function tokenSource(metrics: LabVariantMetrics): LabTokenUsageSource {
  return metrics.tokenUsageSource ?? "unknown";
}

function resultPipelineVersion(result: LabVariantResult): string | undefined {
  return result.pipelineVersion ?? result.metrics?.pipelineVersion;
}

function isV4V5Pair(pair: LabPair): boolean {
  const baseline = `${resultPipelineVersion(pair.variants.baseline) ?? ""} ${pair.variants.baseline.label ?? ""}`;
  const enhanced = `${resultPipelineVersion(pair.variants.enhanced) ?? ""} ${pair.variants.enhanced.label ?? ""}`;
  return /\bv?4(?:\b|[-_.])/i.test(baseline) && /\bv?5(?:\b|[-_.])/i.test(enhanced);
}

function pairIsComplete(pair: LabPair): boolean {
  return VARIANTS.every((variant) => {
    const statuses = pair.variants[variant].statuses;
    return statuses.ppt.state === "complete"
      && statuses.script.state === "complete"
      && statuses.tts.state === "complete";
  });
}

function defaultPair(section?: LabSection): LabPair | undefined {
  if (!section) return undefined;
  return [...section.pairs]
    .sort((left, right) => {
      const readiness = Number(pairIsComplete(right)) - Number(pairIsComplete(left));
      if (readiness) return readiness;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
      if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) return rightTime - leftTime;
      const preference = Number(isV4V5Pair(right)) - Number(isV4V5Pair(left));
      if (preference) return preference;
      return right.batch - left.batch;
    })[0];
}

function variantTitle(pair: LabPair, variant: LabVariantKey): string {
  const result = pair.variants[variant];
  if (result.label) return result.label;
  const version = resultPipelineVersion(result);
  if (/^v?4(?:\b|[-_.])/i.test(version ?? "") && variant === "baseline") return "V4 clean 基线";
  if (/^v?5(?:\b|[-_.])/i.test(version ?? "") && variant === "enhanced") return "V5 优化候选";
  if (version) return `${version} · ${variant === "baseline" ? "基线" : "候选"}`;
  return variant === "baseline" ? "当前基线" : "本次优化版";
}

function MetricStrip({ metrics }: { metrics?: LabVariantMetrics }) {
  if (!metrics) return null;
  const source = tokenSource(metrics);
  const tokenTitle = `${metrics.tokenUsage.toLocaleString()} tokens；${TOKEN_SOURCE_LABELS[source]}。输入 ${metrics.inputCharacters.toLocaleString()} 字符，输出 ${metrics.outputCharacters.toLocaleString()} 字符。`;
  return (
    <section className="metric-strip" aria-label="成本与稳定性指标">
      <div title={tokenTitle}>
        <span>Token 用量</span>
        <b>{formatCompactNumber(metrics.tokenUsage)}</b>
        <small>{TOKEN_SOURCE_LABELS[source]} · 输入/输出字符 {formatCompactNumber(metrics.inputCharacters)} / {formatCompactNumber(metrics.outputCharacters)}</small>
      </div>
      <div title="模型与语音调用耗时之和；并行请求的耗时会重叠，因此不等同于墙钟总时长。">
        <span>端到端 / 调用合计</span>
        <b>{metrics.telemetryRecorded ? formatElapsed(metrics.wallClockMs) : "未记录"}</b>
        <small>模型 {formatElapsed(metrics.modelElapsedMs)} · TTS {formatElapsed(metrics.ttsElapsedMs)}</small>
      </div>
      <div className={metrics.failedModelCalls || metrics.abandonedModelCalls ? "metric--warning" : ""}>
        <span>逻辑调用</span>
        <b>{metrics.modelCalls}</b>
        <small>设计 {metrics.designCalls} · 生成/审核 {metrics.generationCalls} · 失败/中断 {metrics.failedModelCalls}/{metrics.abandonedModelCalls}</small>
      </div>
      <div className={metrics.transportRetries ? "metric--warning" : ""}>
        <span>真实请求</span>
        <b>{metrics.transportAttemptsRecorded ? metrics.transportAttempts : "未记录"}</b>
        <small>{metrics.transportAttemptsRecorded ? `传输重试 ${metrics.transportRetries}` : "历史版本无法直接比较"}</small>
      </div>
      <div>
        <span>质量修复 / 恢复复用</span>
        <b>{metrics.telemetryRecorded ? `${metrics.qualityRepairCalls} / ${metrics.checkpointReuses}` : "未记录"}</b>
        <small>模型质量修复与检查点复用分开统计</small>
      </div>
      <div>
        <span>首次通过页面</span>
        <b>{metrics.firstPassPages !== undefined && metrics.evaluatedPages !== undefined
          ? `${metrics.firstPassPages} / ${metrics.evaluatedPages}`
          : "未记录"}</b>
        <small>{metrics.deterministicAdjustments !== undefined
          ? `确定性调整 ${metrics.deterministicAdjustments}`
          : "历史版本没有首次检查数据"}</small>
      </div>
      <div className={metrics.failedTtsCalls ? "metric--warning" : ""}>
        <span>TTS 调用</span>
        <b>{metrics.ttsCalls}</b>
        <small>失败 {metrics.failedTtsCalls} · 缓存命中 {metrics.ttsCacheHits}</small>
      </div>
    </section>
  );
}

function PipelineDetails({ result }: { result: LabVariantResult }) {
  const metrics = result.metrics;
  const modules = metrics?.moduleMetrics
    ? Object.entries(metrics.moduleMetrics) as Array<[LabPipelineModule, NonNullable<LabVariantMetrics["moduleMetrics"]>[LabPipelineModule]]>
    : [];
  const repairs = metrics?.repairEvents ?? [];
  const version = resultPipelineVersion(result);
  const artifacts = Object.entries(metrics?.artifactVersions ?? {});
  if (!version && !modules.length && !repairs.length && !artifacts.length) return null;
  return (
    <section className="pipeline-details" aria-label="流水线版本与模块指标">
      <div className="pipeline-version">
        <span>流水线</span>
        <b>{version ?? "版本未记录"}</b>
        {artifacts.length > 0 && <small>检查点 {artifacts.length} 类</small>}
      </div>
      {artifacts.length > 0 && (
        <div className="artifact-versions" aria-label="检查点产物版本">
          {artifacts.map(([name, artifactVersion]) => <span key={name}><b>{name}</b> {artifactVersion}</span>)}
        </div>
      )}
      {modules.length > 0 && (
        <details open>
          <summary>模块成本与时长（{modules.length}）</summary>
          <div className="module-metrics-table" role="table" aria-label="模块成本与时长">
            <div className="module-metrics-head" role="row"><span>模块</span><span>Token / 来源</span><span>调用 / 失败</span><span>耗时</span></div>
            {modules.map(([module, item]) => item && (
              <div role="row" key={module}>
                <b>{MODULE_LABELS[module]}</b>
                <span>{formatCompactNumber(item.tokenUsage)} <small>{TOKEN_SOURCE_LABELS[item.tokenUsageSource]}</small></span>
                <span>{item.calls} / {item.failedCalls}</span>
                <span>{formatElapsed(item.elapsedMs)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {repairs.length > 0 && (
        <details>
          <summary>修复轨迹（{repairs.length}）</summary>
          <ul className="repair-events">
            {repairs.map((event, index) => (
              <li key={`${event.module}-${event.scope}-${event.attempt}-${index}`}>
                <b>{event.module} · {event.scope}</b>
                <span>{event.reason}</span>
                <small>{event.outcome} · 第 {event.attempt} 次 · 影响 {event.targetIds.length} 项</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SummaryMetric({ result }: { result: LabVariantResult }) {
  const metrics = result.metrics;
  if (!metrics) return <span className="metric-empty">暂无记录</span>;
  const failures = metrics.failedModelCalls + metrics.failedTtsCalls;
  const source = tokenSource(metrics);
  return (
    <span className="summary-metric">
      <b>{formatCompactNumber(metrics.tokenUsage)} tokens · {TOKEN_SOURCE_LABELS[source]}</b>
      {resultPipelineVersion(result) && <small>{resultPipelineVersion(result)}</small>}
      <small>{metrics.modelCalls} 次逻辑调用 · {metrics.transportAttemptsRecorded ? `${metrics.transportAttempts} 次真实请求` : "真实请求未记录"} · {failures} 失败 · {metrics.telemetryRecorded ? formatElapsed(metrics.wallClockMs) : formatElapsed(metrics.modelElapsedMs + metrics.ttsElapsedMs)}</small>
    </span>
  );
}

function artifactUrl(pairId: string, variant: LabVariantKey, kind: "pptx" | "script" | "audio.zip"): string {
  return `/api/download/${encodeURIComponent(pairId)}/${variant}/${kind}`;
}

function StatusBadge({ state, message, label }: { state: ArtifactState; message?: string; label: string }) {
  return (
    <span className={`status status--${state}`} title={message}>
      <span className="status__dot" aria-hidden="true" />
      {label} · {STATUS_LABELS[state]}
    </span>
  );
}

function Downloads({ pair, variant, result }: { pair: LabPair; variant: LabVariantKey; result: LabVariantResult }) {
  const links = [
    { label: "PPTX", href: result.downloads?.pptx ?? artifactUrl(pair.id, variant, "pptx") },
    { label: "讲稿", href: result.downloads?.script ?? artifactUrl(pair.id, variant, "script") },
    { label: "音频包", href: result.downloads?.audioZip ?? artifactUrl(pair.id, variant, "audio.zip") },
  ];
  return (
    <div className="download-row" aria-label="下载本方案产物">
      {links.map((link) => (
        <a className="text-link" href={link.href} download key={link.label}>
          {link.label}
        </a>
      ))}
    </div>
  );
}

function SlideFrame({ pairId, variant, result, pageIndex, activeSegmentId }: {
  pairId: string;
  variant: LabVariantKey;
  result: LabVariantResult;
  pageIndex: number;
  activeSegmentId?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const slide = result.slides[pageIndex];
  const src = slide
    ? `/render-pair/${encodeURIComponent(pairId)}/${variant}/${pageIndex}`
    : undefined;
  const syncAction = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({
      type: "course-quality-lab:active-segment",
      segmentId: activeSegmentId,
    }, window.location.origin);
  }, [activeSegmentId]);

  useEffect(syncAction, [syncAction, src]);
  if (!slide) {
    return <div className="slide-empty">本方案没有第 {pageIndex + 1} 页</div>;
  }
  if (!src) {
    return (
      <div className="slide-empty">
        <span>第 {pageIndex + 1} 页尚无预览</span>
        <small>{slide.title}</small>
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      className="slide-frame"
      src={src}
      title={`${slide.title ?? "幻灯片"}，第 ${pageIndex + 1} 页`}
      sandbox="allow-scripts allow-same-origin"
      onLoad={syncAction}
    />
  );
}

interface AudioPlayerProps {
  variant: LabVariantKey;
  segments: LabScriptSegment[];
  registerAudio: (variant: LabVariantKey, audio: HTMLAudioElement | null) => void;
  onExclusivePlay: (variant: LabVariantKey) => void;
  onSlideChange: (slideIndex: number) => void;
  onActiveSegment: (segmentId?: string) => void;
}

function AudioAndScript({ variant, segments, registerAudio, onExclusivePlay, onSlideChange, onActiveSegment }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingRef = useRef<{ play: boolean; offset: number } | null>(null);
  const [segmentIndex, setSegmentIndex] = useState(() => Math.max(0, segments.findIndex((item) => item.audioUrl)));
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string>();
  const [measuredDurations, setMeasuredDurations] = useState<Record<string, number>>({});

  const durationFor = useCallback(
    (segment: LabScriptSegment) => segment.durationSec ?? measuredDurations[segment.id] ?? 0,
    [measuredDurations],
  );
  const totalDuration = useMemo(
    () => segments.reduce((total, segment) => total + durationFor(segment), 0),
    [durationFor, segments],
  );
  const elapsedBefore = useMemo(
    () => segments.slice(0, segmentIndex).reduce((total, segment) => total + durationFor(segment), 0),
    [durationFor, segmentIndex, segments],
  );
  const active = segments[segmentIndex];

  useEffect(() => {
    onActiveSegment(active?.id);
  }, [active?.id, onActiveSegment]);

  const attachAudio = useCallback(
    (element: HTMLAudioElement | null) => {
      audioRef.current = element;
      registerAudio(variant, element);
    },
    [registerAudio, variant],
  );

  const startActive = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !active?.audioUrl) return;
    onSlideChange(active.slideIndex);
    onExclusivePlay(variant);
    audio.playbackRate = rate;
    void audio.play().catch(() => setError("浏览器未能开始播放，请再次点击播放。"));
  }, [active, onExclusivePlay, onSlideChange, rate, variant]);

  const chooseSegment = useCallback(
    (nextIndex: number, offset = 0, shouldPlay = true, shouldContinue = false) => {
      const next = segments[nextIndex];
      if (next) onSlideChange(next.slideIndex);
      if (!next?.audioUrl) {
        setError(next?.audioStatus?.message ?? "这个讲稿段落没有可播放音频。去生成状态查看失败原因。");
        return;
      }
      setError(undefined);
      setContinuous(shouldContinue);
      if (nextIndex === segmentIndex) {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, offset);
        setPosition(audio.currentTime);
        if (shouldPlay) startActive();
        return;
      }
      pendingRef.current = { play: shouldPlay, offset };
      setSegmentIndex(nextIndex);
    },
    [onSlideChange, segmentIndex, segments, startActive],
  );

  const handleLoaded = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !active) return;
    audio.playbackRate = rate;
    if (Number.isFinite(audio.duration)) {
      setMeasuredDurations((current) => ({ ...current, [active.id]: audio.duration }));
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    audio.currentTime = Math.min(Math.max(0, pending.offset), Number.isFinite(audio.duration) ? audio.duration : pending.offset);
    setPosition(audio.currentTime);
    if (pending.play) startActive();
  }, [active, rate, startActive]);

  const handleEnded = useCallback(() => {
    setPlaying(false);
    if (!continuous) return;
    const nextIndex = segments.findIndex((segment, index) => index > segmentIndex && Boolean(segment.audioUrl));
    if (nextIndex >= 0) chooseSegment(nextIndex, 0, true, true);
    else setContinuous(false);
  }, [chooseSegment, continuous, segmentIndex, segments]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (playing && audio) {
      audio.pause();
      setContinuous(false);
      return;
    }
    setContinuous(true);
    if (!active?.audioUrl) {
      const first = segments.findIndex((segment) => segment.audioUrl);
      if (first >= 0) chooseSegment(first, 0, true, true);
      else setError("这一侧还没有可播放音频。");
      return;
    }
    startActive();
  };

  const seekWholeSection = (target: number) => {
    let cursor = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const duration = durationFor(segments[index]);
      if (target <= cursor + duration || index === segments.length - 1) {
        chooseSegment(index, Math.max(0, target - cursor), playing, continuous);
        return;
      }
      cursor += duration;
    }
  };

  return (
    <section className="script-block">
      <div className="audio-controls">
        <button className="primary-button" type="button" onClick={togglePlayback}>
          {playing ? "暂停" : "整节播放"}
        </button>
        <span className="timecode">{formatTime(elapsedBefore + position)} / {formatTime(totalDuration)}</span>
        <label className="rate-control">
          <span>倍速</span>
          <select
            aria-label="播放速度"
            value={rate}
            onChange={(event) => {
              const next = Number(event.target.value);
              setRate(next);
              if (audioRef.current) audioRef.current.playbackRate = next;
            }}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <input
          className="audio-progress"
          type="range"
          aria-label="整节音频进度"
          min={0}
          max={Math.max(totalDuration, 1)}
          step={0.1}
          value={Math.min(elapsedBefore + position, Math.max(totalDuration, 1))}
          disabled={totalDuration <= 0}
          onChange={(event) => seekWholeSection(Number(event.target.value))}
        />
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <audio
        ref={attachAudio}
        src={active?.audioUrl}
        preload="metadata"
        onLoadedMetadata={handleLoaded}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={() => {
          onExclusivePlay(variant);
          setPlaying(true);
          setError(undefined);
        }}
        onPause={() => setPlaying(false)}
        onEnded={handleEnded}
        onError={() => setError(active?.audioStatus?.message ?? "音频加载失败。")}
      />
      <div className="script-list" aria-label="讲稿段落">
        {segments.length === 0 && <p className="empty-copy">讲稿尚未生成。</p>}
        {segments.map((segment, index) => (
          <button
            className={`script-segment ${index === segmentIndex ? "script-segment--active" : ""}`}
            type="button"
            key={segment.id}
            onClick={() => chooseSegment(index)}
          >
            <span className="script-segment__meta">
              第 {segment.slideIndex + 1} 页 · {formatTime(durationFor(segment))}
              {segment.audioStatus?.state === "failed" && <em>音频失败</em>}
            </span>
            <span>{segment.text}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function QuizList({ result }: { result: LabVariantResult }) {
  return (
    <section className="subsection">
      <div className="subsection__title">
        <h3>节末题</h3>
        <span>{result.quiz.length} 题</span>
      </div>
      {result.quiz.length === 0 && <p className="empty-copy">题目尚未生成。</p>}
      <div className="quiz-list">
        {result.quiz.map((question, index) => (
          <article className="quiz-card" key={question.id}>
            <p><b>{index + 1}.</b> {question.prompt}</p>
            <details>
              <summary>查看答案与评分依据</summary>
              <div className="quiz-answer">
                <p><b>答案：</b>{question.answer}</p>
                {question.rationale && <p><b>评分依据：</b>{question.rationale}</p>}
              </div>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

interface VariantPaneProps {
  pair: LabPair;
  variant: LabVariantKey;
  pageIndex: number;
  enlarged: LabVariantKey | null;
  onToggleEnlarged: (variant: LabVariantKey) => void;
  registerAudio: AudioPlayerProps["registerAudio"];
  onExclusivePlay: AudioPlayerProps["onExclusivePlay"];
  onSlideChange: AudioPlayerProps["onSlideChange"];
}

function VariantPane({ pair, variant, pageIndex, enlarged, onToggleEnlarged, registerAudio, onExclusivePlay, onSlideChange }: VariantPaneProps) {
  const paneRef = useRef<HTMLElement | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string>();
  const result = pair.variants[variant];
  const slide = result.slides[pageIndex];
  const pageDuration = result.script
    .filter((segment) => segment.slideIndex === pageIndex)
    .reduce((total, segment) => total + (segment.durationSec ?? 0), 0);
  const title = variantTitle(pair, variant);
  const hiddenByEnlarge = enlarged && enlarged !== variant;

  return (
    <article
      className={`variant-pane variant-pane--${variant} ${enlarged === variant ? "variant-pane--enlarged" : ""} ${hiddenByEnlarge ? "variant-pane--hidden" : ""}`}
      ref={paneRef}
    >
      <header className="variant-header">
        <div>
          <span className="variant-kicker">{variant === "baseline" ? "A 方案" : "B 方案"}</span>
          <h2>{title}</h2>
        </div>
        <div className="variant-actions">
          <button className="quiet-button" type="button" onClick={() => onToggleEnlarged(variant)}>
            {enlarged === variant ? "恢复并排" : "放大"}
          </button>
          <button className="quiet-button" type="button" onClick={() => void paneRef.current?.requestFullscreen()}>
            全屏
          </button>
        </div>
      </header>
      <div className="status-row">
        <StatusBadge label="PPT" {...result.statuses.ppt} />
        <StatusBadge label="讲稿" {...result.statuses.script} />
        <StatusBadge label="TTS" {...result.statuses.tts} />
      </div>
      <MetricStrip metrics={result.metrics} />
      <PipelineDetails result={result} />
      <div className="slide-shell">
        <SlideFrame
          pairId={pair.id}
          variant={variant}
          result={result}
          pageIndex={pageIndex}
          activeSegmentId={activeSegmentId}
        />
      </div>
      <div className="slide-caption">
        <span>第 {pageIndex + 1} / {result.slides.length || 0} 页</span>
        <b>{slide?.title ?? "等待页面"}</b>
        {pageDuration > 0 && <span>讲稿 {formatTime(pageDuration)}</span>}
      </div>
      {slide?.checkMessages?.map((message) => <p className="check-message" key={message}>{message}</p>)}
      <AudioAndScript
        variant={variant}
        segments={result.script}
        registerAudio={registerAudio}
        onExclusivePlay={onExclusivePlay}
        onSlideChange={onSlideChange}
        onActiveSegment={setActiveSegmentId}
      />
      <QuizList result={result} />
      {(result.checks?.length ?? 0) > 0 && (
        <details className="checks">
          <summary>自动检查报告（{result.checks?.length}）</summary>
          <ul>{result.checks?.map((check) => <li key={check}>{check}</li>)}</ul>
        </details>
      )}
      <Downloads pair={pair} variant={variant} result={result} />
    </article>
  );
}

function ReferencePanel({ section }: { section: LabSection }) {
  const design = section.enhancedDesign;
  return (
    <details className="reference-panel">
      <summary>参考资料、教学目标与本次优化设计</summary>
      <div className="reference-grid">
        <section>
          <h3>教学目标</h3>
          <ul>{section.learningObjectives.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h3>来源资料</h3>
          <ul>
            {section.sources.map((source) => (
              <li key={`${source.title}-${source.url ?? ""}`}>
                {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}
                {source.detail && <small>{source.detail}</small>}
              </li>
            ))}
          </ul>
        </section>
        <section className="reference-grid__design">
          <h3>本次优化设计</h3>
          {!design && <p className="empty-copy">暂无本次优化设计记录。</p>}
          {design?.pagePlan?.length ? (
            <div className="design-group">
              <b>页面分工</b>
              <ul>{design.pagePlan.map((item) => (
                <li key={`${item.page}-${item.purpose}`}>
                  第 {item.page} 页：{item.purpose}；此前已讲：{item.priorKnowledge}；本页新增：{item.newContent}
                </li>
              ))}</ul>
            </div>
          ) : null}
        </section>
      </div>
    </details>
  );
}

interface ReviewPanelProps {
  pageIndex: number;
  review: PairReview;
  saveState: SaveState;
  onChange: (updater: (review: PairReview) => PairReview) => void;
}

interface TeacherReviewPanelProps {
  pair: LabPair;
  pageIndex: number;
  review: PairReview;
  saveState: SaveState;
  onChange: (updater: (review: PairReview) => PairReview) => void;
}

const TEACHER_REVIEW_OPTIONS = [
  { value: "pending" as const, label: "待处理" },
  { value: "confirmed" as const, label: "已确认" },
  { value: "needs-revision" as const, label: "需修改" },
];

function TeacherReviewPanel({ pair, pageIndex, review, saveState, onChange }: TeacherReviewPanelProps) {
  const entries = VARIANTS.flatMap((variant) => (pair.variants[variant].teacherReviewNotes ?? [])
    .filter((note) => note.page === pageIndex + 1)
    .map((note) => ({ variant, note })));
  const total = VARIANTS.reduce((sum, variant) => sum + (pair.variants[variant].teacherReviewNotes?.length ?? 0), 0);
  const saveLabel = saveState === "pending" ? "等待保存…"
    : saveState === "saving" ? "正在保存…"
      : saveState === "saved" ? "已保存"
        : saveState === "error" ? "保存失败，请继续编辑以重试" : "";
  const updateDecision = (
    variant: LabVariantKey,
    noteId: string,
    patch: { status?: "pending" | "confirmed" | "needs-revision"; note?: string },
  ) => onChange((current) => {
    const existing = current.teacherReviews?.[variant];
    const decision = existing?.notes[noteId] ?? { status: "pending" as const };
    return {
      ...current,
      teacherReviews: {
        ...current.teacherReviews,
        [variant]: {
          experimentId: pair.experimentId ?? pair.id,
          variant,
          notes: {
            ...(existing && existing.experimentId === pair.experimentId ? existing.notes : {}),
            [noteId]: { ...decision, ...patch },
          },
        },
      },
    };
  });

  return (
    <section className="teacher-review-panel">
      <header className="review-panel__header">
        <div>
          <span className="eyebrow">仅供教师</span>
          <h2>课程已保存：请复核存疑内容</h2>
          <p role="status">疑点不阻断生成。内容审核发现的存疑断言会保留在学生内容中，请教师在发布或授课前逐条核实并按需修改。</p>
        </div>
        <span className={`save-state save-state--${saveState}`} role="status">{saveLabel}</span>
      </header>
      {entries.length ? (
        <div className="teacher-review-list">
          {entries.map(({ variant, note }) => {
            const saved = review.teacherReviews?.[variant];
            const decision = saved && saved.experimentId === pair.experimentId
              ? saved.notes[note.id]
              : undefined;
            return (
              <article className="teacher-review-item" key={`${variant}-${note.id}`}>
                <div className="teacher-review-item__heading">
                  <span>{variant === "enhanced" ? "本次优化版" : "当前基线"}</span>
                  <select
                    aria-label={`审核状态：${note.claim}`}
                    value={decision?.status ?? "pending"}
                    onChange={(event) => updateDecision(variant, note.id, {
                      status: event.target.value as "pending" | "confirmed" | "needs-revision",
                    })}
                  >
                    {TEACHER_REVIEW_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <h3>{note.claim}</h3>
                <p><b>原因：</b>{note.reason}</p>
                <p><b>建议：</b>{note.suggestion}</p>
                <label>
                  <span>教师备注</span>
                  <textarea
                    rows={2}
                    value={decision?.note ?? ""}
                    placeholder="记录核实依据、修改意见或后续处理…"
                    onChange={(event) => updateDecision(variant, note.id, { note: event.target.value })}
                  />
                </label>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="teacher-review-empty">
          {total ? `第 ${pageIndex + 1} 页没有待审核疑点；本小节其他页面共有 ${total} 条。` : "本小节没有识别到需要教师核实的事实疑点。"}
        </p>
      )}
    </section>
  );
}

function ReviewPanel({ pageIndex, review, saveState, onChange }: ReviewPanelProps) {
  const pageKey = String(pageIndex);
  const saveLabels: Record<SaveState, string> = {
    idle: "",
    pending: "等待保存…",
    saving: "正在保存…",
    saved: "已保存",
    error: "保存失败，请继续编辑以重试",
  };
  return (
    <section className="review-panel">
      <header className="review-panel__header">
        <div>
          <span className="eyebrow">你的评判</span>
          <h2>这组结果表现如何？</h2>
        </div>
        <span className={`save-state save-state--${saveState}`} role="status">{saveLabels[saveState]}</span>
      </header>
      <div className="outcome-options" role="radiogroup" aria-label="总体结论">
        {OUTCOMES.map((option) => (
          <button
            type="button"
            role="radio"
            aria-checked={review.outcome === option.value}
            className={review.outcome === option.value ? "selected" : ""}
            key={option.value}
            onClick={() => onChange((current) => ({ ...current, outcome: option.value }))}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="dimension-grid">
        {DIMENSIONS.map(({ key, label }) => (
          <label key={key}>
            <span>{label}</span>
            <select
              value={review.dimensions[key] ?? ""}
              onChange={(event) => onChange((current) => {
                const dimensions = { ...current.dimensions };
                const value = Number(event.target.value);
                if (value) dimensions[key] = value;
                else delete dimensions[key];
                return { ...current, dimensions };
              })}
            >
              <option value="">未评分</option>
              {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value} 分</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="review-notes">
        <label>
          <span>第 {pageIndex + 1} 页对比备注</span>
          <textarea
            rows={3}
            value={review.pageNotes[pageKey] ?? ""}
            placeholder="记录内容、画面或讲稿在这一页的具体差异…"
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({ ...current, pageNotes: { ...current.pageNotes, [pageKey]: value } }));
            }}
          />
        </label>
        <label>
          <span>本小节总体备注</span>
          <textarea
            rows={3}
            value={review.overallNote ?? ""}
            placeholder="记录最终判断、需要复查的地方或下一轮修改建议…"
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({ ...current, overallNote: value }));
            }}
          />
        </label>
      </div>
    </section>
  );
}

function Summary({ manifest, reviews, onOpenPair }: {
  manifest: CourseQualityLabManifest;
  reviews: Record<string, PairReview>;
  onOpenPair: (sectionId: string, pairId: string) => void;
}) {
  const rows = manifest.sections.flatMap((section) => section.pairs.map((pair) => ({ section, pair })));
  const decided = rows.filter(({ pair }) => (reviews[pair.id]?.outcome ?? "undecided") !== "undecided").length;
  const enhancedWins = rows.filter(({ pair }) => reviews[pair.id]?.outcome === "enhanced").length;
  const baselineWins = rows.filter(({ pair }) => reviews[pair.id]?.outcome === "baseline").length;
  return (
    <main className="summary-view">
      <section className="summary-hero">
        <div>
          <span className="eyebrow">评判汇总</span>
          <h1>{decided} / {rows.length} 组已评判</h1>
          <p>这里只汇总你的记录，不自动给出采用结论。</p>
        </div>
        <div className="summary-counts">
          <div><b>{enhancedWins}</b><span>本次优化胜出</span></div>
          <div><b>{baselineWins}</b><span>基线胜出</span></div>
          <div><b>{rows.length - decided}</b><span>待判断</span></div>
        </div>
      </section>
      <div className="summary-table-wrap">
        <table className="summary-table">
          <thead><tr><th>小节</th><th>批次</th><th>当前基线成本/稳定性</th><th>本次优化成本/稳定性</th><th>结论</th><th>已评分维度</th><th>备注</th><th /></tr></thead>
          <tbody>
            {rows.map(({ section, pair }) => {
              const review = reviews[pair.id] ?? emptyReview(pair.id);
              const outcome = OUTCOMES.find((item) => item.value === review.outcome)?.label;
              const notes = Object.values(review.pageNotes).filter(Boolean).length + (review.overallNote?.trim() ? 1 : 0);
              return (
                <tr key={pair.id}>
                  <td><b>{section.title}</b><small>{[section.scenario, section.subject, section.grade].filter(Boolean).join(" · ")}</small></td>
                  <td>第 {pair.batch} 次</td>
                  <td><SummaryMetric result={pair.variants.baseline} /></td>
                  <td><SummaryMetric result={pair.variants.enhanced} /></td>
                  <td><span className={`outcome outcome--${review.outcome}`}>{outcome}</span></td>
                  <td>{Object.keys(review.dimensions).length} / {DIMENSIONS.length}</td>
                  <td>{notes} 条</td>
                  <td><button className="text-button" type="button" onClick={() => onOpenPair(section.id, pair.id)}>打开对比</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="export-actions">
        <a className="secondary-button" href="/api/exports/reviews.json" download>导出 JSON</a>
        <a className="secondary-button" href="/api/exports/reviews.csv" download>导出 CSV</a>
      </div>
    </main>
  );
}

function App() {
  const [manifest, setManifest] = useState<CourseQualityLabManifest>();
  const [reviews, setReviews] = useState<Record<string, PairReview>>({});
  const [loadError, setLoadError] = useState<string>();
  const [sectionId, setSectionId] = useState("");
  const [pairId, setPairId] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [enlarged, setEnlarged] = useState<LabVariantKey | null>(null);
  const [view, setView] = useState<View>("compare");
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const saveTimers = useRef<Record<string, number>>({});
  const saveSequences = useRef<Record<string, number>>({});
  const pendingReviews = useRef<Record<string, PairReview>>({});
  const reviewsRef = useRef<Record<string, PairReview>>({});
  const audioElements = useRef<Partial<Record<LabVariantKey, HTMLAudioElement | null>>>({});

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/manifest", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`清单加载失败（${response.status}）`);
        return response.json() as Promise<CourseQualityLabManifest>;
      }),
      fetch("/api/reviews", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`评判记录加载失败（${response.status}）`);
        return response.json() as Promise<ReviewCollection | PairReview[] | Record<string, PairReview>>;
      }),
    ]).then(([nextManifest, reviewPayload]) => {
      const nextReviews = normalizeReviews(reviewPayload);
      setManifest(nextManifest);
      setReviews(nextReviews);
      reviewsRef.current = nextReviews;
      const firstSection = nextManifest.sections[0];
      setSectionId(firstSection?.id ?? "");
      setPairId(defaultPair(firstSection)?.id ?? "");
    }).catch((error: unknown) => {
      if ((error as Error).name !== "AbortError") setLoadError(error instanceof Error ? error.message : "测试数据加载失败");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    Object.values(saveTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    const flushReviews = () => {
      Object.values(pendingReviews.current).forEach((pendingReview) => {
        void fetch(`/api/reviews/${encodeURIComponent(pendingReview.pairId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pendingReview),
          keepalive: true,
        });
      });
    };
    window.addEventListener("pagehide", flushReviews);
    return () => window.removeEventListener("pagehide", flushReviews);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetch("/api/manifest", { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<CourseQualityLabManifest> : undefined)
        .then((nextManifest) => {
          if (nextManifest) setManifest(nextManifest);
        })
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const section = manifest?.sections.find((item) => item.id === sectionId) ?? manifest?.sections[0];
  const pair = section?.pairs.find((item) => item.id === pairId) ?? defaultPair(section);
  const maxPages = pair ? Math.max(...VARIANTS.map((variant) => pair.variants[variant].slides.length), 1) : 1;
  const review = pair ? reviews[pair.id] ?? emptyReview(pair.id) : undefined;

  const registerAudio = useCallback((variant: LabVariantKey, audio: HTMLAudioElement | null) => {
    audioElements.current[variant] = audio;
  }, []);
  const exclusivePlay = useCallback((variant: LabVariantKey) => {
    VARIANTS.forEach((key) => {
      if (key !== variant) audioElements.current[key]?.pause();
    });
  }, []);

  const queueReviewSave = useCallback((nextReview: PairReview) => {
    const id = nextReview.pairId;
    pendingReviews.current[id] = nextReview;
    window.clearTimeout(saveTimers.current[id]);
    const sequence = (saveSequences.current[id] ?? 0) + 1;
    saveSequences.current[id] = sequence;
    setSaveStates((current) => ({ ...current, [id]: "pending" }));
    saveTimers.current[id] = window.setTimeout(() => {
      setSaveStates((current) => ({ ...current, [id]: "saving" }));
      void fetch(`/api/reviews/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextReview),
      }).then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        if (saveSequences.current[id] === sequence) {
          delete pendingReviews.current[id];
          setSaveStates((current) => ({ ...current, [id]: "saved" }));
        }
      }).catch(() => {
        if (saveSequences.current[id] === sequence) {
          setSaveStates((current) => ({ ...current, [id]: "error" }));
        }
      });
    }, 650);
  }, []);

  const updateReview = useCallback((updater: (review: PairReview) => PairReview) => {
    if (!pair) return;
    const next = { ...updater(reviewsRef.current[pair.id] ?? emptyReview(pair.id)), updatedAt: new Date().toISOString() };
    reviewsRef.current = { ...reviewsRef.current, [pair.id]: next };
    setReviews((current) => ({ ...current, [pair.id]: next }));
    queueReviewSave(next);
  }, [pair, queueReviewSave]);

  const openPair = (nextSectionId: string, nextPairId: string) => {
    setSectionId(nextSectionId);
    setPairId(nextPairId);
    setPageIndex(0);
    setEnlarged(null);
    setView("compare");
  };

  if (loadError) {
    return (
      <main className="state-page">
        <span className="eyebrow">课程质量实验室</span>
        <h1>暂时无法载入实验</h1>
        <p>{loadError}</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }
  if (!manifest) return <main className="state-page"><div className="loader" /><p>正在载入实验结果…</p></main>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">CQ</span>
          <div><b>{manifest.title ?? "课程质量实验室"}</b><small>独立对比评判</small></div>
        </div>
        <nav className="view-tabs" aria-label="页面视图">
          <button className={view === "compare" ? "active" : ""} type="button" onClick={() => setView("compare")}>对比评判</button>
          <button className={view === "summary" ? "active" : ""} type="button" onClick={() => setView("summary")}>汇总</button>
        </nav>
        <span className="manifest-time">数据更新 {manifest.generatedAt ? new Date(manifest.generatedAt).toLocaleString("zh-CN") : "—"}</span>
      </header>

      {view === "summary" ? <Summary manifest={manifest} reviews={reviews} onOpenPair={openPair} /> : pair && section && review ? (
        <main className="compare-view">
          <section className="experiment-toolbar">
            <label>
              <span>小节</span>
              <select value={section.id} onChange={(event) => {
                const nextSection = manifest.sections.find((item) => item.id === event.target.value);
                setSectionId(event.target.value);
                setPairId(defaultPair(nextSection)?.id ?? "");
                setPageIndex(0);
                setEnlarged(null);
              }}>
                {Array.from(new Set(manifest.sections.map((item) => item.scenario ?? "其他场景"))).map((scenario) => (
                  <optgroup label={scenario} key={scenario}>
                    {manifest.sections.filter((item) => (item.scenario ?? "其他场景") === scenario).map((item) => (
                      <option value={item.id} key={item.id}>{item.title}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span>生成批次</span>
              <select value={pair.id} onChange={(event) => {
                setPairId(event.target.value);
                setPageIndex(0);
                setEnlarged(null);
              }}>
                {section.pairs.map((item) => {
                  const versions = [resultPipelineVersion(item.variants.baseline), resultPipelineVersion(item.variants.enhanced)].filter(Boolean).join(" vs ");
                  return <option value={item.id} key={item.id}>第 {item.batch} 次{item.label ? ` · ${item.label}` : ""}{versions ? ` · ${versions}` : ""}</option>;
                })}
              </select>
            </label>
            <div className="section-context">
              <b>{section.scenario ?? section.subject ?? "课程"}</b>
              <span>{[section.subject, section.grade, "相同输入 · 相同模型 · 相同时间预算"].filter(Boolean).join(" · ")}</span>
            </div>
          </section>

          <ReferencePanel section={section} />

          <section className="page-navigation" aria-label="同步翻页">
            <button className="quiet-button" type="button" disabled={pageIndex <= 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>上一页</button>
            <div>
              <b>同步查看第 {pageIndex + 1} 页</b>
              <div className="page-dots">
                {Array.from({ length: maxPages }, (_, index) => (
                  <button
                    aria-label={`查看第 ${index + 1} 页`}
                    aria-current={pageIndex === index ? "page" : undefined}
                    className={pageIndex === index ? "active" : ""}
                    type="button"
                    key={index}
                    onClick={() => setPageIndex(index)}
                  />
                ))}
              </div>
            </div>
            <button className="quiet-button" type="button" disabled={pageIndex >= maxPages - 1} onClick={() => setPageIndex((current) => Math.min(maxPages - 1, current + 1))}>下一页</button>
          </section>

          <section className={`comparison-grid ${enlarged ? "comparison-grid--enlarged" : ""}`}>
            {VARIANTS.map((variant) => (
              <VariantPane
                key={`${pair.id}-${variant}`}
                pair={pair}
                variant={variant}
                pageIndex={pageIndex}
                enlarged={enlarged}
                onToggleEnlarged={(key) => setEnlarged((current) => current === key ? null : key)}
                registerAudio={registerAudio}
                onExclusivePlay={exclusivePlay}
                onSlideChange={(index) => setPageIndex(Math.min(maxPages - 1, Math.max(0, index)))}
              />
            ))}
          </section>

          <TeacherReviewPanel
            pair={pair}
            pageIndex={pageIndex}
            review={review}
            saveState={saveStates[pair.id] ?? "idle"}
            onChange={updateReview}
          />

          <ReviewPanel
            pageIndex={pageIndex}
            review={review}
            saveState={saveStates[pair.id] ?? "idle"}
            onChange={updateReview}
          />
        </main>
      ) : (
        <main className="state-page"><h1>当前没有可评判的实验批次</h1><p>生成第一组结果后刷新此页面。</p></main>
      )}
    </div>
  );
}

const rootElement = document.getElementById("course-quality-lab-root");
if (!rootElement) throw new Error("Missing #course-quality-lab-root mount element");
createRoot(rootElement).render(<App />);
